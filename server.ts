import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import { createServer as createViteServer } from "vite";
import twilio from "twilio";
import dotenv from "dotenv";
import { Database } from "./db.js";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});

const PORT = 3000;

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Twilio Client - Lazy init or handled safely
let twilioClient: any;
try {
  if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN) {
    twilioClient = twilio(
      process.env.TWILIO_ACCOUNT_SID,
      process.env.TWILIO_AUTH_TOKEN
    );
  } else {
    console.warn("[TWILIO] Missing credentials. Twilio features will be disabled.");
  }
} catch (err) {
  console.error("[TWILIO] Initialization error:", err);
}

const db = new Database();

// Types
interface CallState {
  callSid: string;
  status: "IDLE" | "INBOUND" | "QUEUED" | "HOLD" | "BRIEFING" | "ACTIVE" | "TRANSFER" | "WRAP";
  assignedAgent: string | null;
  customerName: string;
  queueName: string;
  conferenceSid?: string;
  holdStartTime?: number;
}

// In-memory active calls (authoritative state)
const activeCalls = new Map<string, CallState>();

// --- Admin & Stats Endpoints ---
app.get("/api/admin/agents", (req, res) => {
  res.json(db.getUsers().filter(u => u.role === 'agent'));
});

app.post("/api/admin/agents", (req, res) => {
  const { id, name, pin, loginCode } = req.body;
  if (!id || !name || !pin || !loginCode) return res.status(400).json({ error: "Missing fields" });
  db.createAgent(id, name, pin, loginCode);
  res.json({ success: true });
});

app.put("/api/admin/agents/:id", (req, res) => {
  const { id } = req.params;
  const { name, pin, loginCode } = req.body;
  db.updateAgent(id, name, pin, loginCode);
  res.json({ success: true });
});

app.delete("/api/admin/agents/:id", (req, res) => {
  db.deleteAgent(req.params.id);
  res.json({ success: true });
});

app.get("/api/admin/logs", (req, res) => {
  res.json(db.getLogs());
});

app.get("/api/admin/stats/:agentId", (req, res) => {
  res.json(db.getAgentStats(req.params.agentId));
});

app.get("/api/admin/scripts", (req, res) => {
  res.json(db.getScripts());
});

app.post("/api/admin/scripts", (req, res) => {
  const { state, read, guide, options } = req.body;
  if (!state) return res.status(400).json({ error: "Missing state ID" });
  db.updateScript(state, read, guide, options || []);
  res.json({ success: true });
});

// --- Silent Join (QA Monitor) & Barge ---
app.post("/twilio/monitor", async (req, res) => {
  const { callSid, managerId } = req.body;
  const call = activeCalls.get(callSid);
  if (!call) return res.status(404).json({ error: "Call not found" });

  try {
    if (!twilioClient) throw new Error("Twilio client not initialized");
    
    let baseUrl = process.env.APP_URL || "";
    if (!baseUrl || baseUrl.includes("-dev-")) {
      const protocol = req.headers['x-forwarded-proto'] || 'https';
      const host = req.headers['host'] || "";
      baseUrl = `${protocol}://${host}`.includes("-dev-") ? `${protocol}://${host}`.replace("-dev-", "-pre-") : `${protocol}://${host}`;
    }

    // Dial the manager/monitor and join them muted
    await twilioClient.calls.create({
      to: `client:${managerId}`,
      from: process.env.TWILIO_PHONE_NUMBER || 'CertxaMonitor',
      url: `${baseUrl}/twilio/agent-join?confName=conf_${callSid}&muted=true`
    });

    db.logAgentAction(managerId, "MONITOR_JOIN", callSid);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

app.post("/twilio/barge", async (req, res) => {
  const { callSid, agentId } = req.body;
  const call = activeCalls.get(callSid);
  if (!call) return res.status(404).json({ error: "Call not found" });

  try {
    if (!twilioClient) throw new Error("Twilio client not initialized");
    
    let baseUrl = process.env.APP_URL || "";
    if (!baseUrl || baseUrl.includes("-dev-")) {
      const protocol = req.headers['x-forwarded-proto'] || 'https';
      const host = req.headers['host'] || "";
      baseUrl = `${protocol}://${host}`.includes("-dev-") ? `${protocol}://${host}`.replace("-dev-", "-pre-") : `${protocol}://${host}`;
    }

    // Dial the agent/manager and join them UNMUTED (Barge)
    await twilioClient.calls.create({
      to: `client:${agentId}`,
      from: process.env.TWILIO_PHONE_NUMBER || 'CertxaBarge',
      url: `${baseUrl}/twilio/agent-join?confName=conf_${callSid}&muted=false`
    });

    db.logAgentAction(agentId, "BARGE_JOIN", callSid);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// Webhooks
app.get("/twilio/test", (req, res) => {
  // Try to get the URL from the configured APP_URL first
  let baseUrl = process.env.APP_URL || "";
  
  // If no APP_URL or it's a dev URL, try to suggest the pre (shared) version
  let recommendedUrl = baseUrl;
  if (baseUrl.includes("-dev-")) {
    recommendedUrl = baseUrl.replace("-dev-", "-pre-");
  } else if (!baseUrl) {
    // Fallback detection if no env var is set
    const host = req.headers['x-forwarded-host'] || req.headers['host'] || "";
    const protocol = req.headers['x-forwarded-proto'] || 'https';
    if (typeof host === 'string' && host.includes("-dev-")) {
      recommendedUrl = `${protocol}://${host.replace("-dev-", "-pre-")}`;
    } else if (typeof host === 'string') {
      recommendedUrl = `${protocol}://${host}`;
    } else {
      recommendedUrl = "https://ais-pre-[YOUR-PROJECT-ID].us-west1.run.app";
    }
  }

  res.send(`
    <html>
      <body style="font-family: sans-serif; padding: 2rem; background: #0f172a; color: #f8fafc; line-height: 1.6;">
        <h1 style="color: #38bdf8; margin-bottom: 0.5rem;">Twilio Webhook Configuration</h1>
        <p style="color: #94a3b8; margin-bottom: 2rem;">Twilio needs a public URL to talk to your app. The "Dev" URL is private to you.</p>
        
        <div style="background: #1e293b; padding: 1.5rem; border-radius: 12px; border: 1px solid #334155; box-shadow: 0 10px 15px -3px rgba(0,0,0,0.1);">
          <h2 style="font-size: 1rem; color: #fbbf24; margin-top: 0;">STEP 1: Copy this Webhook URL</h2>
          <code style="display: block; background: #000; padding: 1.25rem; border-radius: 6px; color: #4ade80; font-size: 1.1rem; border: 1px solid #22c55e; margin: 1rem 0; word-break: break-all;">
            ${recommendedUrl}/twilio/inbound
          </code>
          
          <h2 style="font-size: 1rem; color: #38bdf8; margin-top: 2rem;">STEP 2: Paste in Twilio Console</h2>
          <p>Go to your phone number settings in Twilio and paste the URL above into the <strong>"A CALL COMES IN"</strong> field (Webhook / HTTP POST).</p>
        </div>

        <div style="margin-top: 2rem; padding: 1rem; border-left: 4px solid #ef4444; background: rgba(239, 68, 68, 0.1);">
          <p style="margin: 0;"><strong>Why?</strong> Twilio cannot access <code>ais-dev-...</code> URLs because they are behind a Google Login. You must use the <code>ais-pre-...</code> (Shared) URL.</p>
        </div>
      </body>
    </html>
  `);
});

// --- Auth ---
app.get("/api/auth/token", (req, res) => {
  const identity = req.query.identity as string;
  console.log(`[AUTH] Token requested for identity: ${identity}`);
  
  if (!identity) {
    console.error("[AUTH] Identity missing in request");
    return res.status(400).send("Identity required");
  }

  if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_VOICE_API_KEY || !process.env.TWILIO_VOICE_API_SECRET) {
    console.error("[AUTH] Twilio credentials missing in environment variables");
    return res.status(500).json({ error: "Twilio credentials missing on server" });
  }

  try {
    const AccessToken = twilio.jwt.AccessToken;
    const VoiceGrant = AccessToken.VoiceGrant;

    // Use strict trimming to prevent hidden whitespace/newlines from breaking signatures
    const accountSid = (process.env.TWILIO_ACCOUNT_SID || '').trim();
    const apiKey = (process.env.TWILIO_VOICE_API_KEY || '').trim();
    const apiSecret = (process.env.TWILIO_VOICE_API_SECRET || '').trim();
    const appSid = (process.env.TWILIO_TWIML_APP_SID || '').trim();

    if (!accountSid || !apiKey || !apiSecret) {
      console.error("[AUTH] Missing Credentials: SID:", !!accountSid, "Key:", !!apiKey, "Secret:", !!apiSecret);
      return res.status(500).json({ error: "Twilio credentials missing or incomplete" });
    }

    // Diagnostic check
    if (!accountSid.startsWith('AC')) console.error(`[AUTH] CRITICAL: TWILIO_ACCOUNT_SID is invalid (Must start with AC).`);
    if (!apiKey.startsWith('SK')) console.error(`[AUTH] CRITICAL: TWILIO_VOICE_API_KEY is invalid (Must start with SK).`);
    
    // Safely log fragments to help user verify without exposing full secret
    console.log(`[AUTH] Verifying Credentials:`);
    console.log(` - AccountSid: ${accountSid.substring(0, 5)}...${accountSid.slice(-3)} (Len: ${accountSid.length})`);
    console.log(` - ApiKey SID: ${apiKey.substring(0, 5)}...${apiKey.slice(-3)} (Len: ${apiKey.length})`);
    console.log(` - ApiSecret:  ${apiSecret.substring(0, 3)}...${apiSecret.slice(-3)} (Len: ${apiSecret.length})`);

    const token = new AccessToken(accountSid, apiKey, apiSecret, {
      identity: identity,
      ttl: 3600
    });

    // Explicitly set identity again as some SDK versions are picky
    token.identity = identity;

    const voiceGrant = new VoiceGrant({
      incomingAllow: true,
      outgoingApplicationSid: appSid,
    });

    token.addGrant(voiceGrant);
    const jwt = token.toJwt();
    
    console.log(`[AUTH] Identity: ${identity} | AppSid: ${appSid} | Token Generated via API Key: ${apiKey.substring(0,6)}...`);
    res.json({ token: jwt });
  } catch (err) {
    console.error("[AUTH] Token generation failed:", err);
    res.status(500).json({ error: "Failed to generate access token" });
  }
});

app.post("/api/auth/login", (req, res) => {
  const { code } = req.body;
  const user = db.getAgentByLoginCode(code);

  if (user) {
    res.json({ 
      success: true, 
      user: {
        id: user.id,
        name: user.name,
        role: user.role
      }
    });
  } else {
    res.status(401).json({ success: false, message: "Invalid Access Code" });
  }
});

// --- Agent Status ---
app.post("/api/agent/status", (req, res) => {
  const { agentId, status } = req.body;
  db.updateUserStatus(agentId, status);
  
  // If agent becomes available, check if there's someone in queue
  if (status === 'available') {
    processNextInQueue(agentId);
  }
  
  res.json({ success: true });
});

async function assignCallToAgent(callSid: string, agentId: string) {
  const call = activeCalls.get(callSid);
  if (!call) return;

  call.assignedAgent = agentId;
  call.status = "INBOUND";
  db.assignAgent(callSid, agentId);
  db.updateUserStatus(agentId, 'busy');
  db.updateCallStatus(callSid, "INBOUND");
  
  io.emit("call.assigned", call);

  // Rollover logic: 25s to answer
  setTimeout(() => {
    const currentCall = activeCalls.get(callSid);
    if (currentCall && currentCall.assignedAgent === agentId && currentCall.status === 'INBOUND') {
      console.log(`Call ${callSid} missed by ${agentId}. Rolling over.`);
      
      db.updateUserStatus(agentId, 'dnd'); // Silent the agent
      
      currentCall.assignedAgent = null;
      currentCall.status = "QUEUED";
      db.updateCallStatus(callSid, "QUEUED");
      db.assignAgent(callSid, "");
      
      io.emit("call.queued", currentCall);
      io.emit("agent.missed", { agentId, callSid });

      // Try next available
      const nextAgent = db.getAvailableAgent();
      if (nextAgent) {
        processNextInQueue(nextAgent.id);
      }
    }
  }, 25000);
}

async function processNextInQueue(agentId: string) {
  const nextCall = db.getOldestQueuedCall();
  if (nextCall) {
    assignCallToAgent(nextCall.callSid, agentId);
  }
}

// --- Browser Outbound ---
app.post("/twilio/voice", (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();
  const { To, From, callSid } = req.body;
  
  console.log(`[VOIP] Browser initiated call: To=${To}, From=${From}`);
  
  if (To) {
    // If we're dialing a number or another client
    const dial = twiml.dial({ callerId: process.env.TWILIO_PHONE_NUMBER || From });
    if (To.startsWith('client:')) {
      dial.client(To.replace('client:', ''));
    } else {
      dial.number(To);
    }
  } else {
    twiml.say("Welcome to the Certxa outbound voice service.");
  }
  
  res.type("text/xml");
  res.send(twiml.toString());
});

app.post("/twilio/inbound", (req, res) => {
  try {
    const { CallSid, From } = req.body;
    const twiml = new twilio.twiml.VoiceResponse();

    console.log(`[TWILIO] Incoming call: From=${From}, SID=${CallSid}`);

    if (!CallSid) {
      console.error("[TWILIO] Missing CallSid in request body");
      return res.status(400).send("Missing CallSid");
    }

    // Always start in QUEUED state for a shared queue
    const initialStatus = "QUEUED";
    db.createCall(CallSid, initialStatus, From || "Unknown");

    const state: CallState = {
      callSid: CallSid,
      status: initialStatus,
      assignedAgent: null,
      customerName: From || "Unknown",
      queueName: "Main Queue",
      conferenceSid: undefined
    };
    activeCalls.set(CallSid, state);

    // Determine the status callback URL
    let baseUrl = process.env.APP_URL || "";
    if (!baseUrl || baseUrl.includes("-dev-")) {
      const protocol = req.headers['x-forwarded-proto'] || 'https';
      const host = req.headers['host'] || "";
      let detectedUrl = `${protocol}://${host}`;
      if (detectedUrl.includes("-dev-")) {
        baseUrl = detectedUrl.replace("-dev-", "-pre-");
      } else {
        baseUrl = detectedUrl;
      }
    }
    const statusCallback = `${baseUrl}/twilio/status`;

    // Shared Queue Pattern:
    // Callers enter a conference with startConferenceOnEnter=false.
    // They will hear hold music until an agent joins with startConferenceOnEnter=true.
    const dial = twiml.dial();
    dial.conference({
      waitUrl: process.env.HOLD_MUSIC_URL || "http://twimlets.com/holdmusic?Bucket=com.twilio.music.classical",
      statusCallbackEvent: ["start", "end", "join", "leave"],
      statusCallback: statusCallback,
      startConferenceOnEnter: false, // Wait for agent
      endConferenceOnExit: true,
    }, `conf_${CallSid}`);

    io.emit("call.queued", state);

    console.log(`[TWILIO] TwiML generated for SID=${CallSid} (Shared Queue)`);
    res.type("text/xml");
    res.send(twiml.toString());
  } catch (err) {
    console.error("[TWILIO] Error in /twilio/inbound:", err);
    res.status(500).send("Internal Server Error");
  }
});

app.post("/twilio/status", (req, res) => {
  const { CallSid, ConferenceSid, StatusCallbackEvent, ParticipantSid } = req.body;
  console.log(`Status update: ${StatusCallbackEvent} for ${CallSid} in ${ConferenceSid}`);

  const call = activeCalls.get(CallSid);
  if (call) {
    if (StatusCallbackEvent === "participant-join") {
      // If it's the customer, they are now "QUEUED" in the conference
      if (!call.assignedAgent) {
        call.status = "QUEUED";
        call.conferenceSid = ConferenceSid;
        db.updateCallStatus(CallSid, "QUEUED");
        io.emit("call.queued", call);
      }
    } else if (StatusCallbackEvent === "participant-leave") {
      // Handle cleanup if needed
    } else if (req.body.CallStatus === "completed" || req.body.CallStatus === "canceled") {
      if (call.status === "INBOUND" || call.status === "QUEUED") {
        db.markMissed(CallSid);
      }
      activeCalls.delete(CallSid);
      db.updateCallStatus(CallSid, "ENDED");
      io.emit("call.ended", { callSid: CallSid });
    }
  }

  res.sendStatus(200);
});

// Agent actions
app.post("/api/call/assign", async (req, res) => {
  const { callSid, agentId } = req.body;
  const call = activeCalls.get(callSid);

  if (call) {
    call.assignedAgent = agentId;
    call.status = "ACTIVE";
    db.assignAgent(callSid, agentId);
    db.logAgentAction(agentId, "ANSWER_CALL", callSid);
    
    // In a real app, the agent would join the conference via their browser/sip
    // Here we simulate the agent joining
    io.emit("call.assigned", call);
    res.json({ success: true });
  } else {
    res.status(404).json({ error: "Call not found" });
  }
});

app.post("/api/call/bridge", async (req, res) => {
  const { callSid, agentId } = req.body;
  const call = activeCalls.get(callSid);

  if (!call) return res.status(404).json({ error: "Call not found" });

  try {
    if (!twilioClient) throw new Error("Twilio client not initialized");
    console.log(`[BRIDGE] Connecting agent ${agentId} to conference conf_${callSid}`);

    // Update assignment in state
    call.assignedAgent = agentId;
    call.status = "ACTIVE";
    db.assignAgent(callSid, agentId);
    db.updateCallStatus(callSid, "ACTIVE");
    db.updateUserStatus(agentId, 'busy');

    // Create an outbound call to the Agent's browser/client
    // When the agent answers, they join the conference and the caller's music stops.
    let baseUrl = process.env.APP_URL || "";
    if (!baseUrl || baseUrl.includes("-dev-")) {
      const protocol = req.headers['x-forwarded-proto'] || 'https';
      const host = req.headers['host'] || "";
      baseUrl = `${protocol}://${host}`.includes("-dev-") ? `${protocol}://${host}`.replace("-dev-", "-pre-") : `${protocol}://${host}`;
    }

    await twilioClient.calls.create({
      to: `client:${agentId}`,
      from: process.env.TWILIO_PHONE_NUMBER || 'CertxaPBX',
      url: `${baseUrl}/twilio/agent-join?confName=conf_${callSid}`
    });

    io.emit("call.assigned", call);
    res.json({ success: true });
  } catch (err) {
    console.error("[BRIDGE] Failed:", err);
    res.status(500).json({ error: "Bridge failed" });
  }
});

// Endpoint to provide TwiML for the Agent joining a conference
app.post("/twilio/agent-join", (req, res) => {
  const { confName, muted } = req.query;
  const twiml = new twilio.twiml.VoiceResponse();
  const dial = twiml.dial();
  dial.conference({
    startConferenceOnEnter: true, // Agent joins and starts music/talking
    endConferenceOnExit: true,
    muted: muted === 'true'
  }, confName as string);

  res.type("text/xml");
  res.send(twiml.toString());
});

app.post("/twilio/hold", async (req, res) => {
  const { callSid } = req.body;
  const call = activeCalls.get(callSid);

  if (call && call.conferenceSid) {
    try {
      if (!twilioClient) throw new Error("Twilio client not initialized");
      // Mute the customer and play music (or just mute in conference)
      // For real hold, we might move them to a different conference or use 'hold' attribute if supported
      await twilioClient.conferences(call.conferenceSid)
        .participants(callSid)
        .update({ hold: true, holdUrl: process.env.HOLD_MUSIC_URL || "http://twimlets.com/holdmusic?Bucket=com.twilio.music.classical" });

      call.status = "HOLD";
      call.holdStartTime = Date.now();
      db.updateCallStatus(callSid, "HOLD");
      db.logAgentAction(call.assignedAgent || "unknown", "HOLD_CALL", callSid);
      io.emit("call.hold_started", call);
      res.json({ success: true });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Failed to set hold" });
    }
  } else {
    res.status(404).json({ error: "Call or Conference not found" });
  }
});

app.post("/twilio/resume", async (req, res) => {
  const { callSid } = req.body;
  const call = activeCalls.get(callSid);

  if (call && call.conferenceSid) {
    try {
      if (!twilioClient) throw new Error("Twilio client not initialized");
      await twilioClient.conferences(call.conferenceSid)
        .participants(callSid)
        .update({ hold: false });

      call.status = "ACTIVE";
      call.holdStartTime = undefined;
      db.updateCallStatus(callSid, "ACTIVE");
      db.logAgentAction(call.assignedAgent || "unknown", "RESUME_CALL", callSid);
      io.emit("call.assigned", call); // Resume is basically back to active
      res.json({ success: true });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Failed to resume" });
    }
  } else {
    res.status(404).json({ error: "Call or Conference not found" });
  }
});

// Warm Transfer Logic
app.post("/twilio/transfer/initiate", async (req, res) => {
  const { callSid, fromAgent, toAgent } = req.body;
  const call = activeCalls.get(callSid);

  if (call && call.conferenceSid) {
    try {
      if (!twilioClient) throw new Error("Twilio client not initialized");
      // 1. Put customer on HOLD
      await twilioClient.conferences(call.conferenceSid)
        .participants(callSid)
        .update({ hold: true, holdUrl: process.env.HOLD_MUSIC_URL || "http://twimlets.com/holdmusic?Bucket=com.twilio.music.classical" });

      // 2. Bring Agent B into BRIEFING (simulated via WebSockets / Browser SIP)
      call.status = "BRIEFING";
      db.createTransfer(callSid, fromAgent, toAgent);
      io.emit("call.briefing_started", { ...call, fromAgent, toAgent });

      res.json({ success: true });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Failed to initiate transfer" });
    }
  } else {
    res.status(404).json({ error: "Call not found" });
  }
});

app.post("/twilio/transfer/complete", async (req, res) => {
  const { callSid, toAgent } = req.body;
  const call = activeCalls.get(callSid);

  if (call && call.conferenceSid) {
    try {
      if (!twilioClient) throw new Error("Twilio client not initialized");
      // 3. Reconnect customer to Agent B
      await twilioClient.conferences(call.conferenceSid)
        .participants(callSid)
        .update({ hold: false });

      // 4. Remove Agent A (simulated by updating state)
      call.status = "ACTIVE";
      call.assignedAgent = toAgent;
      db.assignAgent(callSid, toAgent);
      io.emit("call.transferred", call);

      res.json({ success: true });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Failed to complete transfer" });
    }
  } else {
    res.status(404).json({ error: "Call not found" });
  }
});

app.post("/api/call/end", (req, res) => {
  const { callSid } = req.body;
  const call = activeCalls.get(callSid);
  if (call) {
    const agentId = call.assignedAgent;
    call.status = "WRAP";
    db.updateCallStatus(callSid, "WRAP");
    io.emit("call.ended", call);
    
    // In WRAP, the agent is still 'busy' in the DB until they go READY
    
    // Finalize record after 1 minute
    setTimeout(() => {
      activeCalls.delete(callSid);
    }, 60000);
    
    res.json({ success: true });
  } else {
    res.status(404).json({ error: "Call not found" });
  }
});

// Vite Middleware
if (process.env.NODE_ENV !== "production") {
  const vite = await createViteServer({
    server: { middlewareMode: true },
    appType: "spa",
  });
  app.use(vite.middlewares);
} else {
  const distPath = path.join(process.cwd(), "dist");
  app.use(express.static(distPath));
  app.get("*", (req, res) => {
    res.sendFile(path.join(distPath, "index.html"));
  });
}

// Socket IO
io.on("connection", (socket) => {
  console.log("Client connected:", socket.id);
  
  // Send current active calls to new client
  socket.emit("initial_state", {
    calls: Array.from(activeCalls.values()),
  });

  socket.on("disconnect", () => {
    console.log("Client disconnected:", socket.id);
  });
});

httpServer.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
