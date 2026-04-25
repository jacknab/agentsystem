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

// Twilio Client
const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

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
  const { id, name, pin } = req.body;
  if (!id || !name || !pin) return res.status(400).json({ error: "Missing fields" });
  db.createAgent(id, name, pin);
  res.json({ success: true });
});

app.put("/api/admin/agents/:id", (req, res) => {
  const { id } = req.params;
  const { name, pin } = req.body;
  db.updateAgent(id, name, pin);
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

// --- IVR & Business Hours ---
const BUSINESS_HOURS = {
  start: 9, // 9 AM
  end: 18,  // 6 PM
  days: [1, 2, 3, 4, 5] // Mon-Fri
};

function isBusinessOpen() {
  const now = new Date();
  const day = now.getDay();
  const hour = now.getHours();
  return BUSINESS_HOURS.days.includes(day) && hour >= BUSINESS_HOURS.start && hour < BUSINESS_HOURS.end;
}

app.post("/twilio/voice", (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();
  
  if (isBusinessOpen()) {
    // Greeting with language selection
    const gather = twiml.gather({
      numDigits: 1,
      action: "/twilio/ivr/selection",
      timeout: 5
    });
    
    // TODO: When user uploads file, change this to twiml.play("/filename.mp3")
    gather.say({ language: 'vi-VN' }, "Chào mừng bạn. Để nghe bằng tiếng Việt, vui lòng nhấn phím 1.");
    
    // English voice follows if no input
    twiml.say("Welcome. Please hold on the line for the next available agent.");
    
    const callSid = req.body.CallSid || `CS${Date.now()}`;
    db.logAction('SYS', 'INBOUND_CALL_QUEUED', callSid);
  } else {
    // After hours - Route to main voicemail or menu
    twiml.say("Thank you for calling. We are currently closed.");
    twiml.say("Please leave a message after the tone or call back during business hours.");
    twiml.record({
      action: "/twilio/voicemail/general",
      maxLength: 30,
      finishOnKey: "#"
    });
  }

  res.type("text/xml").send(twiml.toString());
});

app.post("/twilio/ivr/selection", (req, res) => {
  const { Digits, CallSid } = req.body;
  const twiml = new twilio.twiml.VoiceResponse();
  
  if (Digits === '1') {
    db.logAction('SYS', 'IVR_PREF_VIETNAMESE', CallSid);
    twiml.say({ language: 'vi-VN' }, "Đang kết nối bạn với nhân viên hỗ trợ tiếng Việt. Vui lòng chờ trong giây lát.");
  } else {
    db.logAction('SYS', 'IVR_PREF_ENGLISH', CallSid);
    twiml.say("Connecting you to the next available agent. Thank you for waiting.");
  }
  
  // In a real scenario, we'd proceed to <Dial> or <Queue>
  res.type("text/xml").send(twiml.toString());
});

app.post("/twilio/voicemail/:agentId", (req, res) => {
  const { agentId } = req.params;
  const { RecordingUrl, From, CallSid } = req.body;
  
  if (RecordingUrl) {
    db.saveVoicemail(agentId === 'general' ? 'SYSTEM' : agentId, CallSid, From, RecordingUrl);
    db.logAction(agentId, 'VOICEMAIL_RECEIVED', CallSid);
  }
  
  const twiml = new twilio.twiml.VoiceResponse();
  twiml.say("Thank you for your message. Goodbye.");
  twiml.hangup();
  res.type("text/xml").send(twiml.toString());
});

app.get("/api/voicemails", (req, res) => {
  const agentId = req.query.agentId as string;
  res.json(db.getVoicemails(agentId));
});

app.post("/api/voicemails/:id/read", (req, res) => {
  db.markVoicemailRead(Number(req.params.id));
  res.json({ success: true });
});

// --- Silent Join (QA Monitor) ---
app.post("/twilio/monitor", async (req, res) => {
  const { callSid, managerId } = req.body;
  const call = activeCalls.get(callSid);
  if (!call || !call.conferenceSid) return res.status(404).json({ error: "Active conference not found" });

  try {
    io.emit("call.monitor_joined", { callSid, managerId });
    db.logAgentAction(managerId, "MONITOR_JOIN", callSid);
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

app.post("/twilio/inbound", (req, res) => {
  try {
    const { CallSid, From } = req.body;
    const twiml = new twilio.twiml.VoiceResponse();

    console.log(`[TWILIO] Incoming call: From=${From}, SID=${CallSid}`);

    if (!CallSid) {
      console.error("[TWILIO] Missing CallSid in request body");
      return res.status(400).send("Missing CallSid");
    }

    // Create call record in DB
    db.createCall(CallSid, "INBOUND", From || "Unknown");

    twiml.say("Connecting you to the next available agent.");

    const state: CallState = {
      callSid: CallSid,
      status: "INBOUND",
      assignedAgent: null,
      customerName: From || "Unknown",
      queueName: "Main Queue",
    };
    activeCalls.set(CallSid, state);

    io.emit("call.inbound", state);

    // Place into a conference (queue)
    const dial = twiml.dial();
    
    // Determine the status callback URL
    let baseUrl = process.env.APP_URL || "";
    if (!baseUrl || baseUrl.includes("-dev-")) {
      const protocol = req.headers['x-forwarded-proto'] || 'http';
      const host = req.headers['host'] || "";
      let detectedUrl = `${protocol}://${host}`;
      if (detectedUrl.includes("-dev-")) {
        baseUrl = detectedUrl.replace("-dev-", "-pre-");
      } else {
        baseUrl = detectedUrl;
      }
    }
    
    const statusCallback = `${baseUrl}/twilio/status`;
    console.log(`[TWILIO] Using statusCallback: ${statusCallback}`);

    dial.conference({
      waitUrl: process.env.HOLD_MUSIC_URL || "http://twimlets.com/holdmusic?Bucket=com.twilio.music.classical",
      statusCallbackEvent: ["start", "end", "join", "leave", "mute", "hold"],
      statusCallback: statusCallback,
    }, `conf_${CallSid}`);

    console.log(`[TWILIO] TwiML generated for SID=${CallSid}`);
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

app.post("/twilio/hold", async (req, res) => {
  const { callSid } = req.body;
  const call = activeCalls.get(callSid);

  if (call && call.conferenceSid) {
    try {
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
    // 1. Put customer on HOLD
    await twilioClient.conferences(call.conferenceSid)
      .participants(callSid)
      .update({ hold: true, holdUrl: process.env.HOLD_MUSIC_URL || "http://twimlets.com/holdmusic?Bucket=com.twilio.music.classical" });

    // 2. Bring Agent B into BRIEFING (simulated via WebSockets / Browser SIP)
    call.status = "BRIEFING";
    db.createTransfer(callSid, fromAgent, toAgent);
    io.emit("call.briefing_started", { ...call, fromAgent, toAgent });

    res.json({ success: true });
  } else {
    res.status(404).json({ error: "Call not found" });
  }
});

app.post("/twilio/transfer/complete", async (req, res) => {
  const { callSid, toAgent } = req.body;
  const call = activeCalls.get(callSid);

  if (call && call.conferenceSid) {
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
  } else {
    res.status(404).json({ error: "Call not found" });
  }
});

app.post("/api/call/end", (req, res) => {
  const { callSid } = req.body;
  const call = activeCalls.get(callSid);
  if (call) {
    call.status = "WRAP";
    db.updateCallStatus(callSid, "WRAP");
    io.emit("call.ended", call);
    
    // Finalize after some time or agent action
    setTimeout(() => {
      activeCalls.delete(callSid);
    }, 60000); // 1 minute wrap-up
    
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
