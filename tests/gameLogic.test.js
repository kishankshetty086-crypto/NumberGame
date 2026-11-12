const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { Readable } = require('node:stream');

const {
  generateTicketNumbers,
  validateTicketSetDistribution,
  evaluateWinners,
  getDecadeSetIndex,
  computeCombinedLeaderboard,
} = require('../src/gameLogic');
const { renderTicketHtml, buildZip } = require('../src/ticketHtml');
const {
  toCsv,
  toXlsxBuffer,
  buildLeaderboardCsv,
  buildLeaderboardXlsx,
} = require('../src/exportData');
const { GameStore, getRemoteKvConfig, getRemotePgConfig } = require('../src/store');
const { createApp } = require('../src/gameServer');

function invokeApp(app, method, reqPath, bodyObj = null, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const rawBody = bodyObj ? JSON.stringify(bodyObj) : '';
    const req = Readable.from(rawBody ? [Buffer.from(rawBody, 'utf8')] : []);
    req.method = method;
    req.url = reqPath;
    req.headers = {
      host: 'localhost:3000',
      'content-type': 'application/json',
      ...extraHeaders,
    };

    const chunks = [];
    let statusCode = 200;
    let headers = {};
    const res = {
      writeHead(code, hdrs = {}) {
        statusCode = code;
        headers = { ...headers, ...hdrs };
      },
      end(data) {
        if (data) chunks.push(Buffer.isBuffer(data) ? data : Buffer.from(String(data)));
        const buffer = Buffer.concat(chunks);
        const text = buffer.toString('utf8');
        let json = null;
        try {
          json = JSON.parse(text);
        } catch {
          json = null;
        }
        resolve({ status: statusCode, headers, buffer, text, json });
      },
    };

    app(req, res).catch(reject);
  });
}

test('generateTicketNumbers allots 10 numbers with strictly 1 per decade set (1-100)', () => {
  for (let run = 0; run < 25; run++) {
    const nums = generateTicketNumbers({ count: 10, perSetCheck: true });
    assert.equal(nums.length, 10);
    const check = validateTicketSetDistribution(nums);
    assert.equal(check.valid, true);
    assert.equal(check.setsCovered.length, 10);
    nums.forEach((n, idx) => {
      assert.equal(getDecadeSetIndex(n), idx);
    });
  }
});

test('generateTicketNumbers supports mid-round number reduction and exclusions', () => {
  const nums = generateTicketNumbers({
    count: 5,
    perSetCheck: true,
    selectedSets: [0, 2, 4, 6, 8],
    excludedNumbers: [1, 2, 3],
  });
  assert.equal(nums.length, 5);
  assert.ok(!nums.includes(1) && !nums.includes(2) && !nums.includes(3));
  assert.equal(validateTicketSetDistribution(nums).valid, true);
  nums.forEach((n) => {
    assert.ok([0, 2, 4, 6, 8].includes(getDecadeSetIndex(n)));
  });
});

test('validateTicketSetDistribution rejects two numbers in same decade set', () => {
  const check = validateTicketSetDistribution([3, 7, 15, 25]);
  assert.equal(check.valid, false);
  assert.equal(check.duplicatesInSet.length, 1);
  assert.equal(check.duplicatesInSet[0].set, '1-10');
});

test('evaluateWinners handles least, highest (including ties), and specific range', () => {
  const submissions = [
    { ticketId: 'T1', playerName: 'Alice', selectedNumber: 12 },
    { ticketId: 'T2', playerName: 'Bob', selectedNumber: 12 },
    { ticketId: 'T3', playerName: 'Charlie', selectedNumber: 45 },
    { ticketId: 'T4', playerName: 'Diana', selectedNumber: 88 },
    { ticketId: 'T5', playerName: 'Eve', selectedNumber: 88 },
  ];

  const leastRes = evaluateWinners(submissions, 'least');
  assert.equal(leastRes.winningValue, 12);
  assert.deepEqual(
    leastRes.winners.map((w) => w.playerName),
    ['Alice', 'Bob']
  );

  const highRes = evaluateWinners(submissions, 'highest');
  assert.equal(highRes.winningValue, 88);
  assert.deepEqual(
    highRes.winners.map((w) => w.playerName),
    ['Diana', 'Eve']
  );

  const rangeRes = evaluateWinners(submissions, 'range', { min: 15, max: 60 });
  assert.deepEqual(
    rangeRes.winners.map((w) => w.playerName),
    ['Charlie']
  );
});

test('renderTicketHtml, buildZip, toCsv, and toXlsxBuffer produce valid files', () => {
  const html = renderTicketHtml({
    ticketId: 'TKT-001-ABCD',
    playerName: 'Alice',
    secretCode: 'X9K4M2',
    numbers: [4, 15, 23, 38, 41, 56, 62, 77, 84, 99],
    usedNumbers: [15],
  });
  assert.ok(html.includes('TKT-001-ABCD'));
  assert.ok(html.includes('X9K4M2'));
  assert.ok(html.includes('USED'));

  const zipBuf = buildZip([{ name: 'ticket.html', content: html }]);
  assert.equal(zipBuf[0], 0x50); // 'P'
  assert.equal(zipBuf[1], 0x4b); // 'K'

  const csv = toCsv(['Name', 'Note'], [['Alice, Jr.', 'Said "Hi"']]);
  assert.ok(csv.includes('"Alice, Jr.","Said ""Hi"""'));

  const xlsx = toXlsxBuffer('Submissions', ['Player', 'Number'], [['Alice', 42]]);
  assert.equal(xlsx[0], 0x50); // 'P'
  assert.equal(xlsx[1], 0x4b); // 'K'
  assert.ok(xlsx.toString('utf8').includes('xl/worksheets/sheet1.xml'));
  // Extract and inflate xl/worksheets/sheet1.xml from the ZIP buffer
  let sheetXml = '';
  let off = 0;
  while (off + 30 <= xlsx.length && xlsx.readUInt32LE(off) === 0x04034b50) {
    const method = xlsx.readUInt16LE(off + 8);
    const compSize = xlsx.readUInt32LE(off + 18);
    const nLen = xlsx.readUInt16LE(off + 26);
    const xLen = xlsx.readUInt16LE(off + 28);
    const name = xlsx.slice(off + 30, off + 30 + nLen).toString('utf8');
    const payload = xlsx.slice(off + 30 + nLen + xLen, off + 30 + nLen + xLen + compSize);
    if (name === 'xl/worksheets/sheet1.xml') {
      sheetXml = (method === 8 ? zlib.inflateRawSync(payload) : payload).toString('utf8');
      break;
    }
    off += 30 + nLen + xLen + compSize;
  }
  assert.ok(sheetXml.includes('<v>42</v>'));
});

test('Full HTTP API workflow: tickets -> session -> secret code submit -> CSV/Excel storage -> expire -> winners', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'office-game-test-'));
  const dbPath = path.join(tmpDir, 'db.json');
  const store = new GameStore(dbPath);
  const rawApp = createApp({ store, adminPassword: 'test-admin-pass' });
  const app = (req, res) => {
    req.headers = { 'x-admin-password': 'test-admin-pass', ...(req.headers || {}) };
    return rawApp(req, res);
  };

  try {
    // 1. Generate 3 tickets (10 numbers each)
    const genResp = await invokeApp(app, 'POST', '/api/tickets/generate', {
      count: 3,
      playerNames: ['Alice', 'Bob', 'Charlie'],
      numbersPerTicket: 10,
      perSetCheck: true,
    });
    assert.equal(genResp.status, 201);
    const { tickets } = genResp.json;
    assert.equal(tickets.length, 3);
    tickets.forEach((t) => assert.equal(t.numbers.length, 10));

    // Verify HTML & ZIP endpoints serve valid content
    const htmlResp = await invokeApp(app, 'GET', `/api/tickets/${encodeURIComponent(tickets[0].ticketId)}/html`);
    assert.equal(htmlResp.status, 200);
    assert.ok(htmlResp.text.includes(tickets[0].secretCode));

    const zipResp = await invokeApp(app, 'GET', '/api/tickets/export/zip');
    assert.equal(zipResp.status, 200);
    assert.equal(zipResp.headers['Content-Type'], 'application/zip');

    // 2. Reduce Charlie's ticket to 6 numbers (mid-round adjustment)
    const reduceResp = await invokeApp(
      app,
      'PATCH',
      `/api/tickets/${encodeURIComponent(tickets[2].ticketId)}/reduce`,
      { targetCount: 6 }
    );
    assert.equal(reduceResp.status, 200);
    const { ticket: reducedCharlie } = reduceResp.json;
    assert.equal(reducedCharlie.numbers.length, 6);

    // 3. Create session
    const sesResp = await invokeApp(app, 'POST', '/api/sessions', { name: 'Round 1' });
    assert.equal(sesResp.status, 201);
    const { session } = sesResp.json;
    assert.equal(session.status, 'ACTIVE');

    // 4. Verify invalid secret code fails
    const badVerify = await invokeApp(app, 'POST', `/api/play/${session.token}/verify`, {
      ticketId: tickets[0].ticketId,
      secretCode: 'WRONG1',
    });
    assert.equal(badVerify.status, 401);

    // 5. Alice submits lowest allotted number; Bob submits highest allotted number
    const alicePick = tickets[0].numbers[0]; // from 1-10
    const bobPick = tickets[1].numbers[9]; // from 91-100

    const sub1 = await invokeApp(app, 'POST', `/api/play/${session.token}/submit`, {
      ticketId: tickets[0].ticketId,
      secretCode: tickets[0].secretCode,
      selectedNumber: alicePick,
    });
    assert.equal(sub1.status, 201);

    // Duplicate submission blocked
    const dupSub = await invokeApp(app, 'POST', `/api/play/${session.token}/submit`, {
      ticketId: tickets[0].ticketId,
      secretCode: tickets[0].secretCode,
      selectedNumber: tickets[0].numbers[1],
    });
    assert.equal(dupSub.status, 409);

    const sub2 = await invokeApp(app, 'POST', `/api/play/${session.token}/submit`, {
      ticketId: tickets[1].ticketId,
      secretCode: tickets[1].secretCode,
      selectedNumber: bobPick,
    });
    assert.equal(sub2.status, 201);

    // Verify stored CSV & Excel files on disk and via HTTP export endpoints
    assert.ok(fs.existsSync(path.join(tmpDir, 'submissions.csv')));
    assert.ok(fs.existsSync(path.join(tmpDir, 'submissions.xlsx')));
    assert.ok(fs.existsSync(path.join(tmpDir, 'tickets.csv')));
    assert.ok(fs.existsSync(path.join(tmpDir, 'tickets.xlsx')));

    const csvResp = await invokeApp(app, 'GET', `/api/export/submissions.csv?sessionId=${encodeURIComponent(session.id)}`);
    assert.equal(csvResp.status, 200);
    assert.ok(csvResp.headers['Content-Type'].includes('text/csv'));
    assert.ok(csvResp.text.includes('Alice'));
    assert.ok(csvResp.text.includes('Bob'));

    const xlsxResp = await invokeApp(app, 'GET', '/api/export/submissions.xlsx');
    assert.equal(xlsxResp.status, 200);
    assert.equal(xlsxResp.buffer[0], 0x50);
    assert.equal(xlsxResp.buffer[1], 0x4b);

    const tktCsvResp = await invokeApp(app, 'GET', '/api/export/tickets.csv');
    assert.equal(tktCsvResp.status, 200);
    assert.ok(tktCsvResp.text.includes('Charlie'));

    const tktXlsxResp = await invokeApp(app, 'GET', '/api/export/tickets.xlsx');
    assert.equal(tktXlsxResp.status, 200);
    assert.equal(tktXlsxResp.buffer[0], 0x50);

    // 6. Winner evaluation blocked while session is ACTIVE
    const earlyEval = await invokeApp(app, 'POST', `/api/sessions/${session.id}/evaluate`, {
      mode: 'least',
    });
    assert.equal(earlyEval.status, 400);

    // 7. Expire session -> verify player submission blocked -> evaluate winners
    const expResp = await invokeApp(app, 'POST', `/api/sessions/${session.id}/expire`);
    assert.equal(expResp.status, 200);

    const closedSubmit = await invokeApp(app, 'POST', `/api/play/${session.token}/submit`, {
      ticketId: reducedCharlie.ticketId,
      secretCode: reducedCharlie.secretCode,
      selectedNumber: reducedCharlie.numbers[0],
    });
    assert.equal(closedSubmit.status, 403);

    const leastEval = await invokeApp(app, 'POST', `/api/sessions/${session.id}/evaluate`, {
      mode: 'least',
    });
    assert.equal(leastEval.status, 200);
    assert.equal(leastEval.json.winners[0].playerName, 'Alice');
    assert.equal(leastEval.json.winners[0].selectedNumber, alicePick);

    const highEval = await invokeApp(app, 'POST', `/api/sessions/${session.id}/evaluate`, {
      mode: 'highest',
      saveToLeaderboard: false,
    });
    assert.equal(highEval.status, 200);
    assert.equal(highEval.json.winners[0].playerName, 'Bob');
    assert.equal(highEval.json.winners[0].selectedNumber, bobPick);

    const rangeEval = await invokeApp(app, 'POST', `/api/sessions/${session.id}/evaluate`, {
      mode: 'range',
      min: 1,
      max: 15,
      saveToLeaderboard: false,
    });
    assert.equal(rangeEval.status, 200);
    assert.equal(rangeEval.json.winners.length, 1);
    assert.equal(rangeEval.json.winners[0].playerName, 'Alice');

    // 8. Round 2: enforce single-use across rounds & test Combined Final Leaderboard
    const ses2Resp = await invokeApp(app, 'POST', '/api/sessions', { name: 'Round 2' });
    assert.equal(ses2Resp.status, 201);
    const session2 = ses2Resp.json.session;

    // Player HTML page has anti-frame/no-cache security headers
    const playHtmlResp = await invokeApp(app, 'GET', `/play/${session2.token}`);
    assert.equal(playHtmlResp.status, 200);
    assert.equal(playHtmlResp.headers['X-Frame-Options'], 'DENY');

    // Verify Alice sees alicePick as already used
    const verifyAliceR2 = await invokeApp(app, 'POST', `/api/play/${session2.token}/verify`, {
      ticketId: tickets[0].ticketId,
      secretCode: tickets[0].secretCode,
    });
    assert.equal(verifyAliceR2.status, 200);
    assert.ok(verifyAliceR2.json.usedNumbers.includes(alicePick));
    assert.ok(!verifyAliceR2.json.availableNumbers.includes(alicePick));

    // Attempting to reuse alicePick in Round 2 is blocked
    const reuseAttempt = await invokeApp(app, 'POST', `/api/play/${session2.token}/submit`, {
      ticketId: tickets[0].ticketId,
      secretCode: tickets[0].secretCode,
      selectedNumber: alicePick,
    });
    assert.equal(reuseAttempt.status, 400);

    // Attempting to submit a number not on Alice's ticket is blocked
    const nonTicketNum = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].find((n) => !tickets[0].numbers.includes(n));
    const forgeAttempt = await invokeApp(app, 'POST', `/api/play/${session2.token}/submit`, {
      ticketId: tickets[0].ticketId,
      secretCode: tickets[0].secretCode,
      selectedNumber: nonTicketNum,
    });
    assert.equal(forgeAttempt.status, 400);

    // Alice submits her highest number (91-100); Bob submits his lowest number (1-10)
    const aliceR2Pick = tickets[0].numbers[9];
    const bobR2Pick = tickets[1].numbers[0];
    const r2Sub1 = await invokeApp(app, 'POST', `/api/play/${session2.token}/submit`, {
      ticketId: tickets[0].ticketId,
      secretCode: tickets[0].secretCode,
      selectedNumber: aliceR2Pick,
    });
    assert.equal(r2Sub1.status, 201);

    const r2Sub2 = await invokeApp(app, 'POST', `/api/play/${session2.token}/submit`, {
      ticketId: tickets[1].ticketId,
      secretCode: tickets[1].secretCode,
      selectedNumber: bobR2Pick,
    });
    assert.equal(r2Sub2.status, 201);

    // Expire Round 2 and evaluate 'highest' -> Alice wins Round 2 as well (2 wins total!)
    await invokeApp(app, 'POST', `/api/sessions/${session2.id}/expire`);
    const r2Eval = await invokeApp(app, 'POST', `/api/sessions/${session2.id}/evaluate`, {
      mode: 'highest',
      pointsPerWin: 2,
    });
    assert.equal(r2Eval.status, 200);
    assert.equal(r2Eval.json.winners[0].playerName, 'Alice');

    // Combined Final Leaderboard check
    const lbResp = await invokeApp(app, 'GET', '/api/leaderboard');
    assert.equal(lbResp.status, 200);
    assert.equal(lbResp.json.totalRounds, 2);
    assert.equal(lbResp.json.evaluatedRoundsCount, 2);
    assert.equal(lbResp.json.grandWinners.length, 1);
    assert.equal(lbResp.json.grandWinners[0].playerName, 'Alice');
    assert.equal(lbResp.json.grandWinners[0].totalWins, 2);
    assert.equal(lbResp.json.grandWinners[0].totalPoints, 3); // 1 pt Round 1 + 2 pts Round 2
    assert.equal(lbResp.json.grandWinners[0].roundsPlayed, 2);

    // Leaderboard CSV & Excel export checks
    const lbCsvResp = await invokeApp(app, 'GET', '/api/export/leaderboard.csv');
    assert.equal(lbCsvResp.status, 200);
    assert.ok(lbCsvResp.text.includes('Alice'));
    assert.ok(lbCsvResp.text.includes('Round 1'));
    assert.ok(lbCsvResp.text.includes('Round 2'));

    const lbXlsxResp = await invokeApp(app, 'GET', '/api/export/leaderboard.xlsx');
    assert.equal(lbXlsxResp.status, 200);
    assert.equal(lbXlsxResp.buffer[0], 0x50);
    assert.equal(lbXlsxResp.buffer[1], 0x4b);

    // 9. Rate limiting check after 15 failed secret-code attempts on an active session
    const ses3Resp = await invokeApp(app, 'POST', '/api/sessions', { name: 'Round 3' });
    const session3 = ses3Resp.json.session;
    for (let i = 0; i < 15; i++) {
      const fail = await invokeApp(app, 'POST', `/api/play/${session3.token}/verify`, {
        secretCode: 'BAD999',
      });
      assert.equal(fail.status, 401);
    }
    const blocked = await invokeApp(app, 'POST', `/api/play/${session3.token}/verify`, {
      secretCode: tickets[0].secretCode,
    });
    assert.equal(blocked.status, 429);

    // 10. Clear cache / reset all data to start from scratch
    const resetResp = await invokeApp(app, 'POST', '/api/reset');
    assert.equal(resetResp.status, 200);
    assert.equal(resetResp.json.reset, true);

    const afterTickets = await invokeApp(app, 'GET', '/api/tickets');
    assert.equal(afterTickets.json.tickets.length, 0);
    const afterSessions = await invokeApp(app, 'GET', '/api/sessions');
    assert.equal(afterSessions.json.sessions.length, 0);
    const afterSubs = await invokeApp(app, 'GET', '/api/submissions');
    assert.equal(afterSubs.json.submissions.length, 0);
    const afterLb = await invokeApp(app, 'GET', '/api/leaderboard');
    assert.equal(afterLb.json.leaderboard.length, 0);
    assert.equal(afterLb.json.totalRounds, 0);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Vercel serverless handler (api/index.js) serves GET / and enforces admin auth', async () => {
  const prevVercel = process.env.VERCEL;
  const prevAdminPw = process.env.ADMIN_PASSWORD;
  process.env.VERCEL = '1';
  process.env.ADMIN_PASSWORD = 'vercel-admin-secret';
  try {
    const handler = require('../api/index');
    const getResp = await invokeApp(handler, 'GET', '/');
    assert.equal(getResp.status, 200);
    assert.ok(getResp.text.includes('Office Number Game'));

    // Unauthenticated callers must get 401 on admin APIs and never see secret codes
    const unauthState = await invokeApp(handler, 'GET', '/api/index.js?__route=/api/state');
    assert.equal(unauthState.status, 401);
    const unauthTickets = await invokeApp(handler, 'GET', '/api/tickets');
    assert.equal(unauthTickets.status, 401);

    // Verify Vercel rewrite preserving path via __route query parameter
    const rewrittenHealth = await invokeApp(handler, 'GET', '/api/index.js?__route=/api/health');
    assert.equal(rewrittenHealth.status, 200);
    assert.equal(JSON.parse(rewrittenHealth.text).ok, true);

    const stateResp = await invokeApp(handler, 'GET', '/api/index.js?__route=/api/state', null, {
      'x-admin-password': 'vercel-admin-secret',
    });
    assert.equal(stateResp.status, 200);
    const stateBody = JSON.parse(stateResp.text);
    assert.equal(stateBody.ok, true);
    assert.equal(stateBody.storage.mode, 'tmp-ephemeral');
    assert.equal(stateBody.storage.persistent, false);

    // Simulate Vercel pre-parsed req.body on POST /api/sessions
    const req = Readable.from([]);
    req.method = 'POST';
    req.url = '/api/sessions';
    req.headers = {
      host: 'number-game-nine-phi.vercel.app',
      'x-forwarded-proto': 'https,http',
      'content-type': 'application/json',
      'x-admin-password': 'vercel-admin-secret',
    };
    req.body = { name: 'Vercel Test Round' };

    const chunks = [];
    let statusCode = 200;
    const res = {
      writeHead(code) {
        statusCode = code;
      },
      end(data) {
        if (data) chunks.push(Buffer.isBuffer(data) ? data : Buffer.from(String(data)));
      },
    };
    await handler(req, res);
    assert.equal(statusCode, 201);
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    assert.equal(parsed.session.name, 'Vercel Test Round');
    assert.ok(parsed.session.playUrl.startsWith('https://number-game-nine-phi.vercel.app/play/'));

    // Clean up test session
    await invokeApp(handler, 'POST', '/api/reset', null, {
      'x-admin-password': 'vercel-admin-secret',
    });
  } finally {
    if (prevVercel === undefined) delete process.env.VERCEL;
    else process.env.VERCEL = prevVercel;
    if (prevAdminPw === undefined) delete process.env.ADMIN_PASSWORD;
    else process.env.ADMIN_PASSWORD = prevAdminPw;
  }
});

test('Remote KV/Redis pipeline shares sessions and concurrent submissions across instances', async () => {
  const strings = new Map();
  const hashes = new Map();
  const prevFetch = globalThis.fetch;

  function execCmd(cmd) {
    const op = cmd[0];
    const key = cmd[1];
    if (op === 'GET') return { result: strings.get(key) ?? null };
    if (op === 'SET') {
      strings.set(key, cmd[2]);
      return { result: 'OK' };
    }
    if (op === 'HSET') {
      if (!hashes.has(key)) hashes.set(key, new Map());
      const map = hashes.get(key);
      for (let i = 2; i < cmd.length; i += 2) {
        map.set(cmd[i], cmd[i + 1]);
      }
      return { result: 1 };
    }
    if (op === 'HSETNX') {
      if (!hashes.has(key)) hashes.set(key, new Map());
      const map = hashes.get(key);
      if (map.has(cmd[2])) return { result: 0 };
      map.set(cmd[2], cmd[3]);
      return { result: 1 };
    }
    if (op === 'HDEL') {
      const map = hashes.get(key);
      let count = 0;
      if (map) {
        for (let i = 2; i < cmd.length; i++) {
          if (map.delete(cmd[i])) count++;
        }
      }
      return { result: count };
    }
    if (op === 'HGETALL') {
      const map = hashes.get(key);
      if (!map) return { result: [] };
      const out = [];
      for (const [f, v] of map.entries()) out.push(f, v);
      return { result: out };
    }
    if (op === 'DEL') {
      for (let i = 1; i < cmd.length; i++) {
        strings.delete(cmd[i]);
        hashes.delete(cmd[i]);
      }
      return { result: 1 };
    }
    throw new Error(`Unexpected command: ${op}`);
  }

  globalThis.fetch = async (url, opts = {}) => {
    assert.ok(String(url).endsWith('/pipeline'));
    const cmds = JSON.parse(opts.body);
    return {
      ok: true,
      status: 200,
      async json() {
        return cmds.map(execCmd);
      },
    };
  };

  const prefixedCfg = getRemoteKvConfig({
    GAME_KV_REST_API_URL: 'https://prefixed.upstash.io/',
    GAME_KV_REST_API_TOKEN: 'secret-tok',
  });
  assert.equal(prefixedCfg.url, 'https://prefixed.upstash.io');
  assert.equal(prefixedCfg.token, 'secret-tok');

  const dir1 = fs.mkdtempSync(path.join(os.tmpdir(), 'ong-kv-1-'));
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'ong-kv-2-'));
  try {
    const remoteKv = { url: 'https://kv.example.test', token: 'tok', key: 'test_game_state' };
    const kvPass = 'kv-admin-pass';
    const rawApp1 = createApp({
      store: new GameStore(path.join(dir1, 'db.json'), { remoteKv }),
      adminPassword: kvPass,
    });
    const app1 = (req, res) => {
      req.headers = { 'x-admin-password': kvPass, ...(req.headers || {}) };
      return rawApp1(req, res);
    };
    const app2 = createApp({
      store: new GameStore(path.join(dir2, 'db.json'), { remoteKv }),
      adminPassword: kvPass,
    });

    const tickets = await invokeApp(app1, 'POST', '/api/tickets/generate', {
      count: 2,
      playerNames: ['Alice', 'Bob'],
    });
    assert.equal(tickets.status, 201);

    const created = await invokeApp(app1, 'POST', '/api/sessions', { name: "Kishan's Round 1" });
    assert.equal(created.status, 201);
    const token = created.json.session.token;

    // Second completely separate instance must see both tickets and the created session
    const playInfo = await invokeApp(app2, 'GET', `/api/play/${token}`);
    assert.equal(playInfo.status, 200);
    assert.equal(playInfo.json.valid, true);
    assert.equal(playInfo.json.session.name, "Kishan's Round 1");

    // Two players submit across two different instances without overwriting each other
    const [t1, t2] = tickets.json.tickets;
    const sub1 = await invokeApp(app1, 'POST', `/api/play/${token}/submit`, {
      ticketId: t1.ticketId,
      secretCode: t1.secretCode,
      selectedNumber: t1.numbers[0],
    });
    const sub2 = await invokeApp(app2, 'POST', `/api/play/${token}/submit`, {
      ticketId: t2.ticketId,
      secretCode: t2.secretCode,
      selectedNumber: t2.numbers[0],
    });
    assert.equal(sub1.status, 201);
    assert.equal(sub2.status, 201);

    const stateOnApp1 = await invokeApp(app1, 'GET', '/api/state');
    assert.equal(stateOnApp1.json.storage.mode, 'redis');
    assert.equal(stateOnApp1.json.storage.persistent, true);
    assert.equal(stateOnApp1.json.sessions.length, 1);
    assert.equal(stateOnApp1.json.submissions.length, 2);
  } finally {
    globalThis.fetch = prevFetch;
    fs.rmSync(dir1, { recursive: true, force: true });
    fs.rmSync(dir2, { recursive: true, force: true });
  }
});

test('Multi-instance Postgres mode preserves shared state and enforces atomic double-submit', async () => {
  const pgCfg = getRemotePgConfig({
    POSTGRES_URL: 'postgres://user:pass@db.supabase.co:6543/postgres?sslmode=require',
  });
  assert.ok(pgCfg && pgCfg.url.includes('db.supabase.co'));

  const tables = {
    meta: new Map(),
    tickets: new Map(),
    sessions: new Map(),
    submissions: new Map(),
  };

  function createFakePgPool() {
    const query = async (sql, params = []) => {
      const normalized = sql.replace(/\s+/g, ' ').trim();
      if (normalized.startsWith('BEGIN') || normalized.startsWith('COMMIT') || normalized.startsWith('ROLLBACK')) {
        return { rows: [], rowCount: 0 };
      }
      if (normalized.includes('CREATE TABLE IF NOT EXISTS')) {
        return { rows: [], rowCount: 0 };
      }
      if (normalized.startsWith('SELECT key, value FROM ng_meta')) {
        const rows = [];
        for (const [k, v] of tables.meta.entries()) {
          if (k === 'seq' || k === 'auth') rows.push({ key: k, value: v });
        }
        return { rows, rowCount: rows.length };
      }
      if (normalized.startsWith('SELECT data FROM ng_tickets')) {
        const rows = [...tables.tickets.values()]
          .sort((a, b) => a.position - b.position || a.ticketId.localeCompare(b.ticketId))
          .map((r) => ({ data: r.data }));
        return { rows, rowCount: rows.length };
      }
      if (normalized.startsWith('SELECT data FROM ng_sessions')) {
        const rows = [...tables.sessions.values()]
          .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
          .map((r) => ({ data: r.data }));
        return { rows, rowCount: rows.length };
      }
      if (normalized.startsWith('SELECT data FROM ng_submissions')) {
        const rows = [...tables.submissions.values()]
          .sort((a, b) => new Date(a.submittedAt).getTime() - new Date(b.submittedAt).getTime())
          .map((r) => ({ data: r.data }));
        return { rows, rowCount: rows.length };
      }
      if (normalized.startsWith("INSERT INTO ng_meta (key, value) VALUES ('auth'")) {
        tables.meta.set('auth', JSON.parse(params[0]));
        return { rows: [], rowCount: 1 };
      }
      if (normalized.startsWith("INSERT INTO ng_meta (key, value) VALUES ('seq'")) {
        tables.meta.set('seq', JSON.parse(params[0]));
        return { rows: [], rowCount: 1 };
      }
      if (normalized.includes('INSERT INTO ng_tickets (ticket_id, position, data) SELECT * FROM UNNEST')) {
        const [ids, positions, payloads] = params;
        for (let i = 0; i < ids.length; i += 1) {
          tables.tickets.set(ids[i], {
            ticketId: ids[i],
            position: Number(positions[i]),
            data: JSON.parse(payloads[i]),
          });
        }
        return { rows: [], rowCount: ids.length };
      }
      if (normalized.startsWith('INSERT INTO ng_tickets (ticket_id, position, data) VALUES')) {
        const prev = tables.tickets.get(params[0]);
        tables.tickets.set(params[0], {
          ticketId: params[0],
          position: prev ? prev.position : Number(params[1] || 0),
          data: JSON.parse(params[1]),
        });
        return { rows: [], rowCount: 1 };
      }
      if (normalized.startsWith('INSERT INTO ng_sessions')) {
        tables.sessions.set(params[0], {
          id: params[0],
          createdAt: params[1],
          data: JSON.parse(params[2]),
        });
        return { rows: [], rowCount: 1 };
      }
      if (normalized.includes('ON CONFLICT (session_id, ticket_id) DO NOTHING RETURNING session_id')) {
        const key = `${params[0]}:${params[1]}`;
        if (tables.submissions.has(key)) {
          return { rows: [], rowCount: 0 };
        }
        tables.submissions.set(key, {
          sessionId: params[0],
          ticketId: params[1],
          submittedAt: params[2],
          data: JSON.parse(params[3]),
        });
        return { rows: [{ session_id: params[0] }], rowCount: 1 };
      }
      if (normalized.startsWith('UPDATE ng_tickets SET data = jsonb_set')) {
        const existing = tables.tickets.get(params[0]);
        if (existing) {
          const used = new Set(existing.data.usedNumbers || []);
          used.add(Number(params[1]));
          existing.data = { ...existing.data, usedNumbers: [...used] };
        }
        return { rows: [], rowCount: 1 };
      }
      if (normalized.startsWith('DELETE FROM ng_submissions WHERE UPPER(ticket_id)')) {
        for (const [k, v] of tables.submissions.entries()) {
          if (v.ticketId.toUpperCase() === String(params[0]).toUpperCase()) tables.submissions.delete(k);
        }
        return { rows: [], rowCount: 1 };
      }
      if (normalized.startsWith('DELETE FROM ng_tickets WHERE UPPER(ticket_id)')) {
        for (const k of tables.tickets.keys()) {
          if (k.toUpperCase() === String(params[0]).toUpperCase()) tables.tickets.delete(k);
        }
        return { rows: [], rowCount: 1 };
      }
      if (normalized.startsWith('DELETE FROM ng_submissions')) {
        tables.submissions.clear();
        return { rows: [], rowCount: 1 };
      }
      if (normalized.startsWith('DELETE FROM ng_sessions')) {
        tables.sessions.clear();
        return { rows: [], rowCount: 1 };
      }
      if (normalized.startsWith('DELETE FROM ng_tickets')) {
        tables.tickets.clear();
        return { rows: [], rowCount: 1 };
      }
      if (normalized.startsWith("DELETE FROM ng_meta WHERE key = 'seq'")) {
        tables.meta.delete('seq');
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`Unhandled mock SQL query: ${normalized}`);
    };

    return {
      query,
      async connect() {
        return { query, release() {} };
      },
    };
  }

  const dir1 = fs.mkdtempSync(path.join(os.tmpdir(), 'ong-pg-1-'));
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'ong-pg-2-'));
  try {
    const pgPool = createFakePgPool();
    const pgPass = 'pg-admin-secret';
    const remotePg = { url: 'postgres://fake:fake@localhost:5432/postgres' };
    const rawApp1 = createApp({
      store: new GameStore(path.join(dir1, 'db.json'), { remoteKv: null, remotePg, pgPool }),
      adminPassword: pgPass,
    });
    const app1 = (req, res) => {
      req.headers = { 'x-admin-password': pgPass, ...(req.headers || {}) };
      return rawApp1(req, res);
    };
    const app2 = createApp({
      store: new GameStore(path.join(dir2, 'db.json'), { remoteKv: null, remotePg, pgPool }),
      adminPassword: pgPass,
    });

    const tickets = await invokeApp(app1, 'POST', '/api/tickets/generate', {
      count: 2,
      playerNames: ['Alice', 'Bob'],
    });
    assert.equal(tickets.status, 201);

    const created = await invokeApp(app1, 'POST', '/api/sessions', { name: 'PG Round 1' });
    assert.equal(created.status, 201);
    const token = created.json.session.token;

    // App2 sees ticket + session across instances
    const playInfo = await invokeApp(app2, 'GET', `/api/play/${token}`);
    assert.equal(playInfo.status, 200);
    assert.equal(playInfo.json.valid, true);

    // Simultaneous double-submit for same ticket hits 201 + 409 across different instances
    const t1 = tickets.json.tickets[0];
    const [race1, race2] = await Promise.all([
      invokeApp(app1, 'POST', `/api/play/${token}/submit`, {
        ticketId: t1.ticketId,
        secretCode: t1.secretCode,
        selectedNumber: t1.numbers[0],
      }),
      invokeApp(app2, 'POST', `/api/play/${token}/submit`, {
        ticketId: t1.ticketId,
        secretCode: t1.secretCode,
        selectedNumber: t1.numbers[0],
      }),
    ]);
    const codes = [race1.status, race2.status].sort((a, b) => a - b);
    assert.deepEqual(codes, [201, 409]);

    const stateOnApp2 = await invokeApp(rawApp1, 'GET', '/api/state', null, {
      'x-admin-password': pgPass,
    });
    assert.equal(stateOnApp2.json.storage.mode, 'postgres');
    assert.equal(stateOnApp2.json.storage.persistent, true);
    assert.equal(stateOnApp2.json.submissions.length, 1);
    assert.ok(stateOnApp2.json.tickets[0].usedNumbers.includes(t1.numbers[0]));
  } finally {
    fs.rmSync(dir1, { recursive: true, force: true });
    fs.rmSync(dir2, { recursive: true, force: true });
  }
});

test('Final leaderboard splits tied round prize points equally (including decimals) and aligns grandWinners with Rank #1', () => {
  const tickets = [
    { ticketId: 'T-01', playerName: 'Alice', numbers: [10, 20], usedNumbers: [] },
    { ticketId: 'T-02', playerName: 'Bob', numbers: [10, 20], usedNumbers: [] },
    { ticketId: 'T-03', playerName: 'Charlie', numbers: [10, 20], usedNumbers: [] },
    { ticketId: 'T-04', playerName: 'Dave', numbers: [10, 20], usedNumbers: [] },
    { ticketId: 'T-05', playerName: 'Eve', numbers: [10, 20], usedNumbers: [] },
  ];

  // Round 1: 100 pts shared across 3 winners -> 33.33 each
  // Round 2: 100 pts shared across 4 winners -> 25 each
  // Round 3: 100 pts shared across 5 winners -> 20 each
  // Suppose Alice wins Round 1 (33.33) + Round 2 (25) = 58.33 (2 wins)
  // And in Round 4 (sole win 58.33 -> 1 win): even if tied at exact 58.33 pts, Alice has 2 wins (Rank #1) while sole-round winner has 1 win (Rank #2)
  const sessions = [
    {
      id: 'S1',
      name: 'R1 (3-way tie)',
      status: 'EXPIRED',
      createdAt: '2026-01-01T00:00:00Z',
      roundResult: {
        mode: 'least',
        pointsPerWin: 100,
        winnerTicketIds: ['T-01', 'T-02', 'T-03'],
      },
    },
    {
      id: 'S2',
      name: 'R2 (4-way tie)',
      status: 'EXPIRED',
      createdAt: '2026-01-02T00:00:00Z',
      roundResult: {
        mode: 'highest',
        pointsPerWin: 100,
        winnerTicketIds: ['T-01', 'T-02', 'T-03', 'T-04'],
      },
    },
    {
      id: 'S3',
      name: 'R3 (5-way tie)',
      status: 'EXPIRED',
      createdAt: '2026-01-03T00:00:00Z',
      roundResult: {
        mode: 'range',
        pointsPerWin: 100,
        winnerTicketIds: ['T-01', 'T-02', 'T-03', 'T-04', 'T-05'],
      },
    },
  ];
  const submissions = [
    { sessionId: 'S1', ticketId: 'T-01', selectedNumber: 10 },
    { sessionId: 'S1', ticketId: 'T-02', selectedNumber: 10 },
    { sessionId: 'S1', ticketId: 'T-03', selectedNumber: 10 },
    { sessionId: 'S2', ticketId: 'T-01', selectedNumber: 20 },
    { sessionId: 'S2', ticketId: 'T-02', selectedNumber: 20 },
    { sessionId: 'S2', ticketId: 'T-03', selectedNumber: 20 },
    { sessionId: 'S2', ticketId: 'T-04', selectedNumber: 20 },
    { sessionId: 'S3', ticketId: 'T-01', selectedNumber: 10 },
    { sessionId: 'S3', ticketId: 'T-02', selectedNumber: 10 },
    { sessionId: 'S3', ticketId: 'T-03', selectedNumber: 10 },
    { sessionId: 'S3', ticketId: 'T-04', selectedNumber: 10 },
    { sessionId: 'S3', ticketId: 'T-05', selectedNumber: 10 },
  ];

  const lb = computeCombinedLeaderboard(tickets, sessions, submissions);
  assert.equal(lb.rounds[0].pointsPerWinner, 33.33);
  assert.equal(lb.rounds[1].pointsPerWinner, 25);
  assert.equal(lb.rounds[2].pointsPerWinner, 20);

  // Alice, Bob, Charlie each earned 33.33 + 25 + 20 = 78.33 across 3 wins -> all tied Rank #1
  assert.equal(lb.leaderboard[0].totalPoints, 78.33);
  assert.equal(lb.leaderboard[1].totalPoints, 78.33);
  assert.equal(lb.leaderboard[2].totalPoints, 78.33);
  assert.equal(lb.leaderboard[3].totalPoints, 45); // Dave: 25 + 20
  assert.equal(lb.leaderboard[4].totalPoints, 20); // Eve: 20
  assert.equal(lb.grandWinners.length, 3);
  assert.ok(lb.grandWinners.every((gw) => gw.rank === 1));

  // CSV & XLSX exports preserve decimal points
  const csv = buildLeaderboardCsv(lb);
  assert.ok(csv.includes('78.33'));
  assert.ok(csv.includes('+33.33'));
  const xlsx = buildLeaderboardXlsx(lb);
  assert.ok(Buffer.isBuffer(xlsx) && xlsx.length > 0);

  // Tie on totalPoints with DIFFERENT round wins -> only Rank #1 appears in grandWinners
  const tieByWinsLb = computeCombinedLeaderboard(
    [
      { ticketId: 'A', playerName: 'Alice', numbers: [10], usedNumbers: [] },
      { ticketId: 'B', playerName: 'Bob', numbers: [20], usedNumbers: [] },
    ],
    [
      {
        id: 'R1',
        name: 'R1',
        status: 'EXPIRED',
        createdAt: '2026-01-01T00:00:00Z',
        roundResult: { mode: 'least', pointsPerWin: 50, winnerTicketIds: ['A'] },
      },
      {
        id: 'R2',
        name: 'R2',
        status: 'EXPIRED',
        createdAt: '2026-01-02T00:00:00Z',
        roundResult: { mode: 'least', pointsPerWin: 50, winnerTicketIds: ['A'] },
      },
      {
        id: 'R3',
        name: 'R3',
        status: 'EXPIRED',
        createdAt: '2026-01-03T00:00:00Z',
        roundResult: { mode: 'highest', pointsPerWin: 100, winnerTicketIds: ['B'] },
      },
    ],
    []
  );
  assert.equal(tieByWinsLb.leaderboard[0].playerName, 'Alice');
  assert.equal(tieByWinsLb.leaderboard[0].totalPoints, 100);
  assert.equal(tieByWinsLb.leaderboard[0].totalWins, 2);
  assert.equal(tieByWinsLb.leaderboard[0].rank, 1);
  assert.equal(tieByWinsLb.leaderboard[1].playerName, 'Bob');
  assert.equal(tieByWinsLb.leaderboard[1].totalPoints, 100);
  assert.equal(tieByWinsLb.leaderboard[1].totalWins, 1);
  assert.equal(tieByWinsLb.leaderboard[1].rank, 2);
  assert.equal(tieByWinsLb.grandWinners.length, 1);
  assert.equal(tieByWinsLb.grandWinners[0].playerName, 'Alice');
});
