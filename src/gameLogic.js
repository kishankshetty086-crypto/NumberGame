const crypto = require('crypto');

const DECADE_SETS = Array.from({ length: 10 }, (_, i) => ({
  index: i,
  label: `${i * 10 + 1}-${(i + 1) * 10}`,
  min: i * 10 + 1,
  max: (i + 1) * 10,
}));

const SAFE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function getDecadeSetIndex(num) {
  return Math.floor((num - 1) / 10);
}

function shuffleArray(arr) {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = crypto.randomInt(0, i + 1);
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

/**
 * Generates ticket numbers from 1..100.
 * Enforces 1 number per decade set (1-10, 11-20, ..., 91-100) when perSetCheck is true.
 * Supports number reduction (count < 10) for players joining after mid rounds.
 */
function generateTicketNumbers({
  count = 10,
  perSetCheck = true,
  selectedSets = null,
  excludedNumbers = [],
} = {}) {
  const numCount = Number(count);
  if (!Number.isInteger(numCount) || numCount < 1 || numCount > 10) {
    throw new Error('Numbers per ticket must be an integer between 1 and 10.');
  }

  const excluded = new Set(
    (excludedNumbers || []).map(Number).filter((n) => Number.isInteger(n))
  );

  if (perSetCheck) {
    let candidateSetIndices = DECADE_SETS.map((s) => s.index);
    if (Array.isArray(selectedSets)) {
      if (selectedSets.length === 0) {
        throw new Error('Select at least 1 decade set when Range Check is enabled.');
      }
      candidateSetIndices = [...new Set(selectedSets.map(Number))].filter(
        (idx) => Number.isInteger(idx) && idx >= 0 && idx <= 9
      );
    }

    // Filter out sets that have no available numbers after exclusions
    const availableSets = candidateSetIndices.filter((idx) => {
      const { min, max } = DECADE_SETS[idx];
      for (let n = min; n <= max; n++) {
        if (!excluded.has(n)) return true;
      }
      return false;
    });

    if (availableSets.length < numCount) {
      throw new Error(
        `Only ${availableSets.length} decade sets have available numbers, cannot allot ${numCount} numbers with per-set range check.`
      );
    }

    const chosenSets = shuffleArray(availableSets).slice(0, numCount);
    const numbers = chosenSets.map((idx) => {
      const { min, max } = DECADE_SETS[idx];
      const pool = [];
      for (let n = min; n <= max; n++) {
        if (!excluded.has(n)) pool.push(n);
      }
      return pool[crypto.randomInt(0, pool.length)];
    });

    return numbers.sort((a, b) => a - b);
  }

  // Unrestricted 1..100 pool (when perSetCheck is disabled)
  const pool = [];
  for (let n = 1; n <= 100; n++) {
    if (!excluded.has(n)) pool.push(n);
  }
  if (pool.length < numCount) {
    throw new Error(`Not enough available numbers (${pool.length}) to allot ${numCount}.`);
  }
  return shuffleArray(pool)
    .slice(0, numCount)
    .sort((a, b) => a - b);
}

/**
 * Validates that a ticket's numbers lie in 1..100, are unique, and have at most 1 per decade set.
 */
function validateTicketSetDistribution(numbers) {
  if (!Array.isArray(numbers) || numbers.length === 0) {
    return { valid: false, reason: 'Ticket has no numbers', setsCovered: [], duplicatesInSet: [] };
  }

  const seenNumbers = new Set();
  const seenSets = new Map();
  const duplicatesInSet = [];

  for (const raw of numbers) {
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1 || n > 100) {
      return { valid: false, reason: `Invalid number ${raw}`, setsCovered: [], duplicatesInSet: [] };
    }
    if (seenNumbers.has(n)) {
      return { valid: false, reason: `Duplicate number ${n}`, setsCovered: [], duplicatesInSet: [] };
    }
    seenNumbers.add(n);

    const setIdx = getDecadeSetIndex(n);
    if (seenSets.has(setIdx)) {
      duplicatesInSet.push({ set: DECADE_SETS[setIdx].label, numbers: [seenSets.get(setIdx), n] });
    } else {
      seenSets.set(setIdx, n);
    }
  }

  const setsCovered = [...seenSets.keys()].sort((a, b) => a - b).map((i) => DECADE_SETS[i].label);
  return {
    valid: duplicatesInSet.length === 0,
    reason: duplicatesInSet.length > 0 ? 'Multiple numbers in same decade set' : 'OK',
    setsCovered,
    duplicatesInSet,
  };
}

function generateSecretCode(existingCodes = new Set(), length = 6) {
  for (let attempt = 0; attempt < 1000; attempt++) {
    let code = '';
    for (let i = 0; i < length; i++) {
      code += SAFE_ALPHABET[crypto.randomInt(0, SAFE_ALPHABET.length)];
    }
    if (!existingCodes.has(code)) return code;
  }
  throw new Error('Unable to generate unique secret code');
}

function generateTicketId(existingIds = new Set(), nextSequence = 1) {
  let seq = nextSequence;
  while (true) {
    const suffix = crypto.randomBytes(2).toString('hex').toUpperCase();
    const id = `TKT-${String(seq).padStart(3, '0')}-${suffix}`;
    if (!existingIds.has(id)) return id;
    seq++;
  }
}

function generateSessionToken() {
  return crypto.randomBytes(16).toString('hex');
}

/**
 * Evaluates winners for a closed/active session.
 * mode: 'least' | 'highest' | 'range'
 */
function evaluateWinners(submissions, mode, { min = null, max = null } = {}) {
  if (!['least', 'highest', 'range'].includes(mode)) {
    throw new Error(`Unsupported winner evaluation mode: ${mode}`);
  }

  let rangeBounds = null;
  if (mode === 'range') {
    const minNum = Number(min);
    const maxNum = Number(max);
    if (
      !Number.isInteger(minNum) ||
      !Number.isInteger(maxNum) ||
      minNum < 1 ||
      maxNum > 100 ||
      minNum > maxNum
    ) {
      throw new Error('Range min and max must be integers in 1..100 with min <= max.');
    }
    rangeBounds = { min: minNum, max: maxNum };
  }

  const validRows = (submissions || [])
    .map((row) => ({
      ...row,
      selectedNumber: Number(row.selectedNumber),
    }))
    .filter((row) => Number.isInteger(row.selectedNumber) && row.selectedNumber >= 1 && row.selectedNumber <= 100);

  if (validRows.length === 0) {
    return {
      mode,
      totalSubmissions: 0,
      winningValue: null,
      range: rangeBounds,
      winners: [],
    };
  }

  if (mode === 'least') {
    const minVal = Math.min(...validRows.map((r) => r.selectedNumber));
    const winners = validRows.filter((r) => r.selectedNumber === minVal);
    return {
      mode,
      totalSubmissions: validRows.length,
      winningValue: minVal,
      range: null,
      winners,
    };
  }

  if (mode === 'highest') {
    const maxVal = Math.max(...validRows.map((r) => r.selectedNumber));
    const winners = validRows.filter((r) => r.selectedNumber === maxVal);
    return {
      mode,
      totalSubmissions: validRows.length,
      winningValue: maxVal,
      range: null,
      winners,
    };
  }

  const winners = validRows
    .filter((r) => r.selectedNumber >= rangeBounds.min && r.selectedNumber <= rangeBounds.max)
    .sort((a, b) => a.selectedNumber - b.selectedNumber);
  return {
    mode,
    totalSubmissions: validRows.length,
    winningValue: null,
    range: rangeBounds,
    winners,
  };
}

function roundPoints(val) {
  const n = Number(val || 0);
  if (!Number.isFinite(n) || n === 0) return 0;
  const r2 = Math.round((n + Number.EPSILON) * 100) / 100;
  if (r2 !== 0) return r2;
  return Math.round((n + Number.EPSILON) * 10000) / 10000;
}

function sumPoints(a, b) {
  return Math.round((Number(a || 0) + Number(b || 0) + Number.EPSILON) * 10000) / 10000;
}

/**
 * Computes a combined multi-round leaderboard across all sessions.
 * Sessions are ordered chronologically (oldest round first).
 * Evaluates each player's total wins, shared prize points, rounds played, sum of picks, and per-round breakdown.
 */
function computeCombinedLeaderboard(tickets = [], sessions = [], submissions = []) {
  const chronologicalSessions = [...sessions].sort(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
  );

  // Map active players by ticketId (deleted tickets are excluded from the leaderboard)
  const playerMap = new Map();
  for (const t of tickets) {
    playerMap.set(t.ticketId, {
      ticketId: t.ticketId,
      playerName: t.playerName || t.ticketId,
      totalWins: 0,
      totalPoints: 0,
      roundsPlayed: 0,
      totalNumberSum: 0,
      remainingNumbersCount: Math.max(0, (t.numbers || []).length - (t.usedNumbers || []).length),
      roundBreakdown: [],
    });
  }

  const subsBySession = new Map();
  for (const sub of submissions) {
    if (!subsBySession.has(sub.sessionId)) {
      subsBySession.set(sub.sessionId, new Map());
    }
    subsBySession.get(sub.sessionId).set(sub.ticketId, sub);
  }

  const roundsSummary = chronologicalSessions.map((ses) => {
    const subByTicket = subsBySession.get(ses.id) || new Map();
    const rr = ses.roundResult || null;
    const rawWinnerIds = rr?.winnerTicketIds || [];
    const activeWinnerIds = new Set(rawWinnerIds.filter((id) => playerMap.has(id)));
    const winnerCount = activeWinnerIds.size;
    const prizePool = rr ? Number(rr.pointsPerWin || 1) : 0;
    const pointsPerWinner = rr && winnerCount > 0 ? roundPoints(prizePool / winnerCount) : 0;

    for (const [ticketId, entry] of playerMap.entries()) {
      const sub = subByTicket.get(ticketId);
      const won = Boolean(rr && activeWinnerIds.has(ticketId));
      const pts = won ? pointsPerWinner : 0;

      if (sub) {
        entry.roundsPlayed += 1;
        entry.totalNumberSum += Number(sub.selectedNumber) || 0;
      }
      if (won) {
        entry.totalWins += 1;
        entry.totalPoints = sumPoints(entry.totalPoints, pts);
      }

      entry.roundBreakdown.push({
        sessionId: ses.id,
        sessionName: ses.name,
        selectedNumber: sub ? Number(sub.selectedNumber) : null,
        won,
        points: pts,
        prizePool,
        sharedAmong: winnerCount,
        evaluated: Boolean(rr),
      });
    }

    return {
      sessionId: ses.id,
      sessionName: ses.name,
      status: ses.status,
      submissionCount: subByTicket.size,
      evaluated: Boolean(rr),
      winnerCount,
      prizePool,
      pointsPerWinner,
      roundResult: rr,
    };
  });

  const rows = [...playerMap.values()].sort((a, b) => {
    if (b.totalPoints !== a.totalPoints) return b.totalPoints - a.totalPoints;
    if (b.totalWins !== a.totalWins) return b.totalWins - a.totalWins;
    if (b.roundsPlayed !== a.roundsPlayed) return b.roundsPlayed - a.roundsPlayed;
    return a.playerName.localeCompare(b.playerName, undefined, { numeric: true, sensitivity: 'base' });
  });

  // Standard competition ranking (1, 1, 3) based on totalPoints & totalWins
  let currentRank = 0;
  let prevKey = null;
  const leaderboard = rows.map((row, idx) => {
    const key = `${row.totalPoints}|${row.totalWins}`;
    if (key !== prevKey) {
      currentRank = idx + 1;
      prevKey = key;
    }
    return {
      rank: currentRank,
      ...row,
    };
  });

  const evaluatedRoundsCount = roundsSummary.filter((r) => r.evaluated).length;
  const topPoints = leaderboard.length > 0 ? leaderboard[0].totalPoints : 0;
  const grandWinners =
    evaluatedRoundsCount > 0 && topPoints > 0
      ? leaderboard.filter((r) => r.rank === 1)
      : [];

  return {
    totalRounds: chronologicalSessions.length,
    evaluatedRoundsCount,
    rounds: roundsSummary,
    leaderboard,
    grandWinners,
  };
}

module.exports = {
  DECADE_SETS,
  getDecadeSetIndex,
  generateTicketNumbers,
  validateTicketSetDistribution,
  generateSecretCode,
  generateTicketId,
  generateSessionToken,
  roundPoints,
  evaluateWinners,
  computeCombinedLeaderboard,
};
