import DatabaseConstructor from "better-sqlite3";
import path from "path";

export class Database {
  private db: any;

  constructor() {
    const dbPath = path.resolve(process.cwd(), "call_center.db");
    this.db = new DatabaseConstructor(dbPath);
    this.init();
  }

  private init() {
    // Users table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        name TEXT,
        email TEXT,
        role TEXT,
        status TEXT,
        pin TEXT
      )
    `);

    // Calls table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS calls (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        callSid TEXT UNIQUE,
        status TEXT,
        assignedAgent TEXT,
        customerName TEXT,
        queueName TEXT,
        createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
        answeredAt DATETIME,
        endedAt DATETIME,
        holdTime INTEGER DEFAULT 0,
        isMissed BOOLEAN DEFAULT FALSE
      )
    `);

    // Agent Logs
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agent_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        agentId TEXT,
        action TEXT,
        callSid TEXT,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Scripts Table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS scripts (
        state TEXT PRIMARY KEY,
        read TEXT,
        guide TEXT,
        options TEXT DEFAULT '[]'
      )
    `);

    // Seed admin if not exists
    const admin = this.db.prepare("SELECT * FROM users WHERE id = ?").get("admin-001");
    if (!admin) {
      this.db.prepare("INSERT INTO users (id, name, email, role, status, pin) VALUES (?, ?, ?, ?, ?, ?)")
        .run("admin-001", "System Admin", "admin@certxa.com", "admin", "available", "1234");
      this.db.prepare("INSERT INTO users (id, name, email, role, status, pin) VALUES (?, ?, ?, ?, ?, ?)")
        .run("agent-001", "Agent Smith", "smith@certxa.com", "agent", "available", "0000");
    }
  }

  createCall(callSid: string, status: string, customerName: string) {
    const stmt = this.db.prepare(`
      INSERT INTO calls (callSid, status, customerName, queueName)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(callSid) DO UPDATE SET status = excluded.status
    `);
    return stmt.run(callSid, status, customerName, "Main Queue");
  }

  updateCallStatus(callSid: string, status: string) {
    const stmt = this.db.prepare("UPDATE calls SET status = ? WHERE callSid = ?");
    return stmt.run(status, callSid);
  }

  assignAgent(callSid: string, agentId: string) {
    const stmt = this.db.prepare("UPDATE calls SET assignedAgent = ?, status = 'ACTIVE', answeredAt = CURRENT_TIMESTAMP WHERE callSid = ?");
    return stmt.run(agentId, callSid);
  }

  getCalls() {
    return this.db.prepare("SELECT * FROM calls ORDER BY createdAt DESC").all();
  }

  getUsers() {
    return this.db.prepare("SELECT * FROM users").all();
  }

  logAgentAction(agentId: string, action: string, callSid: string | null = null) {
    const stmt = this.db.prepare("INSERT INTO agent_logs (agentId, action, callSid) VALUES (?, ?, ?)");
    return stmt.run(agentId, action, callSid);
  }

  getLogs(agentId?: string) {
    if (agentId) {
      return this.db.prepare("SELECT * FROM agent_logs WHERE agentId = ? ORDER BY timestamp DESC").all(agentId);
    }
    return this.db.prepare("SELECT * FROM agent_logs ORDER BY timestamp DESC").all();
  }

  createAgent(id: string, name: string, pin: string) {
    const stmt = this.db.prepare("INSERT INTO users (id, name, role, status, pin) VALUES (?, ?, 'agent', 'available', ?)");
    return stmt.run(id, name, pin);
  }

  updateAgent(id: string, name: string, pin: string) {
    const stmt = this.db.prepare("UPDATE users SET name = ?, pin = ? WHERE id = ?");
    return stmt.run(name, pin, id);
  }

  deleteAgent(id: string) {
    const stmt = this.db.prepare("DELETE FROM users WHERE id = ?");
    return stmt.run(id);
  }

  createTransfer(callSid: string, fromAgent: string, toAgent: string) {
    // We can reuse agent_logs or a dedicated table. Restoration of missing method.
    const stmt = this.db.prepare("INSERT INTO agent_logs (agentId, action, callSid) VALUES (?, ?, ?)");
    return stmt.run(fromAgent, `TRANSFER_INITIATED_TO_${toAgent}`, callSid);
  }

  markAnswered(callSid: string) {
    const stmt = this.db.prepare("UPDATE calls SET answeredAt = CURRENT_TIMESTAMP, status = 'ACTIVE' WHERE callSid = ?");
    return stmt.run(callSid);
  }

  markMissed(callSid: string) {
    const stmt = this.db.prepare("UPDATE calls SET isMissed = TRUE, status = 'MISSED' WHERE callSid = ?");
    return stmt.run(callSid);
  }

  getAgentStats(agentId: string) {
    return this.db.prepare(`
      SELECT 
        COUNT(*) as total_calls,
        AVG(strftime('%s', answeredAt) - strftime('%s', createdAt)) as avg_answer_speed
      FROM calls 
      WHERE assignedAgent = ? AND answeredAt IS NOT NULL
    `).get(agentId);
  }

  getScripts() {
    const rows = this.db.prepare("SELECT * FROM scripts").all();
    const map: Record<string, any> = {};
    rows.forEach((r: any) => {
      map[r.state] = { 
        read: r.read, 
        guide: r.guide,
        options: JSON.parse(r.options || '[]')
      };
    });
    return map;
  }

  updateScript(state: string, read: string, guide: string, options: any[] = []) {
    const stmt = this.db.prepare(`
      INSERT INTO scripts (state, read, guide, options)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(state) DO UPDATE SET read = excluded.read, guide = excluded.guide, options = excluded.options
    `);
    const optionsStr = JSON.stringify(options);
    return stmt.run(state, read, guide, optionsStr);
  }
}
