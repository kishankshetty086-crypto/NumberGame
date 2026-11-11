const pathParts = window.location.pathname.split('/').filter(Boolean);
const sessionToken = pathParts[1] || '';

const playState = {
  secretCode: '',
  ticketId: '',
  selectedNumber: null,
};

function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function showPlayAlert(msg, type = 'error') {
  const el = document.getElementById('play-alert');
  el.innerHTML = msg ? `<div class="alert alert-${type}">${esc(msg)}</div>` : '';
}

function decadeLabel(n) {
  const idx = Math.floor((n - 1) / 10);
  return `${idx * 10 + 1}-${(idx + 1) * 10}`;
}

async function fetchJson(url, options = {}) {
  const resp = await fetch(url, { cache: 'no-store', ...options });
  const raw = await resp.text();
  let data = {};
  if (raw) {
    try {
      data = JSON.parse(raw);
    } catch {
      data = { error: `Unexpected server response (${resp.status})` };
    }
  }
  return { resp, data };
}

async function initPlayPage() {
  if (!sessionToken) {
    showInvalidLink('Missing session token in URL.');
    return;
  }

  try {
    const { resp, data } = await fetchJson(`/api/play/${encodeURIComponent(sessionToken)}`);
    if (!resp.ok || !data.valid) {
      showInvalidLink(data.error || 'Invalid session link. Please check the link shared by your admin.');
      return;
    }

    document.getElementById('session-title').textContent = data.session.name;
    const badge = document.getElementById('session-badge');

    if (!data.active) {
      badge.className = 'pill danger';
      badge.textContent = 'EXPIRED';
      showClosed('This session has been closed / expired by the admin.');
      return;
    }

    badge.className = 'pill ok';
    badge.textContent = 'OPEN';
    document.getElementById('verify-form').style.display = 'block';
  } catch (err) {
    showInvalidLink(err.message || 'Unable to load session.');
  }
}

function showInvalidLink(reason) {
  document.getElementById('session-title').textContent = 'Invalid Session Link';
  const badge = document.getElementById('session-badge');
  badge.className = 'pill danger';
  badge.textContent = 'INVALID';
  const heading = document.getElementById('closed-heading');
  if (heading) heading.textContent = 'Session Link Not Found';
  document.getElementById('closed-reason').textContent = reason;
  document.getElementById('closed-view').style.display = 'block';
}

function showClosed(reason) {
  document.getElementById('session-title').textContent = 'Session Closed';
  const badge = document.getElementById('session-badge');
  badge.className = 'pill danger';
  badge.textContent = 'EXPIRED';
  const heading = document.getElementById('closed-heading');
  if (heading) heading.textContent = 'Session Unavailable';
  document.getElementById('closed-reason').textContent = reason;
  document.getElementById('closed-view').style.display = 'block';
}

function showReceipt(submission) {
  document.getElementById('verify-form').style.display = 'none';
  document.getElementById('pick-view').style.display = 'none';
  document.getElementById('receipt-view').style.display = 'block';
  document.getElementById('receipt-number').textContent = submission.selectedNumber;
  document.getElementById('receipt-meta').textContent = `${submission.playerName} (${submission.ticketId})`;
  document.getElementById('receipt-zoho').innerHTML =
    '<span class="pill ok">Saved to Stored Data (CSV & Excel)</span>';
}

document.getElementById('verify-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  showPlayAlert('');
  const secretCode = document.getElementById('play-secret').value.trim();
  const ticketId = document.getElementById('play-ticket-id').value.trim();

  try {
    const { resp, data } = await fetchJson(`/api/play/${encodeURIComponent(sessionToken)}/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secretCode, ticketId }),
    });
    if (!resp.ok) {
      throw new Error(data.error || 'Verification failed');
    }

    if (data.alreadySubmitted && data.existingSubmission) {
      showReceipt(data.existingSubmission);
      return;
    }

    playState.secretCode = secretCode;
    playState.ticketId = data.ticketId;
    playState.selectedNumber = null;

    document.getElementById('verified-player').textContent = data.playerName;
    document.getElementById('verified-ticket-id').textContent = data.ticketId;

    const usedSet = new Set(data.usedNumbers || []);
    const grid = document.getElementById('number-tiles');
    grid.innerHTML = data.numbers
      .map((n) => {
        const isUsed = usedSet.has(n);
        return `
          <button type="button" class="pick-tile" data-num="${n}" ${isUsed ? 'disabled' : ''}>
            <span class="big">${n}</span>
            <span class="sub">${isUsed ? 'USED' : decadeLabel(n)}</span>
          </button>
        `;
      })
      .join('');

    grid.querySelectorAll('.pick-tile:not(:disabled)').forEach((btn) => {
      btn.addEventListener('click', () => {
        grid.querySelectorAll('.pick-tile').forEach((b) => b.classList.remove('selected'));
        btn.classList.add('selected');
        playState.selectedNumber = Number(btn.dataset.num);
        document.getElementById('submit-number-btn').disabled = false;
      });
    });

    document.getElementById('submit-number-btn').disabled = true;
    document.getElementById('verify-form').style.display = 'none';
    document.getElementById('pick-view').style.display = 'block';
  } catch (err) {
    showPlayAlert(err.message, 'error');
  }
});

document.getElementById('switch-ticket-btn').addEventListener('click', () => {
  showPlayAlert('');
  document.getElementById('pick-view').style.display = 'none';
  document.getElementById('verify-form').style.display = 'block';
});

document.getElementById('submit-number-btn').addEventListener('click', async () => {
  if (!playState.selectedNumber) return;
  showPlayAlert('');
  const btn = document.getElementById('submit-number-btn');
  btn.disabled = true;
  btn.textContent = 'Submitting...';

  try {
    const { resp, data } = await fetchJson(`/api/play/${encodeURIComponent(sessionToken)}/submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ticketId: playState.ticketId,
        secretCode: playState.secretCode,
        selectedNumber: playState.selectedNumber,
      }),
    });
    if (!resp.ok) {
      throw new Error(data.error || 'Submission failed');
    }
    showReceipt(data.submission);
  } catch (err) {
    showPlayAlert(err.message, 'error');
    btn.disabled = false;
    btn.textContent = 'Submit Selected Number';
  }
});

initPlayPage();
