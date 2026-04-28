# CERTXA Terminal v2.0 System Documentation

## 1. Overview
The CERTXA Terminal is a high-performance, command-driven VoIP interface designed for rapid call handling and multi-role operations. It integrates directly with Twilio Voice for seamless signaling and audio.

---

## 2. Agent Workflow & Commands

### 2.1 Session Management
*   `LOGIN [7-Digit-Code]`: Authenticate with the system.
*   `SIGNOFF` / `LOGOUT`: Close your current session and wipe local buffers.
*   `AGENT`: Switch back to the standard Agent dashboard from Admin/Monitor modes.

### 2.2 Status Controls
*   `READY` or `R` (Main Menu): Set status to **Available**. You will now receive inbound call pops.
*   `Y` (Phone Menu): Shortcut for READY.
*   `DND`: Set status to **Do Not Disturb**. System will stop routing new calls to you.

### 2.3 Call Handling (Hotkeys & Commands)
*   `A` or `ACCEPT`: Answer an incoming call popup or pick up the oldest call from the queue.
*   `W` or `WRAP`: End the active call immediately and enter wrap-up mode. This clears the customer data panel.
*   `ESC`: Reset navigation (closes submenus).
*   `00`: Open the **Phone Submenu** for advanced call controls.

### 2.4 Phone Submenu (`00`)
*   `H` or `HOLD`: Place the customer on hold with music.
*   `R` or `RESUME`: Bring the customer back from hold.
*   `X` or `TRANSFER`: Initiate a **Warm Transfer**.
*   `B` or `BILLING`: Switch to the Billing support script.
*   `T` or `TECH`: Switch to the Technical support script.

---

## 3. Advanced Call Procedures

### 3.1 Warm Transfers
1.  During an active call, Agent 1 types `X`.
2.  Customer is automatically placed on hold.
3.  Agent 2 (Target) receives a "BRIEFING" signal.
4.  Agent 1 and Agent 2 can speak privately.
5.  Agent 2 types `T` (**TAKEOVER**) to complete the transfer. Agent 1 is released.

### 3.2 Hold / Park
*   Using the `H` command moves the participant into a muted state with classical hold music.
*   Unlike traditional "Parking," calls stay assigned to the agent who held them until transferred or disconnected.

---

## 4. Admin Management
**Access: Type `ADMIN` in the command bar.**

### 4.1 Agent Management
*   **Command**: `CREATE [ID] [NAME] [PIN] [LOGCODE]`
    *   *Example*: `CREATE agent-005 John Doe 1234 9988771`
*   Admins can view all registered agents and their current statuses (Available/Busy/DND).

### 4.2 Workflow & Script Editor
*   Admins can modify the "Read Script" and "Guide Message" for every call state (IDLE, ACTIVE, WRAP, etc.).
*   **Command**: `SAVE` (while editing a script in the Admin UI).

### 4.3 System Logs
*   Real-time access to the system log, tracking every Answer, Hold, and Transfer action across the entire organization.

---

## 5. QA & Monitoring
**Access: Type `MONITOR` in the command bar.**

### 5.1 Silent Monitoring
*   The Monitor dashboard shows a live feed of all active calls.
*   **Command**: `JOIN [CallSid]`
    *   *Operation*: The Manager joins the conference silently. They can hear both the agent and the customer but cannot be heard by either.

---

## 6. Technical Troubleshooting
*   **CRITICAL: Error 31202 (JWT Signature Failure)**:
    *   This is the most common cause of "Answering but only hearing music."
    *   **The Fix**: You must use a **Twilio API Secret**, *not* your main Auth Token.
    *   Go to **Twilio Console > Account > API Keys**. Create a "Standard" key.
    *   Set `TWILIO_VOICE_API_KEY` to the SID (starts with `SK...`).
    *   Set `TWILIO_VOICE_API_SECRET` to the Secret (the long string shown only once).
*   **Answer Box appears but doesn't connect**: 
    *   When you press `A`, the terminal tries to pull the call to you. If your COMM-LINK status is not "ESTABLISHED", the call will stay in the queue (hearing music) because Twilio cannot find your browser.
*   **Check COMM-LINK**: Ensure the log shows `COMM-LINK ESTABLISHED` on startup.
*   **Manual Reset**: Type `READY` again to re-sync your status if you stop receiving calls.
