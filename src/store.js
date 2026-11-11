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
    auth: null,
  };
}

function getRemoteKvConfig(env = process.env) {
  const prefix = env.GAME_STATE_KEY || 'office_number_game:state';
  const directPairs = [
    [env.KV_REST_API_URL, env.KV_REST_API_TOKEN],
    [env.UPSTASH_REDIS_REST_URL, env.UPSTASH_REDIS_REST_TOKEN],
  ];
  for (const [url, token] of directPairs) {
    if (url && token) {
      return { url: String(url).replace(/\/+$/, ''), token: String(token), key: prefix };
    }
  }
  for (const name of Object.keys(env)) {
    const match = name.match(/^(.+)_(KV_REST_API_URL|UPSTASH_REDIS_REST_URL)$/);
    if (!match) continue;
    const tokenKey =
      match[2] === 'KV_REST_API_URL'
        ? `${match[1]}_KV_REST_API_TOKEN`
        : `${match[1]}_UPSTASH_REDIS_REST_TOKEN`;
    if (env[name] && env[tokenKey]) {
      return {
        url: String(env[name]).replace(/\/+$/, ''),
        token: String(env[tokenKey]),
        key: prefix,
      };
    }
  }
  return null;
}

function parseRedisHashList(raw) {
  if (!raw) return [];
  const items = [];
  if (Array.isArray(raw)) {
    for (let i = 1; i < raw.length; i += 2) {
      try {
        items.push(JSON.parse(raw[i]));
      } catch {
        // ignore malformed entry
      }
    }
    return items;
  }
  if (typeof raw === 'object') {
    for (const val of Object.values(raw)) {
      try {
        items.push(JSON.parse(val));
      } catch {
        // ignore malformed entry
      }
    }
  }
  return items;
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
    this._pendingKvCommands = [];
    this._exportTimer = null;
    this._exportsDirty = false;
    this.state = this._load();
    this.exportFiles = this._writeExports();
  }

  _kvKeys() {
    const base = this._remoteKv ? this._remoteKv.key : 'office_number_game:state';
    return {
      legacy: base,
      seq: `${base}:seq`,
      auth: `${base}:auth`,
      tickets: `${base}:tickets`,
      sessions: `${base}:sessions`,
      submissions: `${base}:submissions`,
    };
  }

  _queueKv(command) {
    if (this._remoteKv) {
      this._pendingKvCommands.push(command);
    }
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

  async _runKvPipeline(commands) {
    if (!this._remoteKv || typeof fetch !== 'function' || commands.length === 0) return [];
    const resp = await fetch(`${this._remoteKv.url}/pipeline`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this._remoteKv.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(commands),
    });
    if (!resp.ok) {
      throw new Error(`Remote KV pipeline failed (${resp.status})`);
    }
    return resp.json();
  }

  async syncFromRemote() {
    if (!this._remoteKv) return;
    const keys = this._kvKeys();
    const results = await this._runKvPipeline([
      ['GET', keys.seq],
      ['HGETALL', keys.tickets],
      ['HGETALL', keys.sessions],
      ['HGETALL', keys.submissions],
      ['GET', keys.legacy],
      ['GET', keys.auth],
    ]);

    const seqVal = results[0]?.result;
    const tickets = parseRedisHashList(results[1]?.result).sort((a, b) =>
      String(a.createdAt || '').localeCompare(String(b.createdAt || ''))
    );
    const sessions = parseRedisHashList(results[2]?.result).sort(
      (a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime()
    );
    const submissions = parseRedisHashList(results[3]?.result).sort(
      (a, b) => new Date(a.submittedAt || 0).getTime() - new Date(b.submittedAt || 0).getTime()
    );
    const legacyRaw = results[4]?.result;
    let auth = null;
    if (typeof results[5]?.result === 'string' && results[5].result.trim()) {
      try {
        auth = JSON.parse(results[5].result);
      } catch {
        auth = null;
      }
    }

    const hasHashData =
      (seqVal !== null && seqVal !== undefined) ||
      tickets.length > 0 ||
      sessions.length > 0 ||
      submissions.length > 0 ||
      Boolean(auth);

    if (hasHashData) {
      this.state = {
        nextTicketSeq: Math.max(1, Number(seqVal || 1)),
        tickets,
        sessions,
        submissions,
        auth,
      };
    } else if (typeof legacyRaw === 'string' && legacyRaw.trim()) {
      const parsed = JSON.parse(legacyRaw);
      this.state = { ...createDefaultState(), ...parsed };
    } else {
      this.state = createDefaultState();
    }

    this._pendingKvCommands = [];
    this._persist(this.state);
    this.exportFiles = this._writeExports();
  }

  getAuth() {
    return this.state.auth || null;
  }

  setAuth(authObj) {
    this.state.auth = authObj;
    const keys = this._kvKeys();
    this._queueKv(['SET', keys.auth, JSON.stringify(authObj)]);
    this.save();
    return this.state.auth;
  }

  async flushRemote() {
    if (!this._remoteKv || this._pendingKvCommands.length === 0) return;
    const commands = this._pendingKvCommands;
    this._pendingKvCommands = [];
    await this._runKvPipeline(commands);
  }

  _writeExports() {
    if (this.memoryOnly || isServerlessEnv() || this._remoteKv) return null;
    this._exportsDirty = false;
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

  _scheduleExports() {
    if (this.memoryOnly || isServerlessEnv() || this._remoteKv) return;
    this._exportsDirty = true;
    if (this._exportTimer) clearTimeout(this._exportTimer);
    this._exportTimer = setTimeout(() => {
      this._exportTimer = null;
      this.exportFiles = this._writeExports();
    }, 150);
    if (typeof this._exportTimer.unref === 'function') {
      this._exportTimer.unref();
    }
  }

  flushExports() {
    if (this._exportTimer) {
      clearTimeout(this._exportTimer);
      this._exportTimer = null;
    }
    if (this._exportsDirty || !this.exportFiles) {
      this.exportFiles = this._writeExports();
    }
    return this.exportFiles;
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
      fs.writeFileSync(tmpPath, JSON.stringify(stateToSave), 'utf8');
      fs.renameSync(tmpPath, this.dbPath);
    } catch {
      // ignore disk persistence failures in read-only runtimes
    }
  }

  save({ immediateExports = false } = {}) {
    this._persist(this.state);
    if (immediateExports) {
      this.exportFiles = this._writeExports();
    } else {
      this._scheduleExports();
    }
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
    if (newTickets.length > 0) {
      const keys = this._kvKeys();
      const args = [keys.tickets];
      for (const t of newTickets) {
        args.push(t.ticketId, JSON.stringify(t));
      }
      this._queueKv(['HSET', ...args]);
      this._queueKv(['SET', keys.seq, String(this.state.nextTicketSeq)]);
    }
    this.save();
    return newTickets;
  }

  updateTicket(ticketId, patch) {
    const ticket = this.findTicketById(ticketId);
    if (!ticket) return null;
    Object.assign(ticket, patch);
    this._queueKv(['HSET', this._kvKeys().tickets, ticket.ticketId, JSON.stringify(ticket)]);
    this.save();
    return ticket;
  }

  deleteTicket(ticketId) {
    const target = String(ticketId || '').trim().toUpperCase();
    const removedTicket = this.state.tickets.find((t) => t.ticketId.toUpperCase() === target);
    if (!removedTicket) return false;

    const canonicalId = removedTicket.ticketId;
    this.state.tickets = this.state.tickets.filter((t) => t.ticketId !== canonicalId);
    const removedSubs = this.state.submissions.filter(
      (sub) => sub.ticketId.toUpperCase() === target
    );
    this.state.submissions = this.state.submissions.filter(
      (sub) => sub.ticketId.toUpperCase() !== target
    );

    const keys = this._kvKeys();
    this._queueKv(['HDEL', keys.tickets, canonicalId]);
    if (removedSubs.length > 0) {
      this._queueKv([
        'HDEL',
        keys.submissions,
        ...removedSubs.map((sub) => `${sub.sessionId}:${sub.ticketId}`),
      ]);
    }

    for (const ses of this.state.sessions) {
      if (ses.roundResult && Array.isArray(ses.roundResult.winnerTicketIds)) {
        const filteredIds = ses.roundResult.winnerTicketIds.filter(
          (id) => String(id).toUpperCase() !== target
        );
        if (filteredIds.length !== ses.roundResult.winnerTicketIds.length) {
          ses.roundResult = {
            ...ses.roundResult,
            winnerTicketIds: filteredIds,
          };
          this._queueKv(['HSET', keys.sessions, ses.id, JSON.stringify(ses)]);
        }
      }
    }

    this.save();
    return true;
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
    this._queueKv(['HSET', this._kvKeys().sessions, session.id, JSON.stringify(session)]);
    this.save();
    return session;
  }

  updateSession(id, patch) {
    const session = this.findSessionById(id);
    if (!session) return null;
    Object.assign(session, patch);
    this._queueKv(['HSET', this._kvKeys().sessions, session.id, JSON.stringify(session)]);
    this.save();
    return session;
  }

  deleteSession(id) {
    const before = this.state.sessions.length;
    this.state.sessions = this.state.sessions.filter((s) => s.id !== id);
    if (this.state.sessions.length !== before) {
      const removedSubs = this.state.submissions.filter((sub) => sub.sessionId === id);
      this.state.submissions = this.state.submissions.filter((sub) => sub.sessionId !== id);
      const keys = this._kvKeys();
      this._queueKv(['HDEL', keys.sessions, id]);
      if (removedSubs.length > 0) {
        this._queueKv([
          'HDEL',
          keys.submissions,
          ...removedSubs.map((sub) => `${sub.sessionId}:${sub.ticketId}`),
        ]);
        // Recompute usedNumbers for tickets affected by the deleted session
        const affectedIds = new Set(removedSubs.map((sub) => sub.ticketId.toUpperCase()));
        const remainingByTicket = new Map();
        for (const sub of this.state.submissions) {
          const tid = sub.ticketId.toUpperCase();
          if (!affectedIds.has(tid)) continue;
          if (!remainingByTicket.has(tid)) remainingByTicket.set(tid, []);
          remainingByTicket.get(tid).push(Number(sub.selectedNumber));
        }
        const updatedArgs = [];
        for (const t of this.state.tickets) {
          const tid = t.ticketId.toUpperCase();
          if (!affectedIds.has(tid)) continue;
          t.usedNumbers = [...new Set(remainingByTicket.get(tid) || [])];
          updatedArgs.push(t.ticketId, JSON.stringify(t));
        }
        if (updatedArgs.length > 0) {
          this._queueKv(['HSET', keys.tickets, ...updatedArgs]);
        }
      }
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
    this._queueKv([
      'HSET',
      this._kvKeys().submissions,
      `${submission.sessionId}:${submission.ticketId}`,
      JSON.stringify(submission),
    ]);
    this.save();
    return submission;
  }

  recordSubmission(submission, nextUsedNumbers = null) {
    this.state.submissions.push(submission);
    const keys = this._kvKeys();
    this._queueKv([
      'HSET',
      keys.submissions,
      `${submission.sessionId}:${submission.ticketId}`,
      JSON.stringify(submission),
    ]);
    if (Array.isArray(nextUsedNumbers)) {
      const ticket = this.findTicketById(submission.ticketId);
      if (ticket) {
        ticket.usedNumbers = nextUsedNumbers;
        this._queueKv(['HSET', keys.tickets, ticket.ticketId, JSON.stringify(ticket)]);
      }
    }
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

  async recordSubmissionAtomic(submission, selectedNumber) {
    const existing = this.findSubmission(submission.sessionId, submission.ticketId);
    if (existing) {
      return { duplicate: true, existing };
    }

    // Optimistically push synchronously before any await so concurrent same-process requests see it
    this.state.submissions.push(submission);
    const keys = this._kvKeys();
    const field = `${submission.sessionId}:${submission.ticketId}`;

    if (this._remoteKv) {
      let pipelineRes;
      try {
        pipelineRes = await this._runKvPipeline([
          ['HSETNX', keys.submissions, field, JSON.stringify(submission)],
        ]);
      } catch (err) {
        this.state.submissions = this.state.submissions.filter((s) => s.id !== submission.id);
        throw err;
      }

      const inserted = Number(pipelineRes?.[0]?.result ?? 0);
      if (inserted === 0) {
        this.state.submissions = this.state.submissions.filter((s) => s.id !== submission.id);
        await this.syncFromRemote();
        return {
          duplicate: true,
          existing: this.findSubmission(submission.sessionId, submission.ticketId),
        };
      }

      const ticket = this.findTicketById(submission.ticketId);
      const consumedNum =
        selectedNumber !== null && selectedNumber !== undefined ? Number(selectedNumber) : NaN;
      if (ticket && Number.isInteger(consumedNum)) {
        ticket.usedNumbers = [...new Set([...(ticket.usedNumbers || []), consumedNum])];
        await this._runKvPipeline([['HSET', keys.tickets, ticket.ticketId, JSON.stringify(ticket)]]);
      }
      this._persist(this.state);
      return { duplicate: false, submission };
    }

    const ticket = this.findTicketById(submission.ticketId);
    const consumedNum =
      selectedNumber !== null && selectedNumber !== undefined ? Number(selectedNumber) : NaN;
    if (ticket && Number.isInteger(consumedNum)) {
      ticket.usedNumbers = [...new Set([...(ticket.usedNumbers || []), consumedNum])];
    }
    this.save();
    return { duplicate: false, submission };
  }

  resetAll() {
    const preservedAuth = this.state.auth || null;
    this.state = {
      ...createDefaultState(),
      auth: preservedAuth,
    };
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
    if (this._exportTimer) {
      clearTimeout(this._exportTimer);
      this._exportTimer = null;
    }
    if (this._remoteKv) {
      const keys = this._kvKeys();
      this._pendingKvCommands = [
        ['DEL', keys.seq, keys.tickets, keys.sessions, keys.submissions, keys.legacy],
      ];
    }
    this.save({ immediateExports: true });
    return this.state;
  }
}

module.exports = {
  GameStore,
  getRemoteKvConfig,
};
