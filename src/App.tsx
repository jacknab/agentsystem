import React, { useState, useEffect, useRef, useCallback } from "react";
import { io, Socket } from "socket.io-client";
import { motion, AnimatePresence } from "motion/react";

// --- Types ---
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

const AGENT_ID = "agent-001"; // Simulated current agent

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
    read: 'Thank you for confirming, <strong>[CUSTOMER NAME]</strong>. How can I help you today?',
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
  const [socket, setSocket] = useState<Socket | null>(null);
  const [calls, setCalls] = useState<CallState[]>([]);
  const [mode, setMode] = useState<'AGENT' | 'ADMIN' | 'MONITOR'>('AGENT');
  const [agents, setAgents] = useState<any[]>([]);
  const [logs, setLogs] = useState<any[]>([]);
  const [activeCallSid, setActiveCallSid] = useState<string | null>(null);
  const [cmd, setCmd] = useState('');
  const [menuMode, setMenuMode] = useState<'MAIN' | 'PHONE'>('MAIN');

  const fetchAdminData = useCallback(async () => {
    try {
      const [agentsRes, logsRes] = await Promise.all([
        fetch("/api/admin/agents"),
        fetch("/api/admin/logs")
      ]);
      setAgents(await agentsRes.json());
      setLogs(await logsRes.json());
    } catch (err) {
      console.error(err);
    }
  }, []);

  useEffect(() => {
    if (mode === 'ADMIN') fetchAdminData();
  }, [mode, fetchAdminData]);
  const [notify, setNotify] = useState<{ id: number; msg: string; type: string } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const activeCall = calls.find(c => c.callSid === activeCallSid) || calls.find(c => c.assignedAgent === AGENT_ID);

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
        const pendingCall = calls.find(c => c.status === "QUEUED");
        if (pendingCall) {
          fetch("/api/call/assign", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ callSid: pendingCall.callSid, agentId: AGENT_ID })
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
      showNotify(`TWILIO WH: call.inbound received`, 'warn');
    });

    newSocket.on("call.queued", (call: CallState) => {
      setCalls(prev => prev.map(c => c.callSid === call.callSid ? call : c));
      showNotify(`Call queued in main pool`, 'info');
    });

    newSocket.on("call.assigned", (call: CallState) => {
      setCalls(prev => prev.map(c => c.callSid === call.callSid ? call : c));
      if (call.assignedAgent === AGENT_ID) {
        setActiveCallSid(call.callSid);
        showNotify(`Account loaded: ${call.customerName}`, 'ok');
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

    return () => { newSocket.close(); };
  }, [showNotify]);

  const execCmd = useCallback((raw: string) => {
    const input = raw.trim().toUpperCase();
    if (!input) return;

    // Global Mode Switches
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

    if (mode === 'ADMIN') {
      if (input.startsWith("CREATE ")) {
        const parts = input.split(" ");
        if (parts.length >= 4) {
          const id = parts[1];
          const pin = parts[parts.length - 1];
          const name = parts.slice(2, -1).join(" ");
          fetch("/api/admin/agents", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ id, name, pin })
          }).then(() => {
            showNotify(`AGENT ${id} CREATED`, 'ok');
            fetchAdminData();
          });
        }
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
      } else if (input === "B" || input === "BILLING") {
        showNotify('Switching to Billing Script', 'warn');
      } else if (input === "T" || input === "TECH") {
        showNotify('Switching to Tech Support Script', 'info');
      }
      setMenuMode('MAIN');
    } else {
      if (input === "A" || input === "ACCEPT") {
        triggerWebhook('answer');
      } else if (input === "W" || input === "WRAP") {
        triggerWebhook('wrap');
      } else if (input === "T" || input === "TAKEOVER") {
        const briefingCall = calls.find(c => c.status === "BRIEFING" && c.toAgent === AGENT_ID);
        if (briefingCall) {
          fetch("/twilio/transfer/complete", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ callSid: briefingCall.callSid, toAgent: AGENT_ID }) });
        }
      } else if (input === "ESC" || input === "ESCAPE") {
        setMenuMode('MAIN');
        setActiveCallSid(null);
        showNotify('Reset to default view', 'info');
      } else {
        showNotify(`Unknown command: ${input}`, 'err');
      }
    }
    setCmd('');
  }, [triggerWebhook, activeCallSid, calls, showNotify, menuMode, mode, fetchAdminData]);

  const [isFocused, setIsFocused] = useState(true);
  const [showSim, setShowSim] = useState(false);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // If we are typing in the input, don't trigger global hotkeys unless it's ESC
      if (e.target instanceof HTMLInputElement) {
        if (e.key === 'Escape') {
          inputRef.current?.blur();
          execCmd('ESC');
        }
        return;
      }
      
      const key = e.key.toUpperCase();
      
      // Simulation toggle
      if (e.key === '`') { 
        setShowSim(prev => !prev); 
        return; 
      }

      // Global hotkeys
      if (key === 'A') execCmd('A');
      if (key === 'H') execCmd('H');
      if (key === 'P') execCmd('H'); // P for phone/hold is also common
      if (key === 'R') execCmd('R');
      if (key === 'X') execCmd('X');
      if (key === 'T') execCmd('T');
      if (key === 'W') execCmd('W');
      if (key === 'B') execCmd('B');
      if (key === '0') execCmd('00');
      if (key === 'ESCAPE') execCmd('ESC');
      
      if (e.key === 'Enter') {
        inputRef.current?.focus();
        e.preventDefault();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [execCmd, menuMode]);

  const callState = activeCall?.status || 'IDLE';
  const sc = STATES[callState as keyof typeof STATES] || STATES.IDLE;
  const script = SCRIPTS[callState as keyof typeof SCRIPTS] || SCRIPTS.IDLE;
  
  const phoneOptions = [
    { key: 'H', label: 'Hold Call' },
    { key: 'R', label: 'Resume Call' },
    { key: 'X', label: 'Transfer Call' },
    { key: 'B', label: 'Billing Dept' },
    { key: 'T', label: 'Tech Dept' },
  ];

  const opts = menuMode === 'PHONE' ? phoneOptions : (STATE_OPTIONS[callState as keyof typeof STATE_OPTIONS] || []);

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
          <span className="agent-tag">{mode}: {AGENT_ID} · HCM-01</span>
          {new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false })} ICT
        </div>
      </div>

      <div className="main">
        {mode === 'ADMIN' ? (
          <div className="admin-view p-6 bg-black text-white overflow-auto w-full h-full">
            <h2 className="text-xl font-bold mb-4 text-[#4f8ef7]">AGENT MANAGEMENT SYSTEM</h2>
            <div className="grid grid-cols-2 gap-6">
              <div className="panel bg-[#111] border border-[#333] p-4 h-96">
                <h3 className="text-sm font-bold mb-3 border-b border-[#222] pb-2 text-[#888]">ACTIVE AGENTS</h3>
                <div className="overflow-auto h-[300px]">
                  {agents.map(a => (
                    <div key={a.id} className="flex justify-between py-2 border-b border-[#1a1a1a] text-xs">
                      <span>{a.name} ({a.id})</span>
                      <span className="text-[#4f8ef7]">PIN: {a.pin}</span>
                    </div>
                  ))}
                  {agents.length === 0 && <div className="text-gray-600 italic py-4">No agents found in database.</div>}
                </div>
                <div className="mt-4 text-[10px] text-gray-500 bg-[#000] p-2 border border-[#333]">
                  Command Format: CREATE [id] [name] [pin]
                </div>
              </div>
              <div className="panel bg-[#111] border border-[#333] p-4 h-96">
                <h3 className="text-sm font-bold mb-3 border-b border-[#222] pb-2 text-[#888]">COMPLIANCE LOGS</h3>
                <div className="h-[300px] overflow-auto text-[10px] space-y-1">
                  {logs.map(l => (
                    <div key={l.id} className="border-b border-[#1a1a1a] pb-1">
                      <span className="text-gray-500">[{new Date(l.timestamp).toLocaleTimeString()}]</span>
                      <span className="text-[#f0a030] ml-2 font-bold">{l.agentId}</span>
                      <span className="ml-2">{l.action}</span>
                      {l.callSid && <span className="text-gray-600 ml-2">({l.callSid})</span>}
                    </div>
                  ))}
                  {logs.length === 0 && <div className="text-gray-600 italic">Listening for agent events...</div>}
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
                <div className="script-read" dangerouslySetInnerHTML={{ __html: script.read.replace("[CUSTOMER NAME]", activeCall?.customerName || "Customer").replace("[AGENT NAME]", AGENT_ID) }} />
              ) : (
                <div className="script-empty">{callState === 'IDLE' ? 'Waiting for inbound call...' : 'No read script for this state.'}</div>
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
              opts.map((o, i) => (
                <button className="opt-btn" key={i} onClick={() => execCmd(o.key)}>
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
              {HOTKEYS.map((h, i) => (
                <div className="hk" key={i}>
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
            className="cmd-input"
            value={cmd}
            onChange={e => setCmd(e.target.value)}
            onFocus={() => setIsFocused(true)}
            onBlur={() => setIsFocused(false)}
            onKeyDown={e => { if (e.key === 'Enter') execCmd(cmd); if (e.key === 'Escape') execCmd('ESC'); }}
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
