const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const {
  DECADE_SETS,
  generateTicketNumbers,
  validateTicketSetDistribution,
  generateSecretCode,
  generateTicketId,
  generateSessionToken,
  evaluateWinners,
} = require('./gameLogic');
const { renderTicketHtml, renderAllTicketsHtml, buildZip } = require('./ticketHtml');
const {
  buildSubmissionsCsv,
  buildSubmissionsXlsx,
  buildTicketsCsv,
  buildTicketsXlsx,
  buildLeaderboardCsv,
  buildLeaderboardXlsx,
} = require('./exportData');
const { GameStore } = require('./store');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function sendHtml(res, statusCode, html, extraHeaders = {}) {
  res.writeHead(statusCode, {
    'Content-Type': 'text/html; charset=utf-8',
    ...extraHeaders,
  });
  res.end(html);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let totalBytes = 0;
    req.on('data', (chunk) => {
      totalBytes += chunk.length;
      if (totalBytes > 2 * 1024 * 1024) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('Invalid JSON request body'));
      }
    });
    req.on('error', reject);
  });
}

function getBaseUrl(req) {
  const proto = req.headers['x-forwarded-proto'] || 'http';
  const host = req.headers['x-forwarded-host'] || req.headers.host || 'localhost:3000';
  return `${proto}://${host}`;
}

function createApp({ store } = {}) {
  const gameStore = store || new GameStore();
  const publicDir = path.join(__dirname, '..', 'public');
  const failedAttempts = new Map();

  function getClientKey(req, token) {
    const ip =
      req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
      req.socket?.remoteAddress ||
      'local';
    return `${ip}:${token}`;
  }

  function isRateLimited(key) {
    const now = Date.now();
    const record = failedAttempts.get(key);
    if (!record) return false;
    if (now - record.windowStart > 60000) {
      failedAttempts.delete(key);
      return false;
    }
    return record.count >= 15;
  }

  function recordFailedAttempt(key) {
    const now = Date.now();
    const record = failedAttempts.get(key);
    if (!record || now - record.windowStart > 60000) {
      failedAttempts.set(key, { count: 1, windowStart: now });
    } else {
      record.count += 1;
    }
  }

  return async function handleRequest(req, res) {
    try {
      const baseUrl = getBaseUrl(req);
      const urlObj = new URL(req.url, baseUrl);
      const pathname = urlObj.pathname;
      const method = req.method.toUpperCase();

      // Static public files
      if (method === 'GET' && (pathname === '/' || pathname === '/admin')) {
        const html = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');
        return sendHtml(res, 200, html, {
          'Cache-Control': 'no-store, no-cache, must-revalidate',
        });
      }

      if (method === 'GET' && pathname.startsWith('/play/')) {
        const html = fs.readFileSync(path.join(publicDir, 'play.html'), 'utf8');
        return sendHtml(res, 200, html, {
          'Cache-Control': 'no-store, no-cache, must-revalidate',
          'X-Content-Type-Options': 'nosniff',
          'X-Frame-Options': 'DENY',
        });
      }

      if (method === 'GET' && /^\/(styles\.css|admin\.js|play\.js)$/.test(pathname)) {
        const filePath = path.join(publicDir, pathname.slice(1));
        if (fs.existsSync(filePath)) {
          const ext = path.extname(filePath);
          res.writeHead(200, {
            'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
            'Cache-Control': 'no-store, no-cache, must-revalidate',
          });
          res.end(fs.readFileSync(filePath));
          return;
        }
      }

      // ----------------- TICKETS API -----------------
      if (method === 'GET' && pathname === '/api/tickets') {
        return sendJson(res, 200, {
          decadeSets: DECADE_SETS,
          tickets: gameStore.getTickets(),
        });
      }

      if (method === 'POST' && pathname === '/api/tickets/generate') {
        const body = await readJsonBody(req);
        const count = Math.min(Math.max(Number(body.count || 1), 1), 200);
        const numbersPerTicket = Number(body.numbersPerTicket ?? 10);
        const perSetCheck = body.perSetCheck !== false;
        const selectedSets = Array.isArray(body.selectedSets) ? body.selectedSets : null;
        const excludedNumbers = Array.isArray(body.excludedNumbers) ? body.excludedNumbers : [];
        const playerNames = Array.isArray(body.playerNames) ? body.playerNames : [];

        const existingIds = new Set(gameStore.getTickets().map((t) => t.ticketId));
        const existingCodes = new Set(gameStore.getTickets().map((t) => t.secretCode));
        let seq = gameStore.state.nextTicketSeq;

        const created = [];
        for (let i = 0; i < count; i++) {
          const ticketId = generateTicketId(existingIds, seq++);
          existingIds.add(ticketId);

          const secretCode = generateSecretCode(existingCodes);
          existingCodes.add(secretCode);

          const numbers = generateTicketNumbers({
            count: numbersPerTicket,
            perSetCheck,
            selectedSets,
            excludedNumbers,
          });
          const check = validateTicketSetDistribution(numbers);

          const rawName = playerNames[i];
          const playerName =
            rawName && String(rawName).trim()
              ? String(rawName).trim()
              : `Player ${gameStore.getTickets().length + i + 1}`;

          created.push({
            ticketId,
            playerName,
            secretCode,
            numbers,
            usedNumbers: [],
            perSetCheck,
            setValidation: check,
            createdAt: new Date().toISOString(),
          });
        }

        gameStore.addTickets(created);
        return sendJson(res, 201, { tickets: created });
      }

      const ticketReduceMatch = pathname.match(/^\/api\/tickets\/([^/]+)\/reduce$/);
      if (method === 'PATCH' && ticketReduceMatch) {
        const ticketId = decodeURIComponent(ticketReduceMatch[1]);
        const ticket = gameStore.findTicketById(ticketId);
        if (!ticket) return sendJson(res, 404, { error: 'Ticket not found' });

        const body = await readJsonBody(req);
        const targetCount = Number(body.targetCount);
        if (!Number.isInteger(targetCount) || targetCount < 1 || targetCount >= ticket.numbers.length) {
          return sendJson(res, 400, {
            error: `targetCount must be an integer between 1 and ${ticket.numbers.length - 1}`,
          });
        }

        const available = ticket.numbers.filter((n) => !(ticket.usedNumbers || []).includes(n));
        if (available.length < targetCount) {
          return sendJson(res, 400, {
            error: `Ticket only has ${available.length} unused numbers available.`,
          });
        }

        const copy = [...available];
        for (let i = copy.length - 1; i > 0; i--) {
          const j = crypto.randomInt(0, i + 1);
          [copy[i], copy[j]] = [copy[j], copy[i]];
        }
        const reduced = copy.slice(0, targetCount).sort((a, b) => a - b);
        const updated = gameStore.updateTicket(ticket.ticketId, {
          numbers: reduced,
          setValidation: validateTicketSetDistribution(reduced),
        });
        return sendJson(res, 200, { ticket: updated });
      }

      const ticketHtmlMatch = pathname.match(/^\/api\/tickets\/([^/]+)\/html$/);
      if (method === 'GET' && ticketHtmlMatch) {
        const ticketId = decodeURIComponent(ticketHtmlMatch[1]);
        const ticket = gameStore.findTicketById(ticketId);
        if (!ticket) return sendJson(res, 404, { error: 'Ticket not found' });

        const activeSession = gameStore.getSessions().find((s) => s.status === 'ACTIVE');
        const activeSessionUrl = activeSession ? `${baseUrl}/play/${activeSession.token}` : '';
        const html = renderTicketHtml(ticket, { activeSessionUrl });
        const download = urlObj.searchParams.get('download') === '1';
        const headers = download
          ? { 'Content-Disposition': `attachment; filename="ticket-${ticket.ticketId}.html"` }
          : {};
        return sendHtml(res, 200, html, headers);
      }

      if (method === 'GET' && pathname === '/api/tickets/export/all.html') {
        const tickets = gameStore.getTickets();
        const activeSession = gameStore.getSessions().find((s) => s.status === 'ACTIVE');
        const activeSessionUrl = activeSession ? `${baseUrl}/play/${activeSession.token}` : '';
        const html = renderAllTicketsHtml(tickets, { activeSessionUrl });
        const download = urlObj.searchParams.get('download') === '1';
        const headers = download
          ? { 'Content-Disposition': 'attachment; filename="all-tickets.html"' }
          : {};
        return sendHtml(res, 200, html, headers);
      }

      if (method === 'GET' && pathname === '/api/tickets/export/zip') {
        const tickets = gameStore.getTickets();
        if (tickets.length === 0) {
          return sendJson(res, 400, { error: 'No tickets generated yet' });
        }
        const activeSession = gameStore.getSessions().find((s) => s.status === 'ACTIVE');
        const activeSessionUrl = activeSession ? `${baseUrl}/play/${activeSession.token}` : '';
        const files = tickets.map((t) => {
          const safeName = (t.playerName || 'player').replace(/[^a-zA-Z0-9_-]+/g, '_');
          return {
            name: `${t.ticketId}-${safeName}.html`,
            content: renderTicketHtml(t, { activeSessionUrl }),
          };
        });
        const zipBuf = buildZip(files);
        res.writeHead(200, {
          'Content-Type': 'application/zip',
          'Content-Disposition': 'attachment; filename="office-game-tickets.zip"',
          'Content-Length': zipBuf.length,
        });
        res.end(zipBuf);
        return;
      }

      const ticketDeleteMatch = pathname.match(/^\/api\/tickets\/([^/]+)$/);
      if (method === 'DELETE' && ticketDeleteMatch) {
        const ticketId = decodeURIComponent(ticketDeleteMatch[1]);
        const ok = gameStore.deleteTicket(ticketId);
        if (!ok) return sendJson(res, 404, { error: 'Ticket not found' });
        return sendJson(res, 200, { deleted: true });
      }

      // ----------------- SESSIONS API -----------------
      if (method === 'GET' && pathname === '/api/sessions') {
        const sessions = gameStore.getSessions().map((s) => ({
          ...s,
          playUrl: `${baseUrl}/play/${s.token}`,
          submissionCount: gameStore.getSubmissions(s.id).length,
        }));
        return sendJson(res, 200, { sessions });
      }

      if (method === 'POST' && pathname === '/api/sessions') {
        const body = await readJsonBody(req);
        const name = String(body.name || '').trim() || `Round ${gameStore.getSessions().length + 1}`;
        const consumeUsedNumbers = body.consumeUsedNumbers !== false;

        const session = {
          id: `SES-${crypto.randomBytes(4).toString('hex').toUpperCase()}`,
          name,
          token: generateSessionToken(),
          status: 'ACTIVE',
          consumeUsedNumbers,
          createdAt: new Date().toISOString(),
          expiredAt: null,
        };
        gameStore.addSession(session);
        return sendJson(res, 201, {
          session: {
            ...session,
            playUrl: `${baseUrl}/play/${session.token}`,
            submissionCount: 0,
          },
        });
      }

      const sessionExpireMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/expire$/);
      if (method === 'POST' && sessionExpireMatch) {
        const id = decodeURIComponent(sessionExpireMatch[1]);
        const updated = gameStore.updateSession(id, {
          status: 'EXPIRED',
          expiredAt: new Date().toISOString(),
        });
        if (!updated) return sendJson(res, 404, { error: 'Session not found' });
        return sendJson(res, 200, { session: updated });
      }

      const sessionReopenMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/reopen$/);
      if (method === 'POST' && sessionReopenMatch) {
        const id = decodeURIComponent(sessionReopenMatch[1]);
        const updated = gameStore.updateSession(id, {
          status: 'ACTIVE',
          expiredAt: null,
        });
        if (!updated) return sendJson(res, 404, { error: 'Session not found' });
        return sendJson(res, 200, { session: updated });
      }

      const sessionSubsMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/submissions$/);
      if (method === 'GET' && sessionSubsMatch) {
        const id = decodeURIComponent(sessionSubsMatch[1]);
        const session = gameStore.findSessionById(id);
        if (!session) return sendJson(res, 404, { error: 'Session not found' });
        return sendJson(res, 200, {
          session,
          submissions: gameStore.getSubmissions(id),
        });
      }

      const sessionEvalMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/evaluate$/);
      if (method === 'POST' && sessionEvalMatch) {
        const id = decodeURIComponent(sessionEvalMatch[1]);
        const session = gameStore.findSessionById(id);
        if (!session) return sendJson(res, 404, { error: 'Session not found' });
        if (session.status !== 'EXPIRED') {
          return sendJson(res, 400, {
            error: 'Session is still ACTIVE. Expire / close the session first to evaluate winners.',
          });
        }

        const body = await readJsonBody(req);
        const records = gameStore.getSubmissions(session.id);
        const result = evaluateWinners(records, body.mode, {
          min: body.min,
          max: body.max,
        });

        const pointsPerWin = Math.max(1, Number(body.pointsPerWin || 1));
        const saveToLeaderboard = body.saveToLeaderboard !== false;
        let roundResult = session.roundResult || null;

        if (saveToLeaderboard) {
          roundResult = {
            mode: result.mode,
            winningValue: result.winningValue,
            range: result.range,
            pointsPerWin,
            winnerTicketIds: result.winners.map((w) => w.ticketId),
            evaluatedAt: new Date().toISOString(),
          };
          gameStore.updateSession(session.id, { roundResult });
        }

        return sendJson(res, 200, {
          sessionId: session.id,
          sessionName: session.name,
          savedToLeaderboard: saveToLeaderboard,
          roundResult,
          ...result,
        });
      }

      // ----------------- LEADERBOARD API -----------------
      if (method === 'GET' && pathname === '/api/leaderboard') {
        return sendJson(res, 200, gameStore.getLeaderboard());
      }

      if (method === 'GET' && pathname === '/api/export/leaderboard.csv') {
        const csv = buildLeaderboardCsv(gameStore.getLeaderboard());
        res.writeHead(200, {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': 'attachment; filename="final-leaderboard.csv"',
        });
        res.end(csv);
        return;
      }

      if (method === 'GET' && pathname === '/api/export/leaderboard.xlsx') {
        const xlsx = buildLeaderboardXlsx(gameStore.getLeaderboard());
        res.writeHead(200, {
          'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          'Content-Disposition': 'attachment; filename="final-leaderboard.xlsx"',
          'Content-Length': xlsx.length,
        });
        res.end(xlsx);
        return;
      }

      if (method === 'GET' && pathname === '/api/health') {
        return sendJson(res, 200, {
          ok: true,
          features: ['reset', 'leaderboard', 'exports'],
        });
      }

      const sessionDeleteMatch = pathname.match(/^\/api\/sessions\/([^/]+)$/);
      if (method === 'DELETE' && sessionDeleteMatch) {
        const id = decodeURIComponent(sessionDeleteMatch[1]);
        const ok = gameStore.deleteSession(id);
        if (!ok) return sendJson(res, 404, { error: 'Session not found' });
        return sendJson(res, 200, { deleted: true });
      }

      if (method === 'POST' && pathname === '/api/reset') {
        gameStore.resetAll();
        failedAttempts.clear();
        return sendJson(res, 200, {
          reset: true,
          exportFiles: gameStore.exportFiles,
        });
      }

      // ----------------- SUBMISSIONS & CSV / EXCEL EXPORTS -----------------
      if (method === 'GET' && pathname === '/api/submissions') {
        const sessionId = urlObj.searchParams.get('sessionId') || null;
        return sendJson(res, 200, {
          submissions: gameStore.getSubmissions(sessionId),
          exportFiles: gameStore.exportFiles,
        });
      }

      if (method === 'GET' && pathname === '/api/export/submissions.csv') {
        const sessionId = urlObj.searchParams.get('sessionId') || null;
        const rows = gameStore.getSubmissions(sessionId);
        const csv = buildSubmissionsCsv(rows);
        const filename = sessionId ? `submissions-${sessionId}.csv` : 'all-submissions.csv';
        res.writeHead(200, {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="${filename}"`,
        });
        res.end(csv);
        return;
      }

      if (method === 'GET' && pathname === '/api/export/submissions.xlsx') {
        const sessionId = urlObj.searchParams.get('sessionId') || null;
        const rows = gameStore.getSubmissions(sessionId);
        const xlsx = buildSubmissionsXlsx(rows);
        const filename = sessionId ? `submissions-${sessionId}.xlsx` : 'all-submissions.xlsx';
        res.writeHead(200, {
          'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          'Content-Disposition': `attachment; filename="${filename}"`,
          'Content-Length': xlsx.length,
        });
        res.end(xlsx);
        return;
      }

      if (method === 'GET' && pathname === '/api/export/tickets.csv') {
        const csv = buildTicketsCsv(gameStore.getTickets());
        res.writeHead(200, {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': 'attachment; filename="tickets.csv"',
        });
        res.end(csv);
        return;
      }

      if (method === 'GET' && pathname === '/api/export/tickets.xlsx') {
        const xlsx = buildTicketsXlsx(gameStore.getTickets());
        res.writeHead(200, {
          'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          'Content-Disposition': 'attachment; filename="tickets.xlsx"',
          'Content-Length': xlsx.length,
        });
        res.end(xlsx);
        return;
      }

      // ----------------- PLAYER FORM API -----------------
      const playInfoMatch = pathname.match(/^\/api\/play\/([^/]+)$/);
      if (method === 'GET' && playInfoMatch) {
        const token = decodeURIComponent(playInfoMatch[1]);
        const session = gameStore.findSessionByToken(token);
        if (!session) {
          return sendJson(res, 404, { valid: false, active: false, error: 'Invalid session link' });
        }
        return sendJson(res, 200, {
          valid: true,
          active: session.status === 'ACTIVE',
          session: {
            id: session.id,
            name: session.name,
            status: session.status,
            consumeUsedNumbers: session.consumeUsedNumbers,
            createdAt: session.createdAt,
            expiredAt: session.expiredAt,
          },
        });
      }

      function resolveAndVerifyTicket(ticketIdInput, secretCodeInput) {
        const secret = String(secretCodeInput || '').trim().toUpperCase();
        const tid = String(ticketIdInput || '').trim().toUpperCase();
        if (!secret) {
          return { error: 'Secret code is required.', status: 400 };
        }

        let ticket = null;
        if (tid) {
          ticket = gameStore.findTicketById(tid);
          if (!ticket || ticket.secretCode.toUpperCase() !== secret) {
            return { error: 'Invalid Ticket ID or Secret Code.', status: 401 };
          }
        } else {
          ticket = gameStore.findTicketBySecret(secret);
          if (!ticket) {
            return { error: 'Invalid Secret Code.', status: 401 };
          }
        }
        return { ticket };
      }

      const playVerifyMatch = pathname.match(/^\/api\/play\/([^/]+)\/verify$/);
      if (method === 'POST' && playVerifyMatch) {
        const token = decodeURIComponent(playVerifyMatch[1]);
        const rateKey = getClientKey(req, token);
        if (isRateLimited(rateKey)) {
          return sendJson(res, 429, { error: 'Too many failed attempts. Please wait a minute and try again.' });
        }

        const session = gameStore.findSessionByToken(token);
        if (!session) return sendJson(res, 404, { error: 'Invalid session link' });
        if (session.status !== 'ACTIVE') {
          return sendJson(res, 403, { error: 'This session has expired / been closed by the admin.' });
        }

        const body = await readJsonBody(req);
        const resolved = resolveAndVerifyTicket(body.ticketId, body.secretCode);
        if (resolved.error) {
          recordFailedAttempt(rateKey);
          return sendJson(res, resolved.status, { error: resolved.error });
        }

        const { ticket } = resolved;
        const usedNumbers = gameStore.getTicketUsedNumbers(ticket.ticketId);
        const usedSet = new Set(usedNumbers);
        const availableNumbers = ticket.numbers.filter((n) => !usedSet.has(n));
        const existingSubmission = gameStore.findSubmission(session.id, ticket.ticketId);

        return sendJson(res, 200, {
          ticketId: ticket.ticketId,
          playerName: ticket.playerName,
          numbers: ticket.numbers,
          usedNumbers,
          availableNumbers,
          alreadySubmitted: Boolean(existingSubmission),
          existingSubmission,
        });
      }

      const playSubmitMatch = pathname.match(/^\/api\/play\/([^/]+)\/submit$/);
      if (method === 'POST' && playSubmitMatch) {
        const token = decodeURIComponent(playSubmitMatch[1]);
        const rateKey = getClientKey(req, token);
        if (isRateLimited(rateKey)) {
          return sendJson(res, 429, { error: 'Too many failed attempts. Please wait a minute and try again.' });
        }

        const session = gameStore.findSessionByToken(token);
        if (!session) return sendJson(res, 404, { error: 'Invalid session link' });
        if (session.status !== 'ACTIVE') {
          return sendJson(res, 403, { error: 'This session has expired / been closed by the admin.' });
        }

        const body = await readJsonBody(req);
        const resolved = resolveAndVerifyTicket(body.ticketId, body.secretCode);
        if (resolved.error) {
          recordFailedAttempt(rateKey);
          return sendJson(res, resolved.status, { error: resolved.error });
        }

        const { ticket } = resolved;
        const existing = gameStore.findSubmission(session.id, ticket.ticketId);
        if (existing) {
          return sendJson(res, 409, {
            error: `You already submitted number ${existing.selectedNumber} for this session.`,
            existingSubmission: existing,
          });
        }

        const selectedNumber = Number(body.selectedNumber);
        if (!Number.isInteger(selectedNumber) || selectedNumber < 1 || selectedNumber > 100 || !ticket.numbers.includes(selectedNumber)) {
          return sendJson(res, 400, {
            error: 'Selected number must be one of your allotted ticket numbers.',
          });
        }

        // Strict cross-round single-use check: once any number is used by a player, they cannot reuse it in any next round
        const usedNumbers = gameStore.getTicketUsedNumbers(ticket.ticketId);
        if (usedNumbers.includes(selectedNumber)) {
          return sendJson(res, 400, {
            error: `Number ${selectedNumber} was already used in an earlier round and cannot be reused.`,
          });
        }

        const submission = {
          id: `SUB-${crypto.randomBytes(5).toString('hex').toUpperCase()}`,
          sessionId: session.id,
          sessionName: session.name,
          sessionToken: session.token,
          ticketId: ticket.ticketId,
          playerName: ticket.playerName,
          selectedNumber,
          submittedAt: new Date().toISOString(),
        };

        gameStore.addSubmission(submission);

        const nextUsed = [...new Set([...usedNumbers, selectedNumber])];
        gameStore.updateTicket(ticket.ticketId, { usedNumbers: nextUsed });

        return sendJson(res, 201, { submission });
      }

      return sendJson(res, 404, { error: 'Not Found' });
    } catch (err) {
      return sendJson(res, 500, { error: err.message || 'Internal Server Error' });
    }
  };
}

if (require.main === module) {
  const port = Number(process.env.PORT || 3000);
  const app = createApp();
  const server = http.createServer(app);
  server.listen(port, () => {
    console.log(`Office Number Game server listening on http://localhost:${port}`);
  });
}

module.exports = {
  createApp,
};
