const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');

const {
  generateTicketNumbers,
  validateTicketSetDistribution,
  evaluateWinners,
  getDecadeSetIndex,
} = require('../src/gameLogic');
const { renderTicketHtml, buildZip } = require('../src/ticketHtml');
const { toCsv, toXlsxBuffer } = require('../src/exportData');
const { GameStore } = require('../src/store');
const { createApp } = require('../src/gameServer');

function invokeApp(app, method, reqPath, bodyObj = null) {
  return new Promise((resolve, reject) => {
    const rawBody = bodyObj ? JSON.stringify(bodyObj) : '';
    const req = Readable.from(rawBody ? [Buffer.from(rawBody, 'utf8')] : []);
    req.method = method;
    req.url = reqPath;
    req.headers = {
      host: 'localhost:3000',
      'content-type': 'application/json',
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
  assert.ok(xlsx.toString('utf8').includes('<v>42</v>'));
});

test('Full HTTP API workflow: tickets -> session -> secret code submit -> CSV/Excel storage -> expire -> winners', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'office-game-test-'));
  const dbPath = path.join(tmpDir, 'db.json');
  const store = new GameStore(dbPath);
  const app = createApp({ store });

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

test('Vercel serverless handler (api/index.js) serves GET / and pre-parsed req.body', async () => {
  const prevVercel = process.env.VERCEL;
  process.env.VERCEL = '1';
  try {
    const handler = require('../api/index');
    const getResp = await invokeApp(handler, 'GET', '/');
    assert.equal(getResp.status, 200);
    assert.ok(getResp.text.includes('Office Number Game'));

    // Verify Vercel rewrite preserving path via __route query parameter
    const rewrittenHealth = await invokeApp(handler, 'GET', '/api/index.js?__route=/api/health');
    assert.equal(rewrittenHealth.status, 200);
    assert.equal(JSON.parse(rewrittenHealth.text).ok, true);

    const stateResp = await invokeApp(handler, 'GET', '/api/index.js?__route=/api/state');
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
    await invokeApp(handler, 'POST', '/api/reset');
  } finally {
    if (prevVercel === undefined) delete process.env.VERCEL;
    else process.env.VERCEL = prevVercel;
  }
});

test('Remote KV/Redis sync shares session links across separate serverless instances', async () => {
  const remoteMap = new Map();
  const prevFetch = globalThis.fetch;
  globalThis.fetch = async (_url, opts = {}) => {
    const cmd = JSON.parse(opts.body);
    if (cmd[0] === 'GET') {
      return {
        ok: true,
        status: 200,
        async json() {
          return { result: remoteMap.get(cmd[1]) ?? null };
        },
      };
    }
    if (cmd[0] === 'SET') {
      remoteMap.set(cmd[1], cmd[2]);
      return {
        ok: true,
        status: 200,
        async json() {
          return { result: 'OK' };
        },
      };
    }
    throw new Error(`Unexpected command: ${cmd[0]}`);
  };

  const dir1 = fs.mkdtempSync(path.join(os.tmpdir(), 'ong-kv-1-'));
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'ong-kv-2-'));
  try {
    const remoteKv = { url: 'https://kv.example.test', token: 'tok', key: 'test_game_state' };
    const app1 = createApp({ store: new GameStore(path.join(dir1, 'db.json'), { remoteKv }) });
    const app2 = createApp({ store: new GameStore(path.join(dir2, 'db.json'), { remoteKv }) });

    const created = await invokeApp(app1, 'POST', '/api/sessions', { name: "Kishan's Round 1" });
    assert.equal(created.status, 201);
    const token = created.json.session.token;

    // Second completely separate instance must see the created session
    const playInfo = await invokeApp(app2, 'GET', `/api/play/${token}`);
    assert.equal(playInfo.status, 200);
    assert.equal(playInfo.json.valid, true);
    assert.equal(playInfo.json.session.name, "Kishan's Round 1");

    const stateOnApp2 = await invokeApp(app2, 'GET', '/api/state');
    assert.equal(stateOnApp2.json.storage.mode, 'redis');
    assert.equal(stateOnApp2.json.storage.persistent, true);
    assert.equal(stateOnApp2.json.sessions.length, 1);
  } finally {
    globalThis.fetch = prevFetch;
    fs.rmSync(dir1, { recursive: true, force: true });
    fs.rmSync(dir2, { recursive: true, force: true });
  }
});
