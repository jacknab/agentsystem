import React, { useState, useEffect, useRef, useCallback } from "react";
import { io, Socket } from "socket.io-client";
import { motion, AnimatePresence } from "motion/react";
import { Device, Call } from "@twilio/voice-sdk";

// --- Types ---
interface User {
  id: string;
  name: string;
  role: 'agent' | 'admin';
}

interface CallState {
  callSid: string;
  status: "IDLE" | "INBOUND" | "QUEUED" | "HOLD" | "BRIEFING" | "ACTIVE" | "TRANSFER" | "WRAP" | "LOOKUP";
  assignedAgent: string | null;
  customerName: string;
  queueName: string;
  holdStartTime?: number;
  fromAgent?: string;
  toAgent?: string;
}

const STATES = {
  IDLE: { label: 'IDLE', msg: 'No active call. Waiting for next inbound.', color: 'sv-IDLE' },
  INBOUND: { label: 'INBOUND CALL', msg: 'Call incoming — account lookup in progress...', color: 'sv-INBOUND' },
  QUEUED: { label: 'QUEUED', msg: 'Customer is waiting in the main queue.', color: 'sv-QUEUED' },
  LOOKUP: { label: 'LOOKING UP...', msg: 'Pulling account data from CRM via Twilio webhook.', color: 'sv-LOOKUP' },
  ACTIVE: { label: 'CALL ACTIVE', msg: 'Agent connected. Follow script. Log any actions.', color: 'sv-ACTIVE' },
  HOLD: { label: 'ON HOLD', msg: 'Customer is on hold with music.', color: 'sv-HOLD' },
  BRIEFING: { label: 'BRIEFING', msg: 'Internal briefing phase for warm transfer.', color: 'sv-TRANSFER' },
  TRANSFER: { label: 'TRANSFERRING', msg: 'Call being transferred to Tier 2 support.', color: 'sv-TRANSFER' },
  WRAP: { label: 'WRAP-UP', msg: 'Call ended. Complete notes and disposition within 3 min.', color: 'sv-WRAP' },
};

const SCRIPTS = {
  IDLE: { read: '', guide: '' },
  INBOUND: {
    read: 'Thank you for calling <strong>Certxa Support</strong>. My name is [AGENT NAME]. I can see your account is loading — may I please confirm your name while I pull that up?',
    guide: 'Wait for Twilio webhook to populate account panel. <em>DO NOT</em> mention any account details until verified. Confirm name + last 4 digits of phone number.'
  },
  QUEUED: {
    read: '',
    guide: 'Customer is in queue. Press accept or type ACCEPT to take the call.'
  },
  ACTIVE: {
    read: 'Thank you for confirming. How can I help you today?',
    guide: 'Account is verified. Listen to issue, then press B for Billing queries, T for Tech support, G for General, or 1/2/3 for common options on the right.'
  },
  HOLD: {
    read: '',
    guide: 'Customer is on hold. Press RESUME to reconnect.'
  },
  BRIEFING: {
    read: '',
    guide: 'TRANSFER BRIEFING: Explain the case to the target agent. Customer cannot hear you.'
  },
  TRANSFER: {
    read: 'I\'m going to connect you with our specialist team who can best assist with this. Please hold for just a moment — they\'ll have your account details already loaded.',
    guide: 'Initiate transfer in phone system. Add transfer notes in wrap-up field. <em>Stay on line</em> until Tier 2 picks up. Do not abandon the call.'
  },
  WRAP: {
    read: '',
    guide: '<em>WRAP-UP CHECKLIST:</em> 1. Select disposition code. 2. Log ticket summary. 3. Set follow-up date if needed. 4. Submit within 3 minutes to avoid penalty flag.'
  },
};

const MOCK_CUSTOMER = {
  name: 'Nguyen Tran',
  phone: '+1 (720) 555-0192',
  tier: 'VIP',
  businessName: 'Pearl Nails & Spa',
  businessType: 'Nail Salon',
  location: 'Denver, CO 80202',
  contactEmail: 'nguyen@pearlnails.com',
  accountId: 'ACC-002847',
  since: 'Mar 2022',
  csm: 'Maria L.',
  nps: '9',
  ltv: '$3,420',
};

const MOCK_BILLING = {
  plan: 'Booking System Pro',
  amount: '$49 / mo',
  nextBill: 'May 1, 2026',
  lastPayment: 'Apr 1, 2026',
  lastAmount: '$49.00',
  status: 'Current',
  method: 'Visa ···4821',
  openBalance: '$0.00',
  discount: 'None',
};

const MOCK_SERVICES = [
  { name: 'Booking System Pro', plan: 'PRO', status: 'Active' },
  { name: 'SMS Reminders', plan: 'ADD-ON', status: 'Active' },
  { name: 'Staff Scheduling', plan: 'BASIC', status: 'Paused' },
];

const MOCK_TICKETS = [
  { id: 'TK-9921', subj: 'SMS not sending to new number', date: 'Apr 22', status: 'open' },
  { id: 'TK-9801', subj: 'Invoice request for Q1 2026', date: 'Apr 10', status: 'closed' },
  { id: 'TK-9744', subj: 'Staff login not working', date: 'Mar 29', status: 'closed' },
  { id: 'TK-9600', subj: 'Change billing email address', date: 'Mar 11', status: 'closed' },
];

const STATE_OPTIONS = {
  ACTIVE: [
    { key: '1', label: 'Billing Question' },
    { key: '2', label: 'Technical Issue' },
    { key: '3', label: 'Account Change' },
  ],
  IDLE: [],
  INBOUND: [],
  LOOKUP: [],
  TRANSFER: [],
  WRAP: [
    { key: '1', label: 'Resolved — No Follow-Up' },
    { key: '2', label: 'Escalated to Tier 2' },
    { key: '3', label: 'Follow-Up Scheduled' },
  ],
};

const HOTKEYS = [
  { key: '00', label: 'Phone Menu' },
  { key: 'A', label: 'Accept' },
  { key: 'W', label: 'Wrap-up' },
  { key: 'T', label: 'Takeover' },
  { key: 'ESC', label: 'Reset' },
];

function Notify({ msg, type, onDone }: { msg: string; type: string; onDone: () => void }) {
  useEffect(() => { const t = setTimeout(onDone, 2200); return () => clearTimeout(t); }, [onDone]);
  return <div className={`notify ${type}`}>{msg}</div>;
}

export default function App() {
  const [user, setUser] = useState<User | null>(() => {
    const saved = localStorage.getItem('agent_session');
    return saved ? JSON.parse(saved) : null;
  });
  const AGENT_ID = user?.id || 'GUEST';

  const [socket, setSocket] = useState<Socket | null>(null);
  const [calls, setCalls] = useState<CallState[]>([]);
  const [mode, setMode] = useState<'AGENT' | 'ADMIN' | 'MONITOR'>('AGENT');
  const [agents, setAgents] = useState<any[]>([]);
  const [logs, setLogs] = useState<any[]>([]);
  const [dbScripts, setDbScripts] = useState<Record<string, { read: string; guide: string }>>({});
  const [editingScript, setEditingScript] = useState<string | null>(null);
  const [editingAgent, setEditingAgent] = useState<any | null>(null);
  const [editForm, setEditForm] = useState<{ read: string; guide: string; options: { key: string; label: string }[] }>({ read: '', guide: '', options: [] });
  const [agentForm, setAgentForm] = useState({ name: '', pin: '', loginCode: '' });
  const [activeCallSid, setActiveCallSid] = useState<string | null>(null);
  const [cmd, setCmd] = useState('');
  const [menuMode, setMenuMode] = useState<'MAIN' | 'PHONE'>('MAIN');
  const [isAccepting, setIsAccepting] = useState(false);
  const [agentStatus, setAgentStatus] = useState<'available' | 'busy' | 'dnd'>('busy');
  const [isRingingTimedOut, setIsRingingTimedOut] = useState(false);

  const [device, setDevice] = useState<Device | null>(null);
  const [twilioCall, setTwilioCall] = useState<Call | null>(null);

  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!user) return;

    let activeDevice: Device | null = null;

    const initTwilio = async () => {
      try {
        const res = await fetch(`/api/auth/token?identity=${user.id}`);
        if (!res.ok) {
          const errData = await res.json().catch(() => ({ error: 'Unknown server error' }));
          showNotify(`TOKEN ERROR: ${errData.error || res.statusText}`, 'err');
          return;
        }
        const { token } = await res.json();
        
        if (!token) {
          showNotify('ERROR: Received empty token from server', 'err');
          return;
        }

        // Check for WebRTC support
        if (!window.isSecureContext) {
          showNotify('VOIP ERROR: Insecure context. HTTPS is required.', 'err');
        }
        
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
          showNotify('VOIP ERROR: Microphone access not supported or blocked.', 'err');
        }

        const newDevice = new Device(token, {
          logLevel: 'debug',
          codecPreferences: [Call.Codec.Opus, Call.Codec.PCMU],
          // Removing explicit edge to let Twilio auto-discover best path
        });

        activeDevice = newDevice;

        // Auto-register
        await newDevice.register();

        newDevice.on('registered', () => {
          showNotify('COMM-LINK ESTABLISHED', 'ok');
          console.log('[VOIP] Device registered successfully');
        });

        newDevice.on('registering', () => {
          console.log('[VOIP] Registering device...');
        });

        newDevice.on('unregistered', () => {
          showNotify('COMM-LINK LOST', 'warn');
          // Try to get a fresh token and re-register
          setTimeout(async () => {
            if (activeDevice && activeDevice.state === 'unregistered') {
              console.log('[VOIP] Fetching fresh token for recovery...');
              try {
                const res = await fetch(`/api/auth/token?identity=${userId}`);
                const { token } = await res.json();
                await activeDevice.updateToken(token);
                await activeDevice.register();
              } catch (e) {
                console.error('[VOIP] Token refresh failed', e);
              }
            }
          }, 5000);
        });

        newDevice.on('error', (error) => {
          console.error('Twilio Device Error:', error);
          let userMsg = `VOIP ERROR (${error.code}): ${error.message}`;
          
          // Map common Twilio error codes to helpful messages
          if (error.code === 31000) userMsg = 'VOIP ERROR: Identity taken or connection failed';
          if (error.code === 31005) userMsg = 'VOIP ERROR: Connection to Twilio timed out';
          if (error.code === 31201) userMsg = 'VOIP ERROR: Invalid token credentials';
          if (error.code === 31202) {
            userMsg = 'CRITICAL: JWT Signature Validation Failed. Verify Twilio API Secret.';
            showNotify('SECURITY ERROR: JWT Signature Validation Failed. Check Secret Key.', 'error');
          }
          if (error.code === 31208) userMsg = 'VOIP ERROR: Token expired';
          if (error.code === 53000) userMsg = 'VOIP ERROR: Signaling connection failed (check Secret/Firewall)';
          
          if (error.code === 31202) {
            showNotify(userMsg, 'error');
          } else {
            showNotify(userMsg, 'warn');
          }
        });

        newDevice.on('incoming', (call) => {
          showNotify('INCOMING VOIP CONNECTION', 'warn');
          setTwilioCall(call);
          
          call.on('disconnect', () => {
            setTwilioCall(null);
            showNotify('VOIP CALL DISCONNECTED', 'info');
          });
        });

        setDevice(newDevice);
      } catch (err) {
        console.error('Twilio Init failed:', err);
        showNotify(`INIT ERROR: ${err instanceof Error ? err.message : 'Internal failed'}`, 'err');
      }
    };

    initTwilio();
    
    return () => {
      if (activeDevice) {
        activeDevice.destroy();
        activeDevice = null;
      }
    };
  }, [user?.id]);

  useEffect(() => {
    fetch("/api/agent/status", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agentId: AGENT_ID, status: agentStatus })
    }).catch(err => console.error("Sync failed:", err));
  }, [agentStatus]);

  const fetchAdminData = useCallback(async () => {
    try {
      const [agentsRes, logsRes] = await Promise.all([
        fetch("/api/admin/agents"),
        fetch("/api/admin/logs")
      ]);
      setAgents(await agentsRes.json());
      setLogs(await logsRes.json());
      
      // Also fetch scripts for building the flow editor
      const scriptsRes = await fetch("/api/admin/scripts");
      if (scriptsRes.ok) setDbScripts(await scriptsRes.json());
    } catch (err) {
      console.error(err);
    }
  }, []);

  useEffect(() => {
    if (mode === 'ADMIN') fetchAdminData();
  }, [mode, fetchAdminData]);
  const [notify, setNotify] = useState<{ id: number; msg: string; type: string } | null>(null);

  const activeCall = calls.find(c => c.callSid === activeCallSid) || calls.find(c => c.assignedAgent === AGENT_ID);
  const inboundCall = user && calls.find(c => 
    (c.status === 'INBOUND' || c.status === 'QUEUED') && 
    (c.assignedAgent === AGENT_ID || !c.assignedAgent)
  );

  // Auto-dismiss popup after 20 seconds
  useEffect(() => {
    if (inboundCall) {
      setIsRingingTimedOut(false);
      const timer = setTimeout(() => {
        setIsRingingTimedOut(true);
      }, 20000);
      return () => clearTimeout(timer);
    } else {
      setIsRingingTimedOut(false);
    }
  }, [inboundCall?.callSid]);

  const isAgentOnActiveCall = activeCall && ['ACTIVE', 'HOLD', 'TRANSFER', 'BRIEFING'].includes(activeCall.status);

  const queuedCount = calls.filter(c => c.status === 'INBOUND' || c.status === 'QUEUED').length;

  const showNotify = useCallback((msg: string, type = 'info') => {
    setNotify({ msg, type, id: Date.now() });
  }, []);

  const triggerWebhook = useCallback((webhook: string) => {
    const transitions: Record<string, () => void> = {
      inbound: () => { 
        fetch("/twilio/inbound", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ 
            CallSid: `CA${Math.random().toString(36).substring(7)}`, 
            From: "+1555" + Math.random().toString().slice(2, 6) 
          })
        });
      },
      answer: () => {
        const myInbound = calls.find(c => (c.status === "INBOUND" || c.status === "QUEUED") && (c.assignedAgent === AGENT_ID || !c.assignedAgent));
        if (myInbound) {
          fetch("/api/call/assign", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ callSid: myInbound.callSid, agentId: AGENT_ID })
          });
        }
      },
      wrap: () => {
        if (activeCallSid) {
          fetch("/api/call/end", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ callSid: activeCallSid })
          });
        }
      }
    };
    if (transitions[webhook]) transitions[webhook]();
  }, [calls, activeCallSid]);

  useEffect(() => {
    const newSocket = io();
    setSocket(newSocket);

    newSocket.on("initial_state", (data: { calls: CallState[] }) => {
      setCalls(data.calls);
    });

    newSocket.on("call.inbound", (call: CallState) => {
      setCalls(prev => [...prev, call]);
      if (call.assignedAgent === AGENT_ID) {
        setAgentStatus('busy');
      }
      showNotify(`TWILIO WH: call.inbound received`, 'warn');
    });

    newSocket.on("call.queued", (call: CallState) => {
      setCalls(prev => {
        const index = prev.findIndex(c => c.callSid === call.callSid);
        if (index === -1) return [...prev, call];
        return prev.map(c => c.callSid === call.callSid ? call : c);
      });
      showNotify(`Call queued in main pool`, 'info');
    });

    newSocket.on("call.assigned", (call: CallState) => {
      setCalls(prev => {
        const index = prev.findIndex(c => c.callSid === call.callSid);
        if (index === -1) return [...prev, call];
        return prev.map(c => c.callSid === call.callSid ? call : c);
      });
      if (call.assignedAgent === AGENT_ID) {
        setIsAccepting(false); 
        // We don't set activeCallSid here anymore to let the Answer popup show
        // and only set it when the agent accepts the call.
        showNotify(`SIGNAL RECEIVED: ${call.customerName}`, 'warn');
      }
    });

    newSocket.on("call.hold_started", (call: CallState) => {
      setCalls(prev => prev.map(c => c.callSid === call.callSid ? call : c));
      showNotify(`WH: call.hold — Music playing`, 'warn');
    });

    newSocket.on("call.briefing_started", (data: CallState & { fromAgent: string; toAgent: string }) => {
      setCalls(prev => prev.map(c => c.callSid === data.callSid ? data : c));
      if (data.toAgent === AGENT_ID) {
        showNotify(`WH: briefing_started from ${data.fromAgent}`, 'warn');
      }
    });

    newSocket.on("call.transferred", (call: CallState) => {
      setCalls(prev => prev.map(c => c.callSid === call.callSid ? call : c));
      if (call.assignedAgent === AGENT_ID) {
        setActiveCallSid(call.callSid);
        showNotify(`Transfer complete. You are now ACTIVE.`, 'ok');
      }
    });

    newSocket.on("call.ended", (call: CallState) => {
      setCalls(prev => prev.map(c => c.callSid === call.callSid ? call : c));
      showNotify(`WH: call.ended — wrap-up mode`, 'info');
    });

    newSocket.on("agent.missed", (data: { agentId: string, callSid: string }) => {
      if (data.agentId === AGENT_ID) {
        setAgentStatus('dnd');
        showNotify('CALL MISSED: SET TO DND', 'warn');
        setActiveCallSid(null);
      }
    });

    return () => { newSocket.close(); };
  }, [showNotify, AGENT_ID]);

  const execCmd = useCallback((raw: string) => {
    const input = raw.trim().toUpperCase();
    if (!input) return;

    // --- Authentication Commands ---
    if (input === "LOGIN") {
      showNotify("LOGIN_REQUIRED: USE 'LOGIN <7-DIGIT-CODE>'", "warn");
      setCmd("");
      return;
    }

    if (input.startsWith("LOGIN ")) {
      const parts = input.split(" ");
      const code = parts[1];
      if (!code || code.length !== 7) {
        showNotify("INVALID_COMMAND: USE LOGIN <7-DIGIT-CODE>", "err");
        setCmd("");
        return;
      }

      fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code })
      })
      .then(res => res.json())
      .then(data => {
        if (data.success) {
          setUser(data.user);
          localStorage.setItem('agent_session', JSON.stringify(data.user));
          showNotify(`ACCESS_GRANTED: WELCOME ${data.user.name.toUpperCase()}`, 'ok');
          setCmd("");
        } else {
          showNotify(`AUTH_FAILURE: ${data.message.toUpperCase()}`, 'err');
          setCmd("");
        }
      })
      .catch(() => {
        showNotify("NETWORK_ERROR: CANNOT REACH AUTH_SERVER", "err");
        setCmd("");
      });
      return;
    }

    // Global Mode Switches - Allow even if not logged in so user can see admin/monitor screens
    if (input === "HELP") {
      showNotify("AUTH_REQUIRED: TYPE 'LOGIN <7-DIGIT-CODE>' TO START SESSION", "info");
      setCmd("");
      return;
    }

    if (input === "ADMIN") {
      setMode('ADMIN');
      showNotify('ADMIN OVERRIDE: Agent Management Active', 'warn');
      setCmd('');
      return;
    }
    if (input === "MONITOR") {
      setMode('MONITOR');
      showNotify('QA MONITOR: Multi-session Awareness Active', 'info');
      setCmd('');
      return;
    }
    if (input === "AGENT") {
      setMode('AGENT');
      showNotify('RETURNING TO AGENT TERMINAL', 'ok');
      setCmd('');
      return;
    }

    if (input === "SIGNOFF" || input === "LOGOUT" || input === "EXIT") {
      if (!user) {
        showNotify("SYSTEM_ALREADY_LOCKED", "info");
      } else {
        const userId = user.id;
        logout();
        showNotify(`SESSION_TERMINATED: ${userId} SIGNED OFF`, "warn");
      }
      setCmd("");
      return;
    }

    // Block all other commands if not logged in
    if (!user) {
      showNotify("AUTH_REQUIRED: TYPE 'LOGIN <CODE>'", "err");
      setCmd("");
      return;
    }

    // "Back" Logic
    if (input === "0" || input === "B" || input === "BACK") {
      if (menuMode === 'PHONE') {
        setMenuMode('MAIN');
        showNotify('Main Menu restored', 'info');
      } else {
        showNotify('Already in root menu', 'neutral');
      }
      setCmd('');
      return;
    }

    if (input === "00") {
      setMenuMode('PHONE');
      showNotify('PHONE_SUBMENU ACTIVATED (H/R/X/B/T)', 'info');
      setCmd('');
      return;
    }

    if (input === "READY" || (input === "R" && menuMode === 'MAIN')) {
      setAgentStatus('available');
      showNotify('AGENT STATUS: READY', 'ok');
      setCmd('');
      return;
    }
    if (input === "DND") {
      setAgentStatus('dnd');
      showNotify('AGENT STATUS: DND (Busy)', 'warn');
      setCmd('');
      return;
    }

    if (mode === 'ADMIN') {
      if (input.startsWith("CREATE ")) {
        const parts = input.split(" ");
        // CREATE [id] [name...] [pin] [code]
        if (parts.length >= 5) {
          const id = parts[1];
          const loginCode = parts[parts.length - 1];
          const pin = parts[parts.length - 2];
          const name = parts.slice(2, -2).join(" ");
          fetch("/api/admin/agents", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ id, name, pin, loginCode })
          }).then(() => {
            showNotify(`AGENT ${id} CREATED`, 'ok');
            fetchAdminData();
          });
        }
      } else if (input === "SAVE" && editingScript) {
        fetch("/api/admin/scripts", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ state: editingScript, ...editForm })
        }).then(() => {
          showNotify(`SCRIPT ${editingScript} UPDATED`, 'ok');
          setEditingScript(null);
          fetchAdminData();
        });
      }
      setCmd('');
      return;
    }

    if (mode === 'MONITOR') {
      if (input.startsWith("JOIN ")) {
        const sid = input.split(" ")[1];
        fetch("/twilio/monitor", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ callSid: sid, managerId: AGENT_ID })
        }).then(() => {
          showNotify(`SILENT MONITORING JOINED: ${sid}`, 'warn');
          setActiveCallSid(sid);
          setMode('AGENT'); // View the session as an agent
        });
      }
      setCmd('');
      return;
    }

    if (menuMode === 'PHONE') {
      if (input === "H" || input === "HOLD") {
        if (activeCallSid) fetch("/twilio/hold", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ callSid: activeCallSid }) });
      } else if (input === "R" || input === "RESUME") {
        if (activeCallSid) fetch("/twilio/resume", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ callSid: activeCallSid }) });
      } else if (input === "X" || input === "TRANSFER") {
        if (activeCallSid) fetch("/twilio/transfer/initiate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ callSid: activeCallSid, fromAgent: AGENT_ID, toAgent: "agent-002" }) });
      } else if (input === "Y" || input === "READY") {
        if (!device || device.state !== 'registered') {
          showNotify('COMM-LINK ERROR: Check Twilio API Secret (Error 31202)', 'error');
          console.warn('[VOIP] Cannot set READY - Device state:', device?.state);
        } else {
          setAgentStatus('available');
          showNotify('AGENT STATUS: READY', 'ok');
        }
      } else if (input === "B" || input === "BILLING") {
        showNotify('Switching to Billing Script', 'warn');
      } else if (input === "T" || input === "TECH") {
        showNotify('Switching to Tech Support Script', 'info');
      }
      setMenuMode('MAIN');
    } else {
      if (input === "A" || input === "ACCEPT") {
        setIsAccepting(true);
        // Immediately move the call out of INBOUND state locally to hide the box instantly
        if (inboundCall) {
          setActiveCallSid(inboundCall.callSid);
          setCalls(prev => prev.map(c => c.callSid === inboundCall.callSid ? { ...c, status: 'ACTIVE' } : c));
        }

        // Accept WebRTC audio if pending
        if (twilioCall) {
          twilioCall.accept();
        }

        // Safety timeout to reset accepting state if socket update fails
        setTimeout(() => setIsAccepting(false), 5000);
        triggerWebhook('answer');
      } else if (input === "W" || input === "WRAP") {
        if (twilioCall) {
          twilioCall.disconnect();
        }
        triggerWebhook('wrap');
        // W key now clears data as requested
        setCalls([]); 
        setActiveCallSid(null);
        showNotify('CALL WRAPPED: Screen cleared', 'success');
      } else if (input === "T" || input === "TAKEOVER") {
        const briefingCall = calls.find(c => c.status === "BRIEFING" && c.toAgent === AGENT_ID);
        if (briefingCall) {
          fetch("/twilio/transfer/complete", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ callSid: briefingCall.callSid, toAgent: AGENT_ID }) });
        }
      } else if (input === "ESC" || input === "ESCAPE") {
        // ESC is now "safe" - only resets the menu, doesn't clear call data
        setMenuMode('MAIN');
        showNotify('NAV_RESET', 'info');
      } else if (input === "RESET" || input === "CLEAR") {
        // Manual full wipe command
        setCalls([]);
        setActiveCallSid(null);
        setMenuMode('MAIN');
        showNotify('SYSTEM_WIPE: Buffers purged', 'warn');
      } else {
        showNotify(`Unknown command: ${input}`, 'err');
      }
    }
    setCmd('');
    // Ensure focus returns to input after any command
    setTimeout(() => inputRef.current?.focus(), 10);
  }, [triggerWebhook, activeCallSid, calls, showNotify, menuMode, mode, fetchAdminData]);

  const [isFocused, setIsFocused] = useState(true);
  const [showSim, setShowSim] = useState(false);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    const refocus = () => {
      // Small delay prevents focus-stealing from preventing legitimate interactions
      setTimeout(() => {
        if (document.activeElement?.tagName !== 'INPUT' && document.activeElement?.tagName !== 'BUTTON') {
          inputRef.current?.focus();
        }
      }, 50);
    };
    window.addEventListener('click', refocus);
    return () => window.removeEventListener('click', refocus);
  }, []);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // 1. If already typing in an input, ONLY handle Escape to blur
      if (e.target instanceof HTMLInputElement) {
        if (e.key === 'Escape') {
          inputRef.current?.blur();
          execCmd('ESC');
        }
        return;
      }
      
      const key = e.key.toUpperCase();

      // Simulation toggle (Backtick)
      if (e.key === '`') { 
        e.preventDefault();
        setShowSim(prev => !prev); 
        return; 
      }
      
      // 2. Handle Enter to focus the command bar
      if (e.key === 'Enter') {
        e.preventDefault();
        inputRef.current?.focus();
        return;
      }

      // 3. Handle specific global hotkeys ONLY when not focused
      const isHotkey = ['A', 'H', 'P', 'R', 'X', 'T', 'W', 'B', '0'].includes(key) || key === 'ESCAPE';
      
      if (isHotkey) {
        e.preventDefault();
        if (key === 'A') execCmd('A');
        if (key === 'H' || key === 'P') execCmd('H');
        if (key === 'R') execCmd('R');
        if (key === 'X') execCmd('X');
        if (key === 'T') execCmd('T');
        if (key === 'W') execCmd('W');
        if (key === 'B') execCmd('B');
        if (key === '0') execCmd('00');
        if (key === 'ESCAPE') execCmd('ESC');
      } else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
        // If it's a regular character and we're not using it as a hotkey, 
        // just focus the input and let the browser naturally type it in.
        inputRef.current?.focus();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [execCmd]);

  const callState = activeCall?.status || (user ? 'IDLE' : 'LOCKED');
  const sc = user ? (STATES[callState as keyof typeof STATES] || STATES.IDLE) : { label: 'AGENT_SIGNON', msg: 'SYSTEM_LOCKED: TYPE LOGIN <7-DIGIT-ACCESS-CODE> TO START SESSION.', color: 'sv-WRAP' };
  const effectiveScripts = { ...SCRIPTS, ...dbScripts };
  const script = effectiveScripts[callState as keyof typeof effectiveScripts] || effectiveScripts.IDLE;
  
  const phoneOptions = [
    { key: 'H', label: 'Hold Call' },
    { key: 'R', label: 'Resume Call' },
    { key: 'X', label: 'Transfer Call' },
    { key: 'Y', label: 'Ready for Work' },
    { key: 'B', label: 'Billing Dept' },
    { key: 'T', label: 'Tech Dept' },
  ];

  const dbOpts = (script as any).options || [];
  const hardcodedOpts = STATE_OPTIONS[callState as keyof typeof STATE_OPTIONS] || [];
  const opts = menuMode === 'PHONE' ? phoneOptions : (dbOpts.length > 0 ? dbOpts : hardcodedOpts);

  const logout = () => {
    localStorage.removeItem('agent_session');
    setUser(null);
    setAgents([]);
    setCalls([]);
    setActiveCallSid(null);
    if (device) {
      device.destroy();
      setDevice(null);
    }
    setTwilioCall(null);
  };

  return (
    <div className="terminal font-mono">
      <AnimatePresence>
        {notify && (
          <motion.div
            key={notify.id}
            initial={{ opacity: 0, y: -20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
          >
            <Notify msg={notify.msg} type={notify.type} onDone={() => setNotify(null)} />
          </motion.div>
        )}
      </AnimatePresence>

      <div className="topbar">
        <div className="topbar-logo">CERTXA <span> {mode}</span> TERMINAL v2.0</div>
        <div className="topbar-center">
          <div className={`call-pill ${['ACTIVE', 'TRANSFER', 'HOLD', 'BRIEFING'].includes(callState) ? 'active' : ['INBOUND', 'LOOKUP', 'QUEUED'].includes(callState) ? 'ringing' : ''}`}>
            <div className={`dot ${['ACTIVE', 'TRANSFER', 'HOLD', 'BRIEFING'].includes(callState) ? 'active' : ['INBOUND', 'LOOKUP', 'QUEUED'].includes(callState) ? 'ringing' : ''}`}></div>
            {sc.label}
          </div>
        </div>
        <div className="topbar-right">
          <div className="queue-counter">
            <span className="queue-label">QUEUED:</span>
            <span className={`queue-val ${queuedCount > 0 ? 'ringing' : ''}`}>{queuedCount}</span>
          </div>
          <div className="flex items-center gap-2 px-3 border-x border-[#333]">
            <span className="text-[10px] text-gray-500">STATUS:</span>
            <span className={`text-[10px] font-bold ${agentStatus === 'available' ? 'text-green-500' : 'text-red-500'}`}>
              {(user ? agentStatus : 'LOCKED').toUpperCase()}
            </span>
          </div>
          <span className="agent-tag" onClick={logout} style={{ cursor: 'pointer' }} title="Click to Logout">{user ? `${mode}: ${AGENT_ID}` : 'UNAUTHORIZED'}</span>
          {new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false })} ICT
        </div>
      </div>

      <div className="main">
        {user && inboundCall && !isAccepting && !isAgentOnActiveCall && !isRingingTimedOut && (
          <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 pointer-events-none">
            <div className="bg-white text-black p-8 border-[12px] border-double border-black animate-pulse flex flex-col items-center">
              <div className="text-sm font-bold tracking-[0.3em] mb-2">SIGNAL_DETECTED</div>
              <div className="text-6xl font-black mb-4">ACCEPT [A]</div>
              <div className="text-[10px] opacity-50">PRESS A TO ANSWER SESSION</div>
            </div>
          </div>
        )}

        {mode === 'ADMIN' ? (
          <div className="admin-view p-6 bg-black text-white overflow-auto w-full h-full">
            <div className="flex justify-between items-end mb-4 border-b-2 border-[#4f8ef7] pb-2">
              <h2 className="text-xl font-bold">SYSTEM CONTROL & SCRIPT MANAGER</h2>
              <div className="text-[10px] text-gray-500 uppercase tracking-widest">PERSISTENCE: FIREBASE_PENDING</div>
            </div>
            <div className="grid grid-cols-12 gap-6">
              {/* Agents Panel */}
              <div className="col-span-4 panel bg-[#111] border border-[#333] p-4 h-[500px] flex flex-col">
                <h3 className="text-sm font-bold mb-3 border-b border-[#222] pb-2 text-[#888]">IDENTITY MANAGEMENT</h3>
                <div className="overflow-auto flex-1 mb-4">
                  {agents.map(a => (
                    <div key={a.id} className="flex justify-between items-center py-2 border-b border-[#1a1a1a] text-xs">
                      <div className="flex flex-col">
                        <span className={a.id === AGENT_ID ? 'text-green-500' : 'text-white'}>{a.name} ({a.id})</span>
                        <span className="text-gray-600 text-[10px]">PIN: {a.pin} | CODE: {a.login_code || 'N/A'}</span>
                      </div>
                      <div className="flex gap-2">
                        <button 
                          onClick={() => {
                            setEditingAgent(a);
                            setAgentForm({ name: a.name, pin: a.pin, loginCode: a.login_code || '' });
                          }} 
                          className="text-[#4f8ef7] hover:underline"
                        >EDIT</button>
                        <button 
                          onClick={() => {
                            if (confirm(`Delete agent ${a.id}?`)) {
                              fetch(`/api/admin/agents/${a.id}`, { method: 'DELETE' }).then(() => {
                                showNotify(`AGENT ${a.id} REMOVED`, 'warn');
                                fetchAdminData();
                              });
                            }
                          }} 
                          className="text-red-500 hover:underline"
                        >DEL</button>
                      </div>
                    </div>
                  ))}
                  {agents.length === 0 && <div className="text-gray-600 italic py-4">No agents found. Use CREATE [id] [name] [pin]</div>}
                </div>

                {editingAgent ? (
                  <div className="p-3 bg-black border border-[#4f8ef7] mb-2 rounded animate-in fade-in zoom-in-95">
                    <div className="text-[9px] font-bold text-[#4f8ef7] mb-2 uppercase tracking-widest">EDIT AGENT: {editingAgent.id}</div>
                    <div className="space-y-2">
                      <input 
                        className="w-full bg-[#111] border border-[#333] text-xs p-2 outline-none focus:border-[#4f8ef7]"
                        value={agentForm.name}
                        placeholder="Agent Name"
                        onChange={e => setAgentForm({ ...agentForm, name: e.target.value })}
                      />
                      <input 
                        className="w-full bg-[#111] border border-[#333] text-xs p-2 outline-none focus:border-[#4f8ef7]"
                        value={agentForm.pin}
                        placeholder="PIN"
                        onChange={e => setAgentForm({ ...agentForm, pin: e.target.value })}
                      />
                      <input 
                        className="w-full bg-[#111] border border-[#333] text-xs p-2 outline-none focus:border-[#4f8ef7]"
                        value={agentForm.loginCode}
                        placeholder="7-Digit Login Code"
                        maxLength={7}
                        onChange={e => setAgentForm({ ...agentForm, loginCode: e.target.value })}
                      />
                      <div className="flex gap-2 pt-1">
                        <button 
                          onClick={() => {
                            fetch(`/api/admin/agents/${editingAgent.id}`, {
                              method: 'PUT',
                              headers: { 'Content-Type': 'application/json' },
                              body: JSON.stringify(agentForm)
                            }).then(() => {
                              showNotify(`AGENT ${editingAgent.id} UPDATED`, 'ok');
                              setEditingAgent(null);
                              fetchAdminData();
                            });
                          }}
                          className="flex-1 bg-[#4f8ef7] text-black text-[10px] font-bold py-1"
                        >SAVE</button>
                        <button 
                          onClick={() => setEditingAgent(null)}
                          className="flex-1 bg-[#222] text-white text-[10px] py-1"
                        >CANCEL</button>
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="text-[9px] text-[#4f8ef7] p-2 bg-black border border-[#222] font-mono leading-relaxed">
                    CMD: CREATE [ID] [NAME] [PIN] [CODE]<br />
                    Ex: CREATE agent-10 Jack 1234 1112223
                  </div>
                )}
              </div>

              {/* Script Editor Panel */}
              <div className="col-span-5 panel bg-[#111] border border-[#333] p-4 h-[500px] flex flex-col">
                <h3 className="text-sm font-bold mb-3 border-b border-[#222] pb-2 text-[#888]">FLOW & SCRIPT EDITOR</h3>
                <div className="flex-1 overflow-auto">
                  {Object.keys(effectiveScripts).map(state => (
                    <div 
                      key={state} 
                      onClick={() => {
                        const scriptData = effectiveScripts[state as keyof typeof effectiveScripts];
                        setEditingScript(state);
                        setEditForm({
                          read: scriptData?.read || '',
                          guide: scriptData?.guide || '',
                          options: (scriptData as any)?.options || []
                        });
                      }}
                      className={`p-2 mb-2 border cursor-pointer transition-all ${editingScript === state ? 'border-[#4f8ef7] bg-[#001a4a]' : 'border-[#222] hover:border-[#444] bg-black'}`}
                    >
                      <div className="flex justify-between items-center mb-1">
                        <span className="text-xs font-bold font-mono">{state}</span>
                        <span className="text-[8px] text-gray-600">DYNAMIC_TAG: [CUSTOMER NAME]</span>
                      </div>
                      <div className="text-[10px] truncate text-gray-400">{effectiveScripts[state as keyof typeof effectiveScripts]?.read}</div>
                    </div>
                  ))}
                </div>
                
                {editingScript && (
                  <div className="mt-4 p-3 bg-black border border-[#4f8ef7] rounded animate-in fade-in slide-in-from-bottom-2 overflow-y-auto max-h-[300px]">
                    <div className="text-[10px] font-bold text-[#4f8ef7] mb-2 uppercase">Editing: {editingScript}</div>
                    <div className="text-[8px] text-gray-500 mb-1 uppercase font-bold">Read Script</div>
                    <textarea 
                      className="w-full bg-[#111] border border-[#333] text-xs p-2 mb-2 h-20 outline-none focus:border-[#4f8ef7]"
                      placeholder="Customer Read text..."
                      value={editForm.read}
                      onChange={e => setEditForm({ ...editForm, read: e.target.value })}
                    />
                    <div className="text-[8px] text-gray-500 mb-1 uppercase font-bold">Internal Guide</div>
                    <textarea 
                      className="w-full bg-[#111] border border-[#333] text-xs p-2 mb-3 h-16 outline-none focus:border-[#4f8ef7]"
                      placeholder="Internal Agent Guide..."
                      value={editForm.guide}
                      onChange={e => setEditForm({ ...editForm, guide: e.target.value })}
                    />
                    
                    <div className="text-[8px] text-gray-500 mb-1 uppercase font-bold">Flow Buttons (Key:Label)</div>
                    <div className="space-y-1 mb-4">
                      {editForm.options.map((opt, idx) => (
                        <div key={idx} className="flex gap-1">
                          <input 
                            className="w-12 bg-[#111] border border-[#333] text-[10px] p-1"
                            value={opt.key}
                            onChange={e => {
                              const newOpts = [...editForm.options];
                              newOpts[idx].key = e.target.value;
                              setEditForm({ ...editForm, options: newOpts });
                            }}
                          />
                          <input 
                            className="flex-1 bg-[#111] border border-[#333] text-[10px] p-1"
                            value={opt.label}
                            onChange={e => {
                              const newOpts = [...editForm.options];
                              newOpts[idx].label = e.target.value;
                              setEditForm({ ...editForm, options: newOpts });
                            }}
                          />
                          <button 
                            onClick={() => {
                              const newOpts = editForm.options.filter((_, i) => i !== idx);
                              setEditForm({ ...editForm, options: newOpts });
                            }}
                            className="text-red-500 text-[10px] px-1"
                          >×</button>
                        </div>
                      ))}
                      <button 
                        onClick={() => setEditForm({ ...editForm, options: [...editForm.options, { key: '', label: '' }] })}
                        className="text-[9px] text-blue-400 border border-blue-900 border-dashed w-full py-1 hover:bg-blue-900/20"
                      >
                        + ADD BUTTON
                      </button>
                    </div>

                    <div className="flex gap-2">
                      <button onClick={() => execCmd('SAVE')} className="bg-[#4f8ef7] text-black text-[10px] px-4 py-1 font-bold">SAVE_CHANGES</button>
                      <button onClick={() => setEditingScript(null)} className="bg-[#222] text-white text-[10px] px-4 py-1">CANCEL</button>
                    </div>
                  </div>
                )}
              </div>

              {/* Enhanced Logs Panel */}
              <div className="col-span-3 panel bg-[#111] border border-[#333] p-4 h-[500px] flex flex-col">
                <h3 className="text-sm font-bold mb-3 border-b border-[#222] pb-2 text-[#888]">TELEMETRY & LOGS</h3>
                <div className="flex-1 overflow-auto text-[9px] font-mono space-y-2">
                  {logs.map(l => (
                    <div key={l.id} className="border-l-2 border-[#333] pl-2 pb-1 hover:border-[#4f8ef7] transition-colors">
                      <div className="flex justify-between text-gray-500">
                        <span>{new Date(l.timestamp).toLocaleTimeString()}</span>
                        {l.status === 'MISSED' && <span className="text-red-500 font-bold">MISSED</span>}
                      </div>
                      <div className="text-white">
                        <span className="text-[#f0a030]">{l.agentId || 'SYS'}</span>: {l.action}
                      </div>
                      {l.callSid && <div className="text-gray-600 truncate">{l.callSid}</div>}
                    </div>
                  ))}
                  {logs.length === 0 && <div className="text-gray-600 italic">Listening for system events...</div>}
                </div>
              </div>
            </div>
          </div>
        ) : mode === 'MONITOR' ? (
          <div className="monitor-view p-6 bg-black text-white overflow-auto w-full h-full">
            <h2 className="text-xl font-bold mb-4 text-[#4f8ef7]">QA REAL-TIME MONITOR</h2>
            <div className="grid grid-cols-3 gap-4">
              {calls.filter(c => c.status !== 'IDLE').map(c => (
                <div key={c.callSid} className="panel bg-[#111] border border-[#333] p-3">
                  <div className="flex justify-between items-center mb-2">
                    <span className="text-xs font-bold">{c.customerName}</span>
                    <span className={`badge b-${c.status.toLowerCase()}`}>{c.status}</span>
                  </div>
                  <div className="text-[10px] text-gray-400 mb-2">
                    Agent Assignment: <span className="text-[#4f8ef7]">{c.assignedAgent || 'WAITING...'}</span>
                  </div>
                  <button 
                    onClick={() => execCmd(`JOIN ${c.callSid}`)}
                    className="w-full bg-[#000] border border-[#333] hover:border-[#4f8ef7] text-[10px] py-1 transition-colors"
                  >
                    SILENT MONITOR SESSION
                  </button>
                </div>
              ))}
              {calls.filter(c => c.status !== 'IDLE').length === 0 && (
                <div className="col-span-3 text-center py-20 text-gray-600 border border-dashed border-[#333]">
                  NO ACTIVE CALL SESSIONS DETECTED
                </div>
              )}
            </div>
          </div>
        ) : (
          <div className="main contents">
            <div className="left">
          <div className="script-area">
            <div className="script-pane">
              <div className="pane-label">READ TO CUSTOMER <span className="pane-label-tag">SCRIPT</span></div>
              {script.read ? (
                <div 
                  className="script-read" 
                  style={{ height: '19.5px', fontSize: '16px', fontWeight: 'bold', fontFamily: 'Verdana, sans-serif', lineHeight: '17.5px', fontStyle: 'italic' }}
                  dangerouslySetInnerHTML={{ __html: script.read.replace("[CUSTOMER NAME]", activeCall?.customerName || "Customer").replace("[AGENT NAME]", AGENT_ID) }} 
                />
              ) : (
                <div 
                  className="script-empty"
                  style={{ height: '19.5px', fontSize: '16px', fontWeight: 'bold', fontFamily: 'Verdana, sans-serif', lineHeight: '17.5px', fontStyle: 'italic' }}
                >
                  {callState === 'IDLE' ? 'Waiting for inbound call...' : 'No read script for this state.'}
                </div>
              )}
            </div>
            <div className="script-pane">
              <div className="pane-label">AGENT GUIDE <span className="pane-label-tag guide">INTERNAL</span></div>
              {script.guide ? (
                <div className="script-guide" dangerouslySetInnerHTML={{ __html: script.guide }} />
              ) : (
                <div className="script-empty">No guidance for this state.</div>
              )}
            </div>
          </div>

          <div className="data-scroll">
            <div className="data-grid">
              <div className="panel">
                <div className="panel-hdr">
                  <span className="panel-title">◈ CUSTOMER</span>
                  {activeCall ? <span className="badge b-vip">{MOCK_CUSTOMER.tier}</span> : <span className="badge b-neutral">NO DATA</span>}
                </div>
                {activeCall ? (
                  <div>
                    <div className="kv"><span className="kv-k">Name</span><span className="kv-v hi">{activeCall.customerName}</span></div>
                    <div className="kv"><span className="kv-k">Phone</span><span className="kv-v mono">{MOCK_CUSTOMER.phone}</span></div>
                    <div className="kv"><span className="kv-k">Email</span><span className="kv-v mono">{MOCK_CUSTOMER.contactEmail}</span></div>
                    <div className="kv"><span className="kv-k">Business</span><span className="kv-v">{MOCK_CUSTOMER.businessName}</span></div>
                    <div className="kv"><span className="kv-k">Type</span><span className="kv-v">{MOCK_CUSTOMER.businessType}</span></div>
                    <div className="kv"><span className="kv-k">Location</span><span className="kv-v">{MOCK_CUSTOMER.location}</span></div>
                  </div>
                ) : <div className="h-4 border-b border-dashed border-[#334155] opacity-20 mt-1"></div>}
              </div>

              <div className="panel no-right">
                <div className="panel-hdr">
                  <span className="panel-title">◈ ACCOUNT</span>
                  {activeCall ? <span className="badge b-active">ACTIVE</span> : null}
                </div>
                {activeCall ? (
                  <div>
                    <div className="kv"><span className="kv-k">Account ID</span><span className="kv-v mono">{MOCK_CUSTOMER.accountId}</span></div>
                    <div className="kv"><span className="kv-k">Customer Since</span><span className="kv-v">{MOCK_CUSTOMER.since}</span></div>
                    <div className="kv"><span className="kv-k">Success Mgr</span><span className="kv-v">{MOCK_CUSTOMER.csm}</span></div>
                    <div className="kv"><span className="kv-k">NPS Score</span><span className="kv-v ok">{MOCK_CUSTOMER.nps} / 10</span></div>
                    <div className="kv"><span className="kv-k">LTV</span><span className="kv-v hi">{MOCK_CUSTOMER.ltv}</span></div>
                  </div>
                ) : <div className="h-4 border-b border-dashed border-[#334155] opacity-20 mt-1"></div>}
              </div>

              <div className="panel">
                <div className="panel-hdr">
                  <span className="panel-title">◈ BILLING</span>
                  {activeCall ? <span className="badge b-ok">{MOCK_BILLING.status}</span> : null}
                </div>
                {activeCall ? (
                  <div>
                    <div className="kv"><span className="kv-k">Plan</span><span className="kv-v hi">{MOCK_BILLING.plan}</span></div>
                    <div className="kv"><span className="kv-k">Amount</span><span className="kv-v">{MOCK_BILLING.amount}</span></div>
                    <div className="kv"><span className="kv-k">Next Bill</span><span className="kv-v">{MOCK_BILLING.nextBill}</span></div>
                    <div className="kv"><span className="kv-k">Last Paid</span><span className="kv-v ok">{MOCK_BILLING.lastPayment}  {MOCK_BILLING.lastAmount}</span></div>
                    <div className="kv"><span className="kv-k">Method</span><span className="kv-v mono">{MOCK_BILLING.method}</span></div>
                    <div className="kv"><span className="kv-k">Balance</span><span className="kv-v ok">{MOCK_BILLING.openBalance}</span></div>
                  </div>
                ) : <div className="h-4 border-b border-dashed border-[#334155] opacity-20 mt-1"></div>}
              </div>

              <div className="panel no-right">
                <div className="panel-hdr">
                  <span className="panel-title">◈ SERVICES</span>
                </div>
                {activeCall ? (
                  MOCK_SERVICES.map((s, i) => (
                    <div className="svc-row" key={i}>
                      <span className="svc-name">{s.name}</span>
                      <div className="flex gap-1 items-center">
                        <span className="svc-plan">{s.plan}</span>
                        <span className={`badge ${s.status === 'Active' ? 'b-ok' : 'b-warn'}`}>{s.status}</span>
                      </div>
                    </div>
                  ))
                ) : <div className="h-4 border-b border-dashed border-[#334155] opacity-20 mt-1"></div>}
              </div>

              <div className="panel full">
                <div className="panel-hdr">
                  <span className="panel-title">◈ RECENT TICKETS</span>
                  {activeCall ? <span className="badge b-info">{MOCK_TICKETS.length} RECORDS</span> : null}
                </div>
                {activeCall ? (
                  MOCK_TICKETS.map((t, i) => (
                    <div className="ticket" key={i} onClick={() => showNotify('Ticket ' + t.id + ': ' + t.subj, 'info')}>
                      <span className="t-id">{t.id}</span>
                      <span className="t-subj">{t.subj}</span>
                      <span className={`badge ${t.status === 'open' ? 'b-open' : 'b-neutral'}`}>{t.status}</span>
                      <span className="t-date">{t.date}</span>
                    </div>
                  ))
                ) : <div className="h-4 border-b border-dashed border-[#334155] opacity-20 mt-1"></div>}
              </div>
            </div>
          </div>
        </div>

        <div className="right-panel">
          <div className="state-box">
            <div className="state-label">CALL STATE</div>
            <div className={`state-val ${sc.color}`}>{sc.label}</div>
            <div className="state-msg">{sc.msg}</div>
          </div>
          <div className="options-box">
            <div className="opt-label">OPTIONS</div>
            {opts.length > 0 ? (
              opts.map((o, idx) => (
                <button className="opt-btn" key={idx} onClick={() => execCmd(o.key)}>
                  <span className="opt-key">[{o.key}]</span>
                  <span className="opt-text">{o.label}</span>
                </button>
              ))
            ) : callState === 'QUEUED' ? (
              <button className="opt-btn" onClick={() => execCmd('A')}>
                <span className="opt-key">[A]</span>
                <span className="opt-text">Accept Call</span>
              </button>
            ) : callState === 'BRIEFING' && activeCall?.toAgent === AGENT_ID ? (
              <button className="opt-btn" onClick={() => execCmd('T')}>
                <span className="opt-key">[T]</span>
                <span className="opt-text">Takeover Call</span>
              </button>
            ) : (
              <div className="text-[#aab0c0] italic text-[10px]">No valid options for state.</div>
            )}
          </div>
          <div className="hotkey-box">
            <div className="hk-label">HOTKEYS</div>
            <div className="hk-grid">
              {HOTKEYS.map((h, idx) => (
                <div className="hk" key={idx}>
                  <span className="hk-key">{h.key}</span>
                  <span>{h.label}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    )}
    </div>

      {showSim && (
        <div className="webhook-bar">
          <button onClick={() => triggerWebhook('inbound')} className="wh-btn wh-inbound">INBOUND</button>
          <button onClick={() => triggerWebhook('answer')} className="wh-btn wh-answer">ANSWER</button>
          <button onClick={() => execCmd('ESC')} className="wh-btn wh-cancel">RESET</button>
          <button onClick={() => execCmd('00')} className="wh-btn wh-billing">PHONE MENU</button>
          <button onClick={() => execCmd('AGENT')} className="wh-btn wh-tech">TO AGENT</button>
          <button onClick={() => execCmd('ADMIN')} className="wh-btn wh-wrap">TO ADMIN</button>
          <button onClick={() => execCmd('MONITOR')} className="wh-btn wh-reset">TO MONITOR</button>
          <div className="wh-label">
            PBX SIMULATOR CONTROL V1.3 · {mode} MODE
          </div>
        </div>
      )}

      <div className="cmd-bar">
        <span className="cmd-prompt">{">_"}</span>
        <div className="input-container">
          <input
            ref={inputRef}
            autoFocus
            className="cmd-input"
            value={cmd}
            onChange={e => setCmd(e.target.value)}
            onFocus={() => setIsFocused(true)}
            onBlur={() => setIsFocused(false)}
            onKeyDown={e => { 
              if (e.key === 'Enter') { e.preventDefault(); execCmd(cmd); } 
              if (e.key === 'Escape') { e.preventDefault(); execCmd('ESC'); } 
            }}
            placeholder=""
            autoComplete="off"
            spellCheck={false}
          />
          <div 
            className="cursor-block" 
            style={{ 
              left: `calc(${cmd.length}ch + 0px)`,
              display: isFocused ? 'block' : 'none'
            }}
          />
        </div>
        <span className="cmd-help">AGENT TERMINAL · CERTXA SaaS</span>
      </div>
    </div>
  );
}
