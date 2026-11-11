const fs = require('fs');
const path = require('path');
const { buildZip } = require('./ticketHtml');

function csvEscape(val) {
  const str = String(val ?? '');
  if (/[",\r\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function xmlEscape(val) {
  return String(val ?? '')
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function sanitizeSheetName(sheetName) {
  const cleaned = String(sheetName || 'Data')
    .replace(/[\\/?*\[\]:]/g, ' ')
    .trim()
    .slice(0, 31)
    .trim();
  return xmlEscape(cleaned || 'Data');
}

function toCsv(headers, rows) {
  const lines = [headers.map(csvEscape).join(',')];
  for (const row of rows) {
    lines.push(row.map(csvEscape).join(','));
  }
  return lines.join('\r\n') + '\r\n';
}

function columnLetters(indexZeroBased) {
  let n = indexZeroBased + 1;
  let result = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    result = String.fromCharCode(65 + rem) + result;
    n = Math.floor((n - 1) / 26);
  }
  return result;
}

/**
 * Builds a standard OOXML .xlsx workbook buffer using inline strings & numeric cells.
 */
function toXlsxBuffer(sheetName, headers, rows) {
  const safeSheetName = sanitizeSheetName(sheetName);
  const allRows = [headers, ...rows];

  const rowsXml = allRows
    .map((row, rIdx) => {
      const rowNum = rIdx + 1;
      const cellsXml = row
        .map((cellVal, cIdx) => {
          const ref = `${columnLetters(cIdx)}${rowNum}`;
          if (typeof cellVal === 'number' && Number.isFinite(cellVal)) {
            return `<c r="${ref}" t="n"><v>${cellVal}</v></c>`;
          }
          const escaped = xmlEscape(cellVal);
          const preserve = /^\s|\s$/.test(escaped) ? ' xml:space="preserve"' : '';
          return `<c r="${ref}" t="inlineStr"><is><t${preserve}>${escaped}</t></is></c>`;
        })
        .join('');
      return `<row r="${rowNum}">${cellsXml}</row>`;
    })
    .join('');

  const sheetXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetData>${rowsXml}</sheetData>
</worksheet>`;

  const contentTypesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
</Types>`;

  const rootRelsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;

  const workbookXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets>
    <sheet name="${safeSheetName}" sheetId="1" r:id="rId1"/>
  </sheets>
</workbook>`;

  const workbookRelsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
</Relationships>`;

  return buildZip([
    { name: '[Content_Types].xml', content: contentTypesXml },
    { name: '_rels/.rels', content: rootRelsXml },
    { name: 'xl/workbook.xml', content: workbookXml },
    { name: 'xl/_rels/workbook.xml.rels', content: workbookRelsXml },
    { name: 'xl/worksheets/sheet1.xml', content: sheetXml },
  ]);
}

const SUBMISSION_HEADERS = [
  'Submission_ID',
  'Timestamp',
  'Session_ID',
  'Session_Name',
  'Session_Token',
  'Ticket_ID',
  'Player_Name',
  'Selected_Number',
  'Secret_Verified',
];

function formatSubmissionRows(submissions) {
  return (submissions || []).map((s) => [
    s.id,
    s.submittedAt,
    s.sessionId,
    s.sessionName,
    s.sessionToken,
    s.ticketId,
    s.playerName,
    Number(s.selectedNumber),
    'YES',
  ]);
}

const TICKET_HEADERS = [
  'Ticket_ID',
  'Player_Name',
  'Secret_Code',
  'Numbers_Count',
  'Allotted_Numbers',
  'Used_Numbers',
  'Per_Set_Check_Valid',
  'Created_At',
];

function formatTicketRows(tickets) {
  return (tickets || []).map((t) => [
    t.ticketId,
    t.playerName,
    t.secretCode,
    t.numbers.length,
    t.numbers.join(' '),
    (t.usedNumbers || []).join(' '),
    t.setValidation?.valid ? 'YES' : 'NO',
    t.createdAt,
  ]);
}

function buildSubmissionsCsv(submissions) {
  return toCsv(SUBMISSION_HEADERS, formatSubmissionRows(submissions));
}

function buildSubmissionsXlsx(submissions) {
  return toXlsxBuffer('Submissions', SUBMISSION_HEADERS, formatSubmissionRows(submissions));
}

function buildTicketsCsv(tickets) {
  return toCsv(TICKET_HEADERS, formatTicketRows(tickets));
}

function buildTicketsXlsx(tickets) {
  return toXlsxBuffer('Tickets', TICKET_HEADERS, formatTicketRows(tickets));
}

function formatLeaderboardTable(leaderboardData) {
  const rounds = leaderboardData?.rounds || [];
  const headers = [
    'Rank',
    'Player_Name',
    'Ticket_ID',
    'Total_Points',
    'Total_Wins',
    'Rounds_Played',
    'Sum_Of_Numbers',
    ...rounds.map((r) => `${r.sessionName}`),
  ];

  const rows = (leaderboardData?.leaderboard || []).map((row) => [
    row.rank,
    row.playerName,
    row.ticketId,
    row.totalPoints,
    row.totalWins,
    row.roundsPlayed,
    row.totalNumberSum,
    ...(row.roundBreakdown || []).map((rb) => {
      if (rb.selectedNumber === null) return '-';
      return rb.won ? `${rb.selectedNumber} (WIN +${rb.points})` : `${rb.selectedNumber}`;
    }),
  ]);

  return { headers, rows };
}

function buildLeaderboardCsv(leaderboardData) {
  const { headers, rows } = formatLeaderboardTable(leaderboardData);
  return toCsv(headers, rows);
}

function buildLeaderboardXlsx(leaderboardData) {
  const { headers, rows } = formatLeaderboardTable(leaderboardData);
  return toXlsxBuffer('Final Leaderboard', headers, rows);
}

function writeStoredExports(dataDir, submissions, tickets, leaderboardData = null) {
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
  const subCsvPath = path.join(dataDir, 'submissions.csv');
  const subXlsxPath = path.join(dataDir, 'submissions.xlsx');
  const tktCsvPath = path.join(dataDir, 'tickets.csv');
  const tktXlsxPath = path.join(dataDir, 'tickets.xlsx');
  const lbCsvPath = path.join(dataDir, 'leaderboard.csv');
  const lbXlsxPath = path.join(dataDir, 'leaderboard.xlsx');

  fs.writeFileSync(subCsvPath, buildSubmissionsCsv(submissions), 'utf8');
  fs.writeFileSync(subXlsxPath, buildSubmissionsXlsx(submissions));
  fs.writeFileSync(tktCsvPath, buildTicketsCsv(tickets), 'utf8');
  fs.writeFileSync(tktXlsxPath, buildTicketsXlsx(tickets));
  if (leaderboardData) {
    fs.writeFileSync(lbCsvPath, buildLeaderboardCsv(leaderboardData), 'utf8');
    fs.writeFileSync(lbXlsxPath, buildLeaderboardXlsx(leaderboardData));
  }

  return { subCsvPath, subXlsxPath, tktCsvPath, tktXlsxPath, lbCsvPath, lbXlsxPath };
}

module.exports = {
  toCsv,
  toXlsxBuffer,
  buildSubmissionsCsv,
  buildSubmissionsXlsx,
  buildTicketsCsv,
  buildTicketsXlsx,
  buildLeaderboardCsv,
  buildLeaderboardXlsx,
  writeStoredExports,
};
