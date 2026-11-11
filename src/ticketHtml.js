const { getDecadeSetIndex, DECADE_SETS } = require('./gameLogic');

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderTicketCardMarkup(ticket, { activeSessionUrl = '' } = {}) {
  const usedSet = new Set(ticket.usedNumbers || []);
  const numbersHtml = ticket.numbers
    .map((n) => {
      const setLabel = DECADE_SETS[getDecadeSetIndex(n)].label;
      const isUsed = usedSet.has(n);
      return `
        <div class="num-tile ${isUsed ? 'is-used' : ''}">
          <span class="num-val">${n}</span>
          <span class="num-set">${setLabel}</span>
          ${isUsed ? '<span class="num-used-tag">USED</span>' : ''}
        </div>
      `;
    })
    .join('');

  return `
    <div class="ticket-card">
      <div class="ticket-header">
        <div>
          <div class="brand-tag">OFFICE NUMBER GAME</div>
          <h1>Player Lucky Ticket</h1>
        </div>
        <div class="id-badge">
          <span class="label">TICKET ID</span>
          <strong>${escapeHtml(ticket.ticketId)}</strong>
        </div>
      </div>

      <div class="player-row">
        <div>
          <span class="label">PLAYER</span>
          <div class="player-name">${escapeHtml(ticket.playerName || 'Player')}</div>
        </div>
        <div>
          <span class="label">ALLOCATED</span>
          <div class="count-pill">${ticket.numbers.length} Numbers</div>
        </div>
      </div>

      <div class="secret-box">
        <div>
          <span class="label">YOUR SECRET CODE (KEEP PRIVATE)</span>
          <div class="secret-code" id="secret-${escapeHtml(ticket.ticketId)}">${escapeHtml(ticket.secretCode)}</div>
        </div>
        <button class="copy-btn" type="button" onclick="copyText('${escapeHtml(ticket.secretCode)}', this)">Copy Code</button>
      </div>

      <div class="numbers-section">
        <div class="section-title">Your Allotted Numbers (1 per decade range)</div>
        <div class="numbers-grid">
          ${numbersHtml}
        </div>
      </div>

      <div class="ticket-footer">
        <p><strong>How to play:</strong> Open the session link shared by the Admin, enter your <strong>Ticket ID</strong> (<code>${escapeHtml(ticket.ticketId)}</code>) and <strong>Secret Code</strong> (<code>${escapeHtml(ticket.secretCode)}</code>), and select <strong>1 number</strong> from above before the session closes.</p>
        ${
          activeSessionUrl
            ? `<p class="session-link-line">Session Link: <a href="${escapeHtml(activeSessionUrl)}" target="_blank" rel="noopener">${escapeHtml(activeSessionUrl)}</a></p>`
            : ''
        }
      </div>
    </div>
  `;
}

const SHARED_TICKET_CSS = `
  * { box-sizing: border-box; }
  body {
    margin: 0;
    padding: 24px;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Inter, sans-serif;
    background: linear-gradient(135deg, #0f172a 0%, #1e293b 100%);
    color: #0f172a;
    min-height: 100vh;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 24px;
  }
  .ticket-card {
    width: 100%;
    max-width: 580px;
    background: #ffffff;
    border-radius: 20px;
    padding: 28px;
    box-shadow: 0 24px 50px rgba(2, 6, 23, 0.45);
    border: 1px solid #e2e8f0;
    page-break-inside: avoid;
  }
  .ticket-header {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 16px;
    padding-bottom: 18px;
    border-bottom: 2px dashed #e2e8f0;
  }
  .brand-tag {
    font-size: 11px;
    font-weight: 800;
    letter-spacing: 0.12em;
    color: #4f46e5;
    margin-bottom: 4px;
  }
  h1 {
    margin: 0;
    font-size: 22px;
    color: #0f172a;
  }
  .label {
    display: block;
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.08em;
    color: #64748b;
    margin-bottom: 3px;
  }
  .id-badge {
    background: #f1f5f9;
    padding: 8px 12px;
    border-radius: 10px;
    text-align: right;
    border: 1px solid #cbd5e1;
  }
  .id-badge strong {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 14px;
    color: #0f172a;
  }
  .player-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin: 18px 0;
  }
  .player-name {
    font-size: 18px;
    font-weight: 700;
    color: #0f172a;
  }
  .count-pill {
    background: #eef2ff;
    color: #4338ca;
    font-weight: 700;
    font-size: 13px;
    padding: 6px 12px;
    border-radius: 999px;
  }
  .secret-box {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 12px;
    background: linear-gradient(135deg, #eef2ff 0%, #f5f3ff 100%);
    border: 1.5px solid #c7d2fe;
    border-radius: 14px;
    padding: 14px 18px;
    margin-bottom: 20px;
  }
  .secret-code {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 24px;
    font-weight: 800;
    letter-spacing: 0.14em;
    color: #312e81;
  }
  .copy-btn {
    border: none;
    background: #4f46e5;
    color: #fff;
    font-weight: 600;
    font-size: 13px;
    padding: 9px 14px;
    border-radius: 9px;
    cursor: pointer;
  }
  .copy-btn:hover { background: #4338ca; }
  .section-title {
    font-size: 12px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: #475569;
    margin-bottom: 10px;
  }
  .numbers-grid {
    display: grid;
    grid-template-columns: repeat(5, 1fr);
    gap: 10px;
  }
  .num-tile {
    background: #f8fafc;
    border: 1.5px solid #cbd5e1;
    border-radius: 12px;
    padding: 10px 6px;
    text-align: center;
    position: relative;
  }
  .num-tile.is-used {
    opacity: 0.45;
    background: #f1f5f9;
    text-decoration: line-through;
  }
  .num-val {
    display: block;
    font-size: 22px;
    font-weight: 800;
    color: #0f172a;
    line-height: 1.1;
  }
  .num-set {
    display: block;
    font-size: 10px;
    color: #64748b;
    margin-top: 4px;
  }
  .num-used-tag {
    display: inline-block;
    margin-top: 3px;
    font-size: 9px;
    font-weight: 800;
    color: #dc2626;
  }
  .ticket-footer {
    margin-top: 20px;
    padding-top: 14px;
    border-top: 1px solid #e2e8f0;
    font-size: 12.5px;
    line-height: 1.55;
    color: #475569;
  }
  .ticket-footer code {
    background: #f1f5f9;
    padding: 2px 6px;
    border-radius: 5px;
    font-weight: 700;
    color: #0f172a;
  }
  .session-link-line { margin-bottom: 0; word-break: break-all; }
  @media (max-width: 520px) {
    .numbers-grid { grid-template-columns: repeat(2, 1fr); }
  }
  @media print {
    body { background: #fff; padding: 10px; }
    .ticket-card { box-shadow: none; border: 1px solid #94a3b8; }
    .copy-btn { display: none; }
  }
`;

function renderTicketHtml(ticket, options = {}) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Ticket ${escapeHtml(ticket.ticketId)} - ${escapeHtml(ticket.playerName || 'Player')}</title>
  <style>${SHARED_TICKET_CSS}</style>
</head>
<body>
  ${renderTicketCardMarkup(ticket, options)}
  <script>
    function copyText(text, btn) {
      if (navigator.clipboard) {
        navigator.clipboard.writeText(text).then(function() {
          var prev = btn.textContent;
          btn.textContent = 'Copied!';
          setTimeout(function() { btn.textContent = prev; }, 1400);
        });
      }
    }
  </script>
</body>
</html>`;
}

function renderAllTicketsHtml(tickets, options = {}) {
  const cards = tickets.map((t) => renderTicketCardMarkup(t, options)).join('\n');
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>All Office Game Tickets (${tickets.length})</title>
  <style>${SHARED_TICKET_CSS}</style>
</head>
<body>
  ${cards}
  <script>
    function copyText(text, btn) {
      if (navigator.clipboard) {
        navigator.clipboard.writeText(text).then(function() {
          var prev = btn.textContent;
          btn.textContent = 'Copied!';
          setTimeout(function() { btn.textContent = prev; }, 1400);
        });
      }
    }
  </script>
</body>
</html>`;
}

// Pure-JS CRC32 + Uncompressed (STORE) ZIP builder so zero extra dependencies are required
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function buildZip(files) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const file of files) {
    const nameBuf = Buffer.from(file.name, 'utf8');
    const dataBuf = Buffer.isBuffer(file.content)
      ? file.content
      : Buffer.from(String(file.content), 'utf8');
    const crc = crc32(dataBuf);

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0x0800, 6); // UTF-8
    localHeader.writeUInt16LE(0, 8); // store
    localHeader.writeUInt16LE(0, 10);
    localHeader.writeUInt16LE(0, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(dataBuf.length, 18);
    localHeader.writeUInt32LE(dataBuf.length, 22);
    localHeader.writeUInt16LE(nameBuf.length, 26);
    localHeader.writeUInt16LE(0, 28);

    localParts.push(localHeader, nameBuf, dataBuf);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0x0800, 8);
    centralHeader.writeUInt16LE(0, 10);
    centralHeader.writeUInt16LE(0, 12);
    centralHeader.writeUInt16LE(0, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(dataBuf.length, 20);
    centralHeader.writeUInt32LE(dataBuf.length, 24);
    centralHeader.writeUInt16LE(nameBuf.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);

    centralParts.push(centralHeader, nameBuf);
    offset += localHeader.length + nameBuf.length + dataBuf.length;
  }

  const centralDirSize = centralParts.reduce((sum, b) => sum + b.length, 0);
  const endRecord = Buffer.alloc(22);
  endRecord.writeUInt32LE(0x06054b50, 0);
  endRecord.writeUInt16LE(0, 4);
  endRecord.writeUInt16LE(0, 6);
  endRecord.writeUInt16LE(files.length, 8);
  endRecord.writeUInt16LE(files.length, 10);
  endRecord.writeUInt32LE(centralDirSize, 12);
  endRecord.writeUInt32LE(offset, 16);
  endRecord.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, ...centralParts, endRecord]);
}

module.exports = {
  renderTicketHtml,
  renderAllTicketsHtml,
  buildZip,
};
