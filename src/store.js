const fs = require('fs');
const path = require('path');
const { writeStoredExports } = require('./exportData');
const { computeCombinedLeaderboard } = require('./gameLogic');

const DEFAULT_DATA_DIR = process.env.VERCEL
  ? path.join('/tmp', 'office-number-game-data')
  : path.join(__dirname, '..', 'data');
const DEFAULT_DB_PATH = path.join(DEFAULT_DATA_DIR, 'db.json');

function createDefaultState() {
  return {
    nextTicketSeq: 1,
    tickets: [],
    sessions: [],
    submissions: [],
  };
}

class GameStore {
  constructor(dbPath = DEFAULT_DB_PATH) {
    this.dbPath = dbPath;
    this.dir = path.dirname(dbPath);
    if (!fs.existsSync(this.dir)) {
      fs.mkdirSync(this.dir, { recursive: true });
    }
    this.state = this._load();
    this.exportFiles = this._writeExports();
  }

  _writeExports() {
    const lb = computeCombinedLeaderboard(
      this.state.tickets,
      this.state.sessions,
      this.state.submissions
    );
    return writeStoredExports(this.dir, this.state.submissions, this.state.tickets, lb);
  }

  _load() {
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
    const tmpPath = `${this.dbPath}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(stateToSave, null, 2), 'utf8');
    fs.renameSync(tmpPath, this.dbPath);
  }

  save() {
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
