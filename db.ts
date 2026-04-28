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
        pin TEXT,
        login_code TEXT UNIQUE
      )
    `);

    // Migration logic for existing tables
    try {
      const tableInfo = this.db.prepare("PRAGMA table_info(users)").all();
      const hasLoginCode = tableInfo.some((col: any) => col.name === 'login_code');
      if (!hasLoginCode) {
        // SQLite doesn't allow adding a UNIQUE column via ALTER TABLE
        this.db.exec("ALTER TABLE users ADD COLUMN login_code TEXT");
        // Create an index if we want uniqueness
        this.db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_login_code ON users(login_code)");
      }
    } catch (err) {
      console.error("[DATABASE] Critical migration error (users table):", err);
    }

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

    // Scripts Table (Global/State-based)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS scripts (
        state TEXT PRIMARY KEY,
        read TEXT,
        guide TEXT,
        options TEXT DEFAULT '[]'
      )
    `);

    // Campaigns Table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS campaigns (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT,
        description TEXT,
        status TEXT DEFAULT 'active',
        createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Campaign Scripts (The specific script blocks/records used in a campaign)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS campaign_scripts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        campaignId INTEGER,
        title TEXT,
        read TEXT,
        guide TEXT,
        options TEXT DEFAULT '[]',
        createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(campaignId) REFERENCES campaigns(id)
      )
    `);

    // Seed agents if not exists or if they missing login_code
    const admin = this.db.prepare("SELECT * FROM users WHERE id = ?").get("admin-001");
    if (!admin) {
      this.db.prepare("INSERT INTO users (id, name, email, role, status, pin, login_code) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run("admin-001", "System Admin", "admin@certxa.com", "admin", "available", "1234", "9999999");
    } else if (!admin.login_code) {
      this.db.prepare("UPDATE users SET login_code = ? WHERE id = ?").run("9999999", "admin-001");
    }

    const agent = this.db.prepare("SELECT * FROM users WHERE id = ?").get("agent-001");
    if (!agent) {
      this.db.prepare("INSERT INTO users (id, name, email, role, status, pin, login_code) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run("agent-001", "Agent Smith", "smith@certxa.com", "agent", "available", "0000", "1234567");
    } else if (!agent.login_code) {
      this.db.prepare("UPDATE users SET login_code = ? WHERE id = ?").run("1234567", "agent-001");
    }

    const manager = this.db.prepare("SELECT * FROM users WHERE id = ?").get("manager-001");
    if (!manager) {
      this.db.prepare("INSERT INTO users (id, name, email, role, status, pin, login_code) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run("manager-001", "Manager Mike", "mike@certxa.com", "manager", "available", "8888", "8888888");
    } else if (!manager.login_code) {
      this.db.prepare("UPDATE users SET login_code = ? WHERE id = ?").run("8888888", "manager-001");
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

  createAgent(id: string, name: string, pin: string, loginCode: string) {
    const stmt = this.db.prepare("INSERT INTO users (id, name, role, status, pin, login_code) VALUES (?, ?, 'agent', 'available', ?, ?)");
    return stmt.run(id, name, pin, loginCode);
  }

  updateAgent(id: string, name: string, pin: string, loginCode: string) {
    const stmt = this.db.prepare("UPDATE users SET name = ?, pin = ?, login_code = ? WHERE id = ?");
    return stmt.run(name, pin, loginCode, id);
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

  updateUserStatus(id: string, status: string) {
    const stmt = this.db.prepare("UPDATE users SET status = ? WHERE id = ?");
    return stmt.run(status, id);
  }

  // --- Campaign Management ---
  getCampaigns() {
    return this.db.prepare("SELECT * FROM campaigns ORDER BY createdAt DESC").all();
  }

  createCampaign(name: string, description: string) {
    const stmt = this.db.prepare("INSERT INTO campaigns (name, description) VALUES (?, ?)");
    return stmt.run(name, description);
  }

  deleteCampaign(id: number) {
    this.db.prepare("DELETE FROM campaign_scripts WHERE campaignId = ?").run(id);
    return this.db.prepare("DELETE FROM campaigns WHERE id = ?").run(id);
  }

  // --- Campaign Script Management ---
  getCampaignScripts(campaignId?: number) {
    if (campaignId) {
      return this.db.prepare("SELECT * FROM campaign_scripts WHERE campaignId = ? ORDER BY id ASC").all(campaignId);
    }
    return this.db.prepare("SELECT * FROM campaign_scripts ORDER BY id ASC").all();
  }

  createCampaignScript(campaignId: number, title: string, read: string, guide: string, options: any[] = []) {
    const stmt = this.db.prepare(`
      INSERT INTO campaign_scripts (campaignId, title, read, guide, options)
      VALUES (?, ?, ?, ?, ?)
    `);
    return stmt.run(campaignId, title, read, guide, JSON.stringify(options));
  }

  updateCampaignScript(id: number, title: string, read: string, guide: string, options: any[] = []) {
    const stmt = this.db.prepare(`
      UPDATE campaign_scripts SET title = ?, read = ?, guide = ?, options = ?
      WHERE id = ?
    `);
    return stmt.run(title, read, guide, JSON.stringify(options), id);
  }

  deleteCampaignScript(id: number) {
    return this.db.prepare("DELETE FROM campaign_scripts WHERE id = ?").run(id);
  }

  getAvailableAgent() {
    return this.db.prepare("SELECT * FROM users WHERE role = 'agent' AND status = 'available' LIMIT 1").get();
  }

  getOldestQueuedCall() {
    return this.db.prepare("SELECT * FROM calls WHERE status = 'QUEUED' ORDER BY createdAt ASC LIMIT 1").get();
  }

  getAgentByLoginCode(code: string) {
    return this.db.prepare("SELECT * FROM users WHERE login_code = ?").get(code);
  }

  getAgentById(id: string) {
    return this.db.prepare("SELECT * FROM users WHERE id = ?").get(id);
  }
}
