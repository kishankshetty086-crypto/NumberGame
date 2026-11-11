const fs = require('fs');
const os = require('os');
const path = require('path');
const { writeStoredExports } = require('./exportData');
const { computeCombinedLeaderboard } = require('./gameLogic');

function isServerlessEnv() {
  return Boolean(
    process.env.VERCEL ||
      process.env.VERCEL_ENV ||
      process.env.VERCEL_URL ||
      process.env.AWS_LAMBDA_FUNCTION_NAME ||
      process.env.LAMBDA_TASK_ROOT
  );
}

function getDefaultDbPath() {
  const dir = isServerlessEnv()
    ? path.join(os.tmpdir(), 'office-number-game-data')
    : path.join(__dirname, '..', 'data');
  return path.join(dir, 'db.json');
}

function isDirWritable(dirPath) {
  try {
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
    }
    const probe = path.join(dirPath, `.probe-${process.pid}-${Date.now()}`);
    fs.writeFileSync(probe, 'ok', 'utf8');
    fs.unlinkSync(probe);
    return true;
  } catch {
    return false;
  }
}

function createDefaultState() {
  return {
    nextTicketSeq: 1,
    tickets: [],
    sessions: [],
    submissions: [],
  };
}

function getRemoteKvConfig() {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || '';
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || '';
  if (url && token) {
    return {
      url: url.replace(/\/+$/, ''),
      token,
      key: process.env.GAME_STATE_KEY || 'office_number_game:state',
    };
  }
  return null;
}

class GameStore {
  constructor(dbPath = getDefaultDbPath(), options = {}) {
    let targetPath = dbPath;
    let targetDir = path.dirname(targetPath);

    if (!isDirWritable(targetDir)) {
      targetDir = path.join(os.tmpdir(), 'office-number-game-data');
      targetPath = path.join(targetDir, path.basename(dbPath));
      this.memoryOnly = !isDirWritable(targetDir);
    } else {
      this.memoryOnly = false;
    }

    this.dbPath = targetPath;
    this.dir = targetDir;
    this._remoteKv = options.remoteKv !== undefined ? options.remoteKv : getRemoteKvConfig();
    this._dirty = false;
    this.state = this._load();
    this.exportFiles = this._writeExports();
  }

  getStorageInfo() {
    if (this._remoteKv) {
      return { mode: 'redis', persistent: true };
    }
    if (this.memoryOnly) {
      return { mode: 'memory', persistent: false };
    }
    if (isServerlessEnv()) {
      return { mode: 'tmp-ephemeral', persistent: false };
    }
    return { mode: 'file', persistent: true };
  }

  async _runKvCommand(command) {
    if (!this._remoteKv || typeof fetch !== 'function') return null;
    const resp = await fetch(this._remoteKv.url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this._remoteKv.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(command),
    });
    if (!resp.ok) {
      throw new Error(`Remote KV request failed (${resp.status})`);
    }
    return resp.json();
  }

  async syncFromRemote() {
    if (!this._remoteKv) return;
    const data = await this._runKvCommand(['GET', this._remoteKv.key]);
    if (data && typeof data.result === 'string' && data.result.trim()) {
      const parsed = JSON.parse(data.result);
      this.state = {
        ...createDefaultState(),
        ...parsed,
      };
    } else {
      this.state = createDefaultState();
    }
    this._dirty = false;
    this._persist(this.state);
    this.exportFiles = this._writeExports();
  }

  async flushRemote() {
    if (!this._remoteKv || !this._dirty) return;
    await this._runKvCommand(['SET', this._remoteKv.key, JSON.stringify(this.state)]);
    this._dirty = false;
  }

  _writeExports() {
    if (this.memoryOnly) return null;
    try {
      const lb = computeCombinedLeaderboard(
        this.state.tickets,
        this.state.sessions,
        this.state.submissions
      );
      return writeStoredExports(this.dir, this.state.submissions, this.state.tickets, lb);
    } catch {
      return null;
    }
  }

  _load() {
    if (this.memoryOnly) {
      return createDefaultState();
    }
    if (!fs.existsSync(this.dbPath)) {
      const initial = createDefaultState();
      this._persist(initial);
      return initial;
    }
    try {
      const raw = fs.readFileSync(this.dbPath, 'utf8');
      const parsed = JSON.parse(raw);
      const defaults = createDefaultState();
      return {
        ...defaults,
        ...parsed,
      };
    } catch {
      const initial = createDefaultState();
      this._persist(initial);
      return initial;
    }
  }

  _persist(stateToSave = this.state) {
    if (this.memoryOnly) return;
    try {
      const tmpPath = `${this.dbPath}.tmp`;
      fs.writeFileSync(tmpPath, JSON.stringify(stateToSave, null, 2), 'utf8');
      fs.renameSync(tmpPath, this.dbPath);
    } catch {
      // ignore disk persistence failures in read-only runtimes
    }
  }

  save() {
    this._dirty = true;
    this._persist(this.state);
    this.exportFiles = this._writeExports();
  }

  getTickets() {
    return this.state.tickets;
  }

  findTicketById(ticketId) {
    const target = String(ticketId || '').trim().toUpperCase();
    return this.state.tickets.find((t) => t.ticketId.toUpperCase() === target) || null;
  }

  findTicketBySecret(secretCode) {
    const target = String(secretCode || '').trim().toUpperCase();
    return this.state.tickets.find((t) => t.secretCode.toUpperCase() === target) || null;
  }

  addTickets(newTickets) {
    this.state.tickets.push(...newTickets);
    this.state.nextTicketSeq += newTickets.length;
    this.save();
    return newTickets;
  }

  updateTicket(ticketId, patch) {
    const ticket = this.findTicketById(ticketId);
    if (!ticket) return null;
    Object.assign(ticket, patch);
    this.save();
    return ticket;
  }

  deleteTicket(ticketId) {
    const before = this.state.tickets.length;
    this.state.tickets = this.state.tickets.filter((t) => t.ticketId !== ticketId);
    if (this.state.tickets.length !== before) {
      this.save();
      return true;
    }
    return false;
  }

  getSessions() {
    return this.state.sessions;
  }

  findSessionByToken(token) {
    return this.state.sessions.find((s) => s.token === token) || null;
  }

  findSessionById(id) {
    return this.state.sessions.find((s) => s.id === id) || null;
  }

  addSession(session) {
    this.state.sessions.unshift(session);
    this.save();
    return session;
  }

  updateSession(id, patch) {
    const session = this.findSessionById(id);
    if (!session) return null;
    Object.assign(session, patch);
    this.save();
    return session;
  }

  deleteSession(id) {
    const before = this.state.sessions.length;
    this.state.sessions = this.state.sessions.filter((s) => s.id !== id);
    if (this.state.sessions.length !== before) {
      this.state.submissions = this.state.submissions.filter((sub) => sub.sessionId !== id);
      this.save();
      return true;
    }
    return false;
  }

  getSubmissions(sessionId = null) {
    if (!sessionId) return this.state.submissions;
    return this.state.submissions.filter((s) => s.sessionId === sessionId);
  }

  findSubmission(sessionId, ticketId) {
    return (
      this.state.submissions.find(
        (s) => s.sessionId === sessionId && s.ticketId.toUpperCase() === ticketId.toUpperCase()
      ) || null
    );
  }

  addSubmission(submission) {
    this.state.submissions.push(submission);
    this.save();
    return submission;
  }

  getTicketUsedNumbers(ticketId) {
    const ticket = this.findTicketById(ticketId);
    const used = new Set(ticket?.usedNumbers || []);
    const target = String(ticketId || '').trim().toUpperCase();
    for (const sub of this.state.submissions) {
      if (sub.ticketId.toUpperCase() === target) {
        used.add(Number(sub.selectedNumber));
      }
    }
    return [...used];
  }

  getLeaderboard() {
    return computeCombinedLeaderboard(
      this.state.tickets,
      this.state.sessions,
      this.state.submissions
    );
  }

  resetAll() {
    this.state = createDefaultState();
    if (fs.existsSync(this.dir)) {
      for (const entry of fs.readdirSync(this.dir)) {
        const fullPath = path.join(this.dir, entry);
        try {
          if (fs.statSync(fullPath).isFile()) {
            fs.unlinkSync(fullPath);
          }
        } catch {
          // ignore file unlink errors
        }
      }
    }
    this.save();
    return this.state;
  }
}

module.exports = {
  GameStore,
};
