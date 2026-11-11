const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { Readable } = require('node:stream');

const { validateTicketSetDistribution, computeCombinedLeaderboard } = require('../src/gameLogic');
const { toCsv, toXlsxBuffer } = require('../src/exportData');
const { GameStore } = require('../src/store');
const { createApp } = require('../src/gameServer');

function invokeApp(app, method, reqPath, body = null, opts = {}) {
  return new Promise((resolve, reject) => {
    const rawBody =
      opts.rawBody !== undefined
        ? opts.rawBody
        : body !== null && body !== undefined
          ? JSON.stringify(body)
          : '';
    const req = Readable.from(rawBody ? [Buffer.from(rawBody, 'utf8')] : []);
    req.method = method;
    req.url = reqPath;
    req.headers = {
      host: 'localhost:3000',
      'content-type': 'application/json',
      ...(opts.ip ? { 'x-forwarded-for': opts.ip } : {}),
    };
    req.socket = { remoteAddress: opts.ip || '127.0.0.1' };

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

function parseZipEntries(zipBuf) {
  const entries = [];
  let offset = 0;
  while (offset + 30 <= zipBuf.length) {
    const sig = zipBuf.readUInt32LE(offset);
    if (sig !== 0x04034b50) break;
    const method = zipBuf.readUInt16LE(offset + 8);
    const compressedSize = zipBuf.readUInt32LE(offset + 18);
    const uncompressedSize = zipBuf.readUInt32LE(offset + 22);
    const nameLen = zipBuf.readUInt16LE(offset + 26);
    const extraLen = zipBuf.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLen + extraLen;
    const name = zipBuf.slice(nameStart, nameStart + nameLen).toString('utf8');
    const payload = zipBuf.slice(dataStart, dataStart + compressedSize);
    const data = method === 8 ? zlib.inflateRawSync(payload) : payload;
    assert.equal(data.length, uncompressedSize, `Uncompressed size mismatch for ${name}`);
    entries.push({ name, method, compressedSize, uncompressedSize, data });
    offset = dataStart + compressedSize;
  }
  return entries;
}

test('Big basket generation (500 tickets): unique IDs/codes, 1-per-set distribution, delete + seq naming, and reduction', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'office-game-bulk1-'));
  const store = new GameStore(path.join(tmpDir, 'db.json'));
  const app = createApp({ store });

  try {
    const genResp = await invokeApp(app, 'POST', '/api/tickets/generate', {
      count: 500,
      playerNames: ['Lead 1', 'Lead 2', 'Lead 3', 'Lead 4', 'Lead 5'],
      numbersPerTicket: 10,
      perSetCheck: true,
    });
    assert.equal(genResp.status, 201);
    const { tickets } = genResp.json;
    assert.equal(tickets.length, 500);

    const seenIds = new Set();
    const seenCodes = new Set();
    const seenNames = new Set();

    for (const t of tickets) {
      assert.ok(!seenIds.has(t.ticketId), `Duplicate ticketId ${t.ticketId}`);
      assert.ok(!seenCodes.has(t.secretCode), `Duplicate secretCode ${t.secretCode}`);
      seenIds.add(t.ticketId);
      seenCodes.add(t.secretCode);
      seenNames.add(t.playerName);
      assert.equal(t.numbers.length, 10);
      const check = validateTicketSetDistribution(t.numbers);
      assert.equal(check.valid, true, `Ticket ${t.ticketId} failed set validation`);
    }
    assert.equal(seenNames.size, 500);
    assert.equal(tickets[5].playerName, 'Player 6');
    assert.equal(tickets[499].playerName, 'Player 500');

    // Delete 3 tickets then generate 5 more -> default player names must not collide
    for (let i = 10; i < 13; i++) {
      const del = await invokeApp(app, 'DELETE', `/api/tickets/${tickets[i].ticketId}`);
      assert.equal(del.status, 200);
    }

    const genMore = await invokeApp(app, 'POST', '/api/tickets/generate', {
      count: 5,
      numbersPerTicket: 10,
      perSetCheck: true,
    });
    assert.equal(genMore.status, 201);
    assert.equal(genMore.json.tickets.length, 5);
    for (const extra of genMore.json.tickets) {
      assert.ok(!seenNames.has(extra.playerName), `Duplicate auto-generated name ${extra.playerName}`);
      seenNames.add(extra.playerName);
    }

    // Reduce first ticket mid-round from 10 to 6
    const reduceResp = await invokeApp(app, 'PATCH', `/api/tickets/${tickets[0].ticketId}/reduce`, {
      targetCount: 6,
    });
    assert.equal(reduceResp.status, 200);
    assert.equal(reduceResp.json.ticket.numbers.length, 6);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('HTTP validation & security guards return 400/403/409/429 cleanly (never 500)', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'office-game-bulk2-'));
  const store = new GameStore(path.join(tmpDir, 'db.json'));
  const app = createApp({ store });

  try {
    // Malformed JSON -> 400
    const badJson = await invokeApp(app, 'POST', '/api/sessions', null, { rawBody: '{"name":' });
    assert.equal(badJson.status, 400);

    // Invalid ticket counts -> 400
    for (const badCount of [0, -3, 1001, 1.5, 'many']) {
      const resp = await invokeApp(app, 'POST', '/api/tickets/generate', { count: badCount });
      assert.equal(resp.status, 400, `Expected 400 for count=${badCount}`);
    }

    // Impossible decade constraints -> 400
    const impossiblePerSet = await invokeApp(app, 'POST', '/api/tickets/generate', {
      count: 1,
      numbersPerTicket: 10,
      perSetCheck: true,
      selectedSets: [0, 1, 2], // only 3 sets, so cannot pick 1 per set for 10 numbers
    });
    assert.equal(impossiblePerSet.status, 400);

    const excludedSet = await invokeApp(app, 'POST', '/api/tickets/generate', {
      count: 1,
      numbersPerTicket: 10,
      perSetCheck: true,
      excludedNumbers: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
    });
    assert.equal(excludedSet.status, 400);

    // Generate 2 valid tickets + session to test verify/submit/evaluate guards
    const gen = await invokeApp(app, 'POST', '/api/tickets/generate', { count: 2 });
    const [t1, t2] = gen.json.tickets;
    const sesResp = await invokeApp(app, 'POST', '/api/sessions', { name: 'Validation Round' });
    const session = sesResp.json.session;

    // Rate limit brute-force attempts on secret codes (15 failures allowed, 16th -> 429)
    for (let i = 0; i < 15; i++) {
      const failVerify = await invokeApp(
        app,
        'POST',
        `/api/play/${session.token}/verify`,
        { ticketId: t1.ticketId, secretCode: 'BAD000' },
        { ip: '10.9.8.7' }
      );
      assert.equal(failVerify.status, 401);
    }
    const lockedVerify = await invokeApp(
      app,
      'POST',
      `/api/play/${session.token}/verify`,
      { ticketId: t1.ticketId, secretCode: t1.secretCode },
      { ip: '10.9.8.7' }
    );
    assert.equal(lockedVerify.status, 429);

    // Legit IP succeeds and duplicate submit in same round -> 409
    const subOk = await invokeApp(
      app,
      'POST',
      `/api/play/${session.token}/submit`,
      { ticketId: t1.ticketId, secretCode: t1.secretCode, selectedNumber: t1.numbers[0] },
      { ip: '10.0.0.1' }
    );
    assert.equal(subOk.status, 201);

    const subDup = await invokeApp(
      app,
      'POST',
      `/api/play/${session.token}/submit`,
      { ticketId: t1.ticketId, secretCode: t1.secretCode, selectedNumber: t1.numbers[1] },
      { ip: '10.0.0.1' }
    );
    assert.equal(subDup.status, 409);

    // Invalid winner evaluation options -> 400
    const badMode = await invokeApp(app, 'POST', `/api/sessions/${session.id}/evaluate`, {
      mode: 'median',
    });
    assert.equal(badMode.status, 400);

    const badRange = await invokeApp(app, 'POST', `/api/sessions/${session.id}/evaluate`, {
      mode: 'range',
      min: 80,
      max: 20,
    });
    assert.equal(badRange.status, 400);

    // Expire session then verify/submit blocked with 403
    const expResp = await invokeApp(app, 'POST', `/api/sessions/${session.id}/expire`);
    assert.equal(expResp.status, 200);

    const expiredVerify = await invokeApp(
      app,
      'POST',
      `/api/play/${session.token}/verify`,
      { ticketId: t2.ticketId, secretCode: t2.secretCode },
      { ip: '10.0.0.2' }
    );
    assert.equal(expiredVerify.status, 403);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Big-basket tournament (500 tickets x 4 rounds = 2000 submissions), session deletion rollback, leaderboard & exports', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'office-game-bulk3-'));
  const store = new GameStore(path.join(tmpDir, 'db.json'));
  const app = createApp({ store });

  try {
    // 1. Generate 500 tickets (including XML/CSV special chars on first 2 players)
    const genResp = await invokeApp(app, 'POST', '/api/tickets/generate', {
      count: 500,
      playerNames: ['Alice & Co <VIP>', 'Bob, "The Kid"\x07'],
      numbersPerTicket: 10,
      perSetCheck: true,
    });
    assert.equal(genResp.status, 201);
    const tickets = genResp.json.tickets;
    assert.equal(tickets.length, 500);

    // 2. Create 4 sessions and submit 500 x 4 = 2000 numbers across unique client IPs
    const sessions = [];
    const roundNames = ['Round 1 <Open>', 'Round 2: *High*', 'Round 3 [Range]', 'Round 4 /Temp?'];
    for (let r = 0; r < 4; r++) {
      const sResp = await invokeApp(app, 'POST', '/api/sessions', {
        name: roundNames[r],
        consumeUsedNumbers: true,
      });
      assert.equal(sResp.status, 201);
      sessions.push(sResp.json.session);
    }

    const tStart = Date.now();
    for (let r = 0; r < 4; r++) {
      const ses = sessions[r];
      for (let i = 0; i < tickets.length; i++) {
        const t = tickets[i];
        const pick = t.numbers[r]; // unused decade number in round r
        const subResp = await invokeApp(
          app,
          'POST',
          `/api/play/${ses.token}/submit`,
          { ticketId: t.ticketId, secretCode: t.secretCode, selectedNumber: pick },
          { ip: `10.1.${r}.${i % 250}` }
        );
        assert.equal(subResp.status, 201, `Failed submit at r=${r}, i=${i}: ${subResp.text}`);
      }
    }
    const submitElapsedMs = Date.now() - tStart;
    assert.ok(submitElapsedMs < 45000, `2000 submissions took too long (${submitElapsedMs}ms)`);

    // Cross-round reuse attempt must fail
    const reuse = await invokeApp(app, 'POST', `/api/play/${sessions[0].token}/verify`, {
      ticketId: tickets[0].ticketId,
      secretCode: tickets[0].secretCode,
    });
    assert.equal(reuse.status, 200);
    assert.equal(reuse.json.usedNumbers.length, 4);

    // Check total submissions == 2000
    const allSubsBeforeDel = await invokeApp(app, 'GET', '/api/submissions');
    assert.equal(allSubsBeforeDel.json.submissions.length, 2000);

    // 3. Delete Round 4 session -> submissions drop to 1500 AND Round 4 numbers become free on all 500 tickets
    const delSes = await invokeApp(app, 'DELETE', `/api/sessions/${sessions[3].id}`);
    assert.equal(delSes.status, 200);

    const stateAfterDel = await invokeApp(app, 'GET', '/api/state');
    assert.equal(stateAfterDel.json.submissions.length, 1500);
    assert.equal(stateAfterDel.json.sessions.length, 3);
    for (const t of stateAfterDel.json.tickets) {
      assert.equal(t.usedNumbers.length, 3, `Expected 3 usedNumbers after Round 4 deletion on ${t.ticketId}`);
      assert.ok(!t.usedNumbers.includes(t.numbers[3]), 'Deleted round number should be released');
    }

    // 4. Expire & evaluate Rounds 1-3 -> compute 500-player combined leaderboard
    const modes = [
      { mode: 'least', pointsPerWin: 2 },
      { mode: 'highest', pointsPerWin: 3 },
      { mode: 'range', min: 15, max: 35, pointsPerWin: 1 },
    ];
    for (let r = 0; r < 3; r++) {
      await invokeApp(app, 'POST', `/api/sessions/${sessions[r].id}/expire`);
      const ev = await invokeApp(app, 'POST', `/api/sessions/${sessions[r].id}/evaluate`, {
        ...modes[r],
        saveToLeaderboard: true,
      });
      assert.equal(ev.status, 200);
      assert.ok(ev.json.winners.length >= 1);
    }

    const lbResp = await invokeApp(app, 'GET', '/api/leaderboard');
    assert.equal(lbResp.status, 200);
    assert.equal(lbResp.json.evaluatedRoundsCount, 3);
    assert.equal(lbResp.json.leaderboard.length, 500);
    assert.equal(lbResp.json.leaderboard[0].rank, 1);

    assert.equal(lbResp.json.rounds.length, 3);

    // Also benchmark computeCombinedLeaderboard directly
    const directLb = computeCombinedLeaderboard(
      stateAfterDel.json.tickets,
      lbResp.json.rounds.map((rs, idx) => ({
        ...stateAfterDel.json.sessions[idx],
        status: rs.status,
        roundResult: rs.roundResult,
      })),
      stateAfterDel.json.submissions
    );
    assert.equal(directLb.leaderboard.length, 500);
    assert.equal(directLb.evaluatedRoundsCount, 3);

    // 5. Verify compressed ZIP export for 500 HTML tickets fits well below Vercel 4.5MB limit
    const zipResp = await invokeApp(app, 'GET', '/api/tickets/export/zip');
    assert.equal(zipResp.status, 200);
    assert.equal(zipResp.headers['Content-Type'], 'application/zip');
    assert.ok(
      zipResp.buffer.length < 4 * 1024 * 1024,
      `500-ticket ZIP (${zipResp.buffer.length} bytes) should be < 4 MB`
    );

    const zipEntries = parseZipEntries(zipResp.buffer);
    assert.equal(zipEntries.length, 500);
    assert.equal(zipEntries[0].method, 8, 'ZIP should use DEFLATE compression');
    const firstHtml = zipEntries[0].data.toString('utf8');
    assert.ok(firstHtml.includes('Alice &amp; Co &lt;VIP&gt;'));
    assert.ok(firstHtml.includes("execCommand('copy')"), 'Ticket HTML should include offline copy fallback');

    const allHtmlResp = await invokeApp(app, 'GET', '/api/tickets/export/all.html');
    assert.equal(allHtmlResp.status, 200);
    assert.ok(allHtmlResp.text.includes('Alice &amp; Co &lt;VIP&gt;'));

    // 6. Verify bulk XLSX & CSV exports (safe XML escaping, control-char stripping, sanitized sheet name)
    for (const exportEndpoint of [
      '/api/export/submissions.xlsx',
      '/api/export/leaderboard.xlsx',
      '/api/export/tickets.xlsx',
    ]) {
      const xResp = await invokeApp(app, 'GET', exportEndpoint);
      assert.equal(xResp.status, 200);
      const xEntries = parseZipEntries(xResp.buffer);
      const sheetEntry = xEntries.find((e) => e.name === 'xl/worksheets/sheet1.xml');
      assert.ok(sheetEntry, `${exportEndpoint} missing sheet1.xml`);
      const sheetXml = sheetEntry.data.toString('utf8');
      assert.ok(!sheetXml.includes('\x07'), `${exportEndpoint} leaked illegal XML control char`);
      assert.ok(sheetXml.includes('&amp;'), `${exportEndpoint} missing XML escaping for &`);
    }

    // Direct sheet-name sanitization test for toXlsxBuffer
    const specialXlsx = toXlsxBuffer('bad:[name]/*?\\longer_than_thirty_one_chars', ['Col'], [[' leading & \x01ctrl']]);
    const specialEntries = parseZipEntries(specialXlsx);
    const wbXml = specialEntries.find((e) => e.name === 'xl/workbook.xml').data.toString('utf8');
    const sheetXml = specialEntries.find((e) => e.name === 'xl/worksheets/sheet1.xml').data.toString('utf8');
    assert.ok(!wbXml.includes(':[') && !wbXml.includes('thirty_one_chars') && wbXml.includes('name="bad  name'));
    assert.ok(sheetXml.includes('xml:space="preserve"'));
    assert.ok(!sheetXml.includes('\x01'));

    const csvResp = await invokeApp(app, 'GET', '/api/export/submissions.csv');
    assert.equal(csvResp.status, 200);
    const csvLines = csvResp.text.trim().split('\n');
    assert.equal(csvLines.length, 1501);

    const quotedCsv = toCsv(['A', 'B'], [['x,y', 'he said "hi"\nline2']]);
    assert.ok(quotedCsv.includes('"x,y","he said ""hi""\nline2"'));

    // 7. Reset clears entire 500-player basket cleanly
    const resetResp = await invokeApp(app, 'POST', '/api/reset');
    assert.equal(resetResp.status, 200);
    const postReset = await invokeApp(app, 'GET', '/api/state');
    assert.equal(postReset.json.tickets.length, 0);
    assert.equal(postReset.json.sessions.length, 0);
    assert.equal(postReset.json.submissions.length, 0);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('High-concurrency bulk submissions (200 parallel requests across 3 instances) with shared Redis KV hashes', async () => {
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
      if (!map || map.size === 0) return { result: [] };
      const out = [];
      for (const [f, v] of map.entries()) out.push(f, v);
      return { result: out };
    }
    if (op === 'DEL') {
      strings.delete(key);
      hashes.delete(key);
      return { result: 1 };
    }
    return { result: null };
  }

  globalThis.fetch = async (url, options = {}) => {
    assert.equal(String(url), 'https://mock-bulk.upstash.io/pipeline');
    const cmds = JSON.parse(options.body);
    return {
      ok: true,
      async json() {
        return cmds.map(execCmd);
      },
    };
  };

  const prevUrl = process.env.UPSTASH_REDIS_REST_URL;
  const prevTok = process.env.UPSTASH_REDIS_REST_TOKEN;
  process.env.UPSTASH_REDIS_REST_URL = 'https://mock-bulk.upstash.io';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'bulk-tok';

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'office-game-bulk-kv-'));
  try {
    const adminApp = createApp({ store: new GameStore(path.join(tmpDir, 'admin.json')) });
    const gen = await invokeApp(adminApp, 'POST', '/api/tickets/generate', { count: 200 });
    assert.equal(gen.status, 201);
    const tickets = gen.json.tickets;

    const sesResp = await invokeApp(adminApp, 'POST', '/api/sessions', { name: 'Concurrent Bulk Round' });
    assert.equal(sesResp.status, 201);
    const session = sesResp.json.session;

    const instances = [
      createApp({ store: new GameStore(path.join(tmpDir, 'w1.json')) }),
      createApp({ store: new GameStore(path.join(tmpDir, 'w2.json')) }),
      createApp({ store: new GameStore(path.join(tmpDir, 'w3.json')) }),
    ];

    // Dispatch all 200 submissions concurrently across the 3 instances
    const responses = await Promise.all(
      tickets.map((t, idx) =>
        invokeApp(
          instances[idx % instances.length],
          'POST',
          `/api/play/${session.token}/submit`,
          {
            ticketId: t.ticketId,
            secretCode: t.secretCode,
            selectedNumber: t.numbers[idx % t.numbers.length],
          },
          { ip: `10.50.${Math.floor(idx / 200)}.${(idx % 200) + 1}` }
        )
      )
    );

    for (const r of responses) {
      assert.equal(r.status, 201, `Concurrent submit failed: ${r.text}`);
    }

    // Fresh reader instance sees all 200 submissions and all 200 usedNumbers updates
    const readerApp = createApp({ store: new GameStore(path.join(tmpDir, 'reader.json')) });
    const stateResp = await invokeApp(readerApp, 'GET', '/api/state');
    assert.equal(stateResp.status, 200);
    assert.equal(stateResp.json.submissions.length, 200);
    assert.equal(stateResp.json.tickets.length, 200);
    for (const t of stateResp.json.tickets) {
      assert.equal(t.usedNumbers.length, 1);
    }
  } finally {
    globalThis.fetch = prevFetch;
    if (prevUrl === undefined) delete process.env.UPSTASH_REDIS_REST_URL;
    else process.env.UPSTASH_REDIS_REST_URL = prevUrl;
    if (prevTok === undefined) delete process.env.UPSTASH_REDIS_REST_TOKEN;
    else process.env.UPSTASH_REDIS_REST_TOKEN = prevTok;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
