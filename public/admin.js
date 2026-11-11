const state = {
  tickets: [],
  decadeSets: [],
  sessions: [],
  submissions: [],
  exportFiles: null,
  leaderboard: null,
  storage: null,
};

function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function showToast(message, type = 'info') {
  const el = document.getElementById('global-toast');
  el.innerHTML = `<div class="alert alert-${type}">${esc(message)}</div>`;
  setTimeout(() => {
    if (el.firstChild) el.innerHTML = '';
  }, 6000);
}

async function api(url, options = {}) {
  const resp = await fetch(url, {
    cache: 'no-store',
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
  });
  const data = await resp.json();
  if (!resp.ok) {
    const err = new Error(data.error || `Request failed (${resp.status})`);
    err.status = resp.status;
    throw err;
  }
  return data;
}

// Tabs
document.querySelectorAll('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById(`tab-${btn.dataset.tab}`).classList.add('active');
    if (btn.dataset.tab === 'leaderboard') loadLeaderboard();
  });
});

const BROWSER_CACHE_KEY = 'office_game_browser_cache';

function saveBrowserCache() {
  try {
    const hasData =
      state.tickets.length > 0 || state.sessions.length > 0 || state.submissions.length > 0;
    if (hasData) {
      localStorage.setItem(
        BROWSER_CACHE_KEY,
        JSON.stringify({
          tickets: state.tickets,
          sessions: state.sessions,
          submissions: state.submissions,
          leaderboard: state.leaderboard,
          savedAt: new Date().toISOString(),
        })
      );
    } else {
      localStorage.removeItem(BROWSER_CACHE_KEY);
    }
  } catch {
    // ignore storage quota errors
  }
  updateBrowserCacheStatus();
}

function updateBrowserCacheStatus() {
  const el = document.getElementById('browser-cache-status');
  if (!el) return;
  try {
    const raw = localStorage.getItem(BROWSER_CACHE_KEY);
    if (!raw) {
      el.textContent = 'Browser Cache: Empty (0 bytes)';
    } else {
      const kb = (raw.length / 1024).toFixed(1);
      el.textContent = `Browser Cache: Active (${kb} KB stored in localStorage)`;
    }
  } catch {
    el.textContent = 'Browser Cache: Unavailable';
  }
}

async function checkBackendHealth() {
  try {
    await api('/api/health');
  } catch (err) {
    if (err.status === 404) {
      const el = document.getElementById('global-toast');
      el.innerHTML =
        '<div class="alert alert-error"><strong>Server Restart Required:</strong> An older <code>npm start</code> process is still running. Stop it (<code>Ctrl+C</code>) and run <code>npm start</code> again so Clear Cache, Final Leaderboard, and CSV/Excel exports are active.</div>';
    }
  }
}

function renderStorageNotice() {
  const noticeEl = document.getElementById('session-storage-notice');
  if (!noticeEl) return;
  if (state.storage && state.storage.persistent === false) {
    noticeEl.innerHTML =
      '<div class="alert alert-error" style="font-size:12.5px; margin-bottom:12px;">' +
      '<strong>Temporary Serverless Storage Active:</strong> Vercel <code>/tmp</code> is not shared across separate player connections or cold starts. ' +
      'To share session links with remote players reliably on Vercel, connect <strong>Upstash Redis / Vercel KV</strong> (<code>UPSTASH_REDIS_REST_URL</code> &amp; <code>UPSTASH_REDIS_REST_TOKEN</code>) in Vercel Project Settings.' +
      '</div>';
  } else {
    noticeEl.innerHTML = '';
  }
}

function applyFullState(data) {
  if (data.storage) state.storage = data.storage;
  if (data.decadeSets) state.decadeSets = data.decadeSets;
  if (data.tickets) state.tickets = data.tickets;
  if (data.sessions) state.sessions = data.sessions;
  if (data.submissions !== undefined) state.submissions = data.submissions || [];
  if (data.exportFiles !== undefined) state.exportFiles = data.exportFiles || null;
  if (data.leaderboard) state.leaderboard = data.leaderboard;

  renderStorageNotice();
  renderDecadeCheckboxes();
  renderTickets();
  document.getElementById('pill-tickets').textContent = `Tickets: ${state.tickets.length}`;
  document.getElementById('ticket-total').textContent = state.tickets.length;

  const activeCount = state.sessions.filter((s) => s.status === 'ACTIVE').length;
  document.getElementById('pill-sessions').textContent = `Active Sessions: ${activeCount}`;
  renderSessions();
  renderEvalSessionSelect();

  renderSubmissionsPanel();
  if (state.leaderboard) renderLeaderboard(state.leaderboard);
  saveBrowserCache();
}

async function refreshAll() {
  try {
    const data = await api('/api/state');
    applyFullState(data);
    return;
  } catch (err) {
    if (err.status !== 404) {
      await checkBackendHealth();
    }
  }
  await checkBackendHealth();
  await Promise.allSettled([loadTickets(), loadSessions(), loadSubmissions(), loadLeaderboard()]);
  saveBrowserCache();
}

async function loadTickets() {
  const data = await api('/api/tickets');
  state.tickets = data.tickets;
  state.decadeSets = data.decadeSets;
  renderDecadeCheckboxes();
  renderTickets();
  document.getElementById('pill-tickets').textContent = `Tickets: ${state.tickets.length}`;
  document.getElementById('ticket-total').textContent = state.tickets.length;
}

function renderDecadeCheckboxes() {
  const box = document.getElementById('decade-checkboxes');
  if (box.childElementCount > 0) return;
  box.innerHTML = state.decadeSets
    .map(
      (s) => `
      <label class="decade-chip">
        <input type="checkbox" class="decade-cb" value="${s.index}" checked />
        <span>${s.label}</span>
      </label>
    `
    )
    .join('');
}

function renderTickets() {
  const container = document.getElementById('tickets-container');
  const query = document.getElementById('ticket-search').value.trim().toLowerCase();
  const filtered = state.tickets.filter(
    (t) =>
      !query ||
      t.ticketId.toLowerCase().includes(query) ||
      (t.playerName || '').toLowerCase().includes(query) ||
      t.secretCode.toLowerCase().includes(query)
  );

  if (filtered.length === 0) {
    container.innerHTML = '<p style="color:var(--muted)">No tickets found. Generate tickets using the form on the left.</p>';
    return;
  }

  container.innerHTML = filtered
    .map((t) => {
      const usedSet = new Set(t.usedNumbers || []);
      const pills = t.numbers
        .map(
          (n) => `<span class="num-pill ${usedSet.has(n) ? 'used' : ''}">${n}</span>`
        )
        .join('');
      const setOk = t.setValidation?.valid;
      return `
        <div class="ticket-item">
          <div class="ticket-item-head">
            <div>
              <strong>${esc(t.playerName)}</strong>
              <span class="pill mono" style="margin-left:8px;">${esc(t.ticketId)}</span>
              <span class="pill active mono" style="margin-left:4px;">Code: ${esc(t.secretCode)}</span>
              <span class="pill ${setOk ? 'ok' : 'warn'}" style="margin-left:4px;">
                ${t.numbers.length} nums ${setOk ? '• 1/set OK' : ''}
              </span>
            </div>
            <div class="btn-row">
              <button type="button" class="btn btn-secondary btn-sm" data-action="copy-code" data-value="${esc(t.secretCode)}">Copy Code</button>
              <a class="btn btn-secondary btn-sm" href="/api/tickets/${encodeURIComponent(t.ticketId)}/html" target="_blank" rel="noopener">Preview HTML</a>
              <a class="btn btn-primary btn-sm" href="/api/tickets/${encodeURIComponent(t.ticketId)}/html?download=1">Download HTML</a>
              ${
                t.numbers.length > 1
                  ? `<button type="button" class="btn btn-secondary btn-sm" data-action="reduce-ticket" data-id="${esc(t.ticketId)}" data-count="${t.numbers.length}">Reduce</button>`
                  : ''
              }
              <button type="button" class="btn btn-danger btn-sm" data-action="delete-ticket" data-id="${esc(t.ticketId)}">Delete</button>
            </div>
          </div>
          <div class="num-pills">${pills}</div>
        </div>
      `;
    })
    .join('');
}

window.copyString = async function (val, msg) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(val);
      showToast(msg || 'Copied!', 'success');
      return;
    }
  } catch {
    // Fall back to execCommand below when Clipboard API is blocked
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = val;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    if (ok) {
      showToast(msg || 'Copied!', 'success');
      return;
    }
  } catch {
    // ignore fallback errors
  }
  showToast('Could not auto-copy. Please select the link and press Ctrl+C.', 'info');
};

document.getElementById('tickets-container').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-action]');
  if (!btn) return;
  const action = btn.dataset.action;
  if (action === 'copy-code') {
    window.copyString(btn.dataset.value || '', 'Secret code copied!');
  } else if (action === 'reduce-ticket') {
    window.reduceTicket(btn.dataset.id, Number(btn.dataset.count));
  } else if (action === 'delete-ticket') {
    window.deleteTicket(btn.dataset.id);
  }
});

window.reduceTicket = async function (ticketId, currentCount) {
  const input = prompt(`Reduce ticket ${ticketId} from ${currentCount} numbers to how many numbers? (1 - ${currentCount - 1})`, String(currentCount - 1));
  if (!input) return;
  const targetCount = Number(input);
  try {
    await api(`/api/tickets/${encodeURIComponent(ticketId)}/reduce`, {
      method: 'PATCH',
      body: JSON.stringify({ targetCount }),
    });
    showToast(`Ticket ${ticketId} reduced to ${targetCount} numbers.`, 'success');
    await loadTickets();
  } catch (err) {
    showToast(err.message, 'error');
  }
};

window.deleteTicket = async function (ticketId) {
  if (!confirm(`Delete ticket ${ticketId}?`)) return;
  try {
    await api(`/api/tickets/${encodeURIComponent(ticketId)}`, { method: 'DELETE' });
    showToast(`Deleted ticket ${ticketId}.`, 'success');
    await refreshAll();
  } catch (err) {
    showToast(err.message, 'error');
  }
};

document.getElementById('ticket-search').addEventListener('input', renderTickets);

document.getElementById('numbers-per-ticket').addEventListener('input', (e) => {
  document.getElementById('num-count-label').textContent = e.target.value;
});

document.getElementById('per-set-check').addEventListener('change', (e) => {
  document.getElementById('decade-sets-box').style.display = e.target.checked ? 'block' : 'none';
});

document.getElementById('generate-tickets-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const count = Number(document.getElementById('ticket-count').value);
    const playerNames = document
      .getElementById('player-names')
      .value.split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
    const numbersPerTicket = Number(document.getElementById('numbers-per-ticket').value);
    const perSetCheck = document.getElementById('per-set-check').checked;
    const selectedSets = Array.from(document.querySelectorAll('.decade-cb:checked')).map((cb) =>
      Number(cb.value)
    );
    const excludedNumbers = document
      .getElementById('excluded-numbers')
      .value.split(',')
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isInteger(n) && n >= 1 && n <= 100);

    const data = await api('/api/tickets/generate', {
      method: 'POST',
      body: JSON.stringify({
        count,
        playerNames,
        numbersPerTicket,
        perSetCheck,
        selectedSets,
        excludedNumbers,
      }),
    });
    state.tickets.push(...(data.tickets || []));
    renderTickets();
    document.getElementById('pill-tickets').textContent = `Tickets: ${state.tickets.length}`;
    document.getElementById('ticket-total').textContent = state.tickets.length;
    saveBrowserCache();
    showToast(`Generated ${data.tickets.length} ticket(s) with unique IDs and secret codes.`, 'success');
    document.getElementById('player-names').value = '';
    if (!state.storage || state.storage.persistent) {
      await refreshAll();
    }
  } catch (err) {
    showToast(err.message, 'error');
  }
});

function syncSessionsUi() {
  const activeCount = state.sessions.filter((s) => s.status === 'ACTIVE').length;
  document.getElementById('pill-sessions').textContent = `Active Sessions: ${activeCount}`;
  renderSessions();
  renderEvalSessionSelect();
  saveBrowserCache();
}

// Sessions
async function loadSessions() {
  const data = await api('/api/sessions');
  state.sessions = data.sessions;
  syncSessionsUi();
}

function renderSessions() {
  const container = document.getElementById('sessions-container');
  if (state.sessions.length === 0) {
    container.innerHTML = '<p style="color:var(--muted)">No sessions yet. Create a session to generate a player form link.</p>';
    return;
  }

  container.innerHTML = state.sessions
    .map((s) => {
      const isActive = s.status === 'ACTIVE';
      const evalBadge = s.roundResult
        ? `<span class="pill active" style="margin-left:4px;">Evaluated: ${esc(s.roundResult.mode.toUpperCase())}</span>`
        : '';
      return `
        <div class="session-card">
          <div class="ticket-item-head" style="margin-bottom:6px;">
            <div>
              <strong>${esc(s.name)}</strong>
              <span class="pill ${isActive ? 'ok' : 'danger'}" style="margin-left:8px;">${esc(s.status)}</span>
              <span class="pill" style="margin-left:4px;">Submissions: ${s.submissionCount ?? 0}</span>
              ${evalBadge}
            </div>
            <div class="btn-row">
              <button type="button" class="btn btn-secondary btn-sm" data-action="view-subs" data-id="${esc(s.id)}" data-name="${esc(s.name)}">View Submissions</button>
              <a class="btn btn-secondary btn-sm" href="/api/export/submissions.csv?sessionId=${encodeURIComponent(s.id)}">CSV</a>
              <a class="btn btn-secondary btn-sm" href="/api/export/submissions.xlsx?sessionId=${encodeURIComponent(s.id)}">Excel</a>
              ${
                isActive
                  ? `<button type="button" class="btn btn-danger btn-sm" data-action="expire" data-id="${esc(s.id)}">Expire / Close Session</button>`
                  : `<button type="button" class="btn btn-success btn-sm" data-action="reopen" data-id="${esc(s.id)}">Reopen Session</button>`
              }
              <button type="button" class="btn btn-danger btn-sm" data-action="delete" data-id="${esc(s.id)}">Delete</button>
            </div>
          </div>
          <div class="session-link-box">
            <input type="text" readonly class="mono session-url-input" value="${esc(s.playUrl)}" aria-label="Session Link" />
            <button type="button" class="btn btn-primary btn-sm" data-action="copy-link" data-url="${esc(s.playUrl)}">Copy Link</button>
            <a class="btn btn-secondary btn-sm" href="${esc(s.playUrl)}" target="_blank" rel="noopener">Open Form</a>
          </div>
          <div style="font-size:12px; color:var(--muted);">
            Token: <code class="mono">${esc(s.token)}</code> • Single-use numbers enforced across rounds • Created: ${new Date(s.createdAt).toLocaleString()}
          </div>
        </div>
      `;
    })
    .join('');
}

document.getElementById('sessions-container').addEventListener('click', (e) => {
  if (e.target.classList.contains('session-url-input')) {
    e.target.select();
    return;
  }
  const btn = e.target.closest('button[data-action]');
  if (!btn) return;
  const action = btn.dataset.action;
  if (action === 'copy-link') {
    window.copyString(btn.dataset.url || '', 'Session link copied!');
  } else if (action === 'view-subs') {
    window.viewSubmissions(btn.dataset.id, btn.dataset.name);
  } else if (action === 'expire') {
    window.expireSession(btn.dataset.id);
  } else if (action === 'reopen') {
    window.reopenSession(btn.dataset.id);
  } else if (action === 'delete') {
    window.deleteSession(btn.dataset.id);
  }
});

document.getElementById('create-session-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const submitBtn = document.getElementById('create-session-btn');
  const prevLabel = submitBtn ? submitBtn.textContent : '';
  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.textContent = 'Generating Link...';
  }
  try {
    const name = document.getElementById('session-name').value.trim();
    const data = await api('/api/sessions', {
      method: 'POST',
      body: JSON.stringify({ name, consumeUsedNumbers: true }),
    });
    if (data.session) {
      state.sessions = [data.session, ...state.sessions.filter((s) => s.id !== data.session.id)];
      syncSessionsUi();
    }
    showToast(`Created session "${data.session.name}" with a new link token!`, 'success');
    document.getElementById('session-name').value = '';
    if (!state.storage || state.storage.persistent) {
      await refreshAll();
    }
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.textContent = prevLabel;
    }
  }
});

document.getElementById('refresh-sessions-btn').addEventListener('click', refreshAll);

window.expireSession = async function (id) {
  try {
    const data = await api(`/api/sessions/${encodeURIComponent(id)}/expire`, { method: 'POST' });
    if (data.session) {
      state.sessions = state.sessions.map((s) => (s.id === id ? data.session : s));
      syncSessionsUi();
    }
    showToast('Session expired/closed. Players can no longer submit. You can now evaluate winners!', 'success');
    if (!state.storage || state.storage.persistent) {
      await refreshAll();
    }
  } catch (err) {
    showToast(err.message, 'error');
  }
};

window.reopenSession = async function (id) {
  try {
    const data = await api(`/api/sessions/${encodeURIComponent(id)}/reopen`, { method: 'POST' });
    if (data.session) {
      state.sessions = state.sessions.map((s) => (s.id === id ? data.session : s));
      syncSessionsUi();
    }
    showToast('Session reopened.', 'info');
    if (!state.storage || state.storage.persistent) {
      await refreshAll();
    }
  } catch (err) {
    showToast(err.message, 'error');
  }
};

window.deleteSession = async function (id) {
  if (!confirm(`Delete session ${id} and its submissions?`)) return;
  try {
    await api(`/api/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' });
    state.sessions = state.sessions.filter((s) => s.id !== id);
    state.submissions = state.submissions.filter((sub) => sub.sessionId !== id);
    syncSessionsUi();
    renderSubmissionsPanel();
    showToast(`Deleted session ${id}.`, 'success');
    if (!state.storage || state.storage.persistent) {
      await refreshAll();
    }
  } catch (err) {
    showToast(err.message, 'error');
  }
};

window.viewSubmissions = async function (id, name) {
  try {
    const data = await api(`/api/sessions/${encodeURIComponent(id)}/submissions`);
    document.getElementById('sub-session-title').textContent = name;
    document.getElementById('sub-export-csv').href = `/api/export/submissions.csv?sessionId=${encodeURIComponent(id)}`;
    document.getElementById('sub-export-xlsx').href = `/api/export/submissions.xlsx?sessionId=${encodeURIComponent(id)}`;
    const tbody = document.getElementById('session-submissions-tbody');
    if (data.submissions.length === 0) {
      tbody.innerHTML = '<tr><td colspan="4" style="color:var(--muted)">No submissions yet.</td></tr>';
    } else {
      tbody.innerHTML = data.submissions
        .map(
          (sub) => `
          <tr>
            <td>${new Date(sub.submittedAt).toLocaleTimeString()}</td>
            <td class="mono">${esc(sub.ticketId)}</td>
            <td>${esc(sub.playerName)}</td>
            <td><strong style="font-size:16px; color:#a5b4fc;">${sub.selectedNumber}</strong></td>
          </tr>
        `
        )
        .join('');
    }
    document.getElementById('session-submissions-card').style.display = 'block';
  } catch (err) {
    showToast(err.message, 'error');
  }
};

document.getElementById('close-subs-btn').addEventListener('click', () => {
  document.getElementById('session-submissions-card').style.display = 'none';
});

// Round Winner Evaluation
function renderEvalSessionSelect() {
  const sel = document.getElementById('eval-session-select');
  const prev = sel.value;
  if (state.sessions.length === 0) {
    sel.innerHTML = '<option value="">No sessions available</option>';
    return;
  }
  sel.innerHTML = state.sessions
    .map(
      (s) =>
        `<option value="${esc(s.id)}">${esc(s.name)} (${s.status} • ${s.submissionCount} entries${s.roundResult ? ' • Saved' : ''})</option>`
    )
    .join('');
  if (prev && state.sessions.some((s) => s.id === prev)) sel.value = prev;
}

async function runWinnerEvaluation(mode, extra = {}) {
  const sessionId = document.getElementById('eval-session-select').value;
  const pointsPerWin = Number(document.getElementById('eval-points').value || 1);
  const saveToLeaderboard = document.getElementById('save-to-leaderboard').checked;
  if (!sessionId) {
    showToast('Please create and select a session first.', 'error');
    return;
  }
  try {
    const data = await api(`/api/sessions/${encodeURIComponent(sessionId)}/evaluate`, {
      method: 'POST',
      body: JSON.stringify({ mode, pointsPerWin, saveToLeaderboard, ...extra }),
    });
    renderWinnerResults(data);
    if (saveToLeaderboard) {
      showToast(`Saved "${data.sessionName}" result to the Final Leaderboard!`, 'success');
      await Promise.all([loadSessions(), loadLeaderboard(), loadSubmissions()]);
    }
  } catch (err) {
    showToast(err.message, 'error');
  }
}

function renderWinnerResults(res) {
  const el = document.getElementById('winner-results');
  let ruleText = '';
  if (res.mode === 'least') {
    ruleText = `Least Number (${res.winningValue ?? 'N/A'})`;
  } else if (res.mode === 'highest') {
    ruleText = `Highest Number (${res.winningValue ?? 'N/A'})`;
  } else {
    ruleText = `Specific Range (${res.range.min} to ${res.range.max})`;
  }

  if (res.winners.length === 0) {
    el.innerHTML = `
      <div class="alert alert-info">
        <strong>${esc(res.sessionName)}</strong> — ${ruleText}<br />
        No matching winners found across ${res.totalSubmissions} submission(s).
      </div>
    `;
    return;
  }

  const cards = res.winners
    .map(
      (w) => `
      <div class="winner-card">
        <div class="winner-number">${w.selectedNumber}</div>
        <div style="font-weight:700; font-size:16px; margin-top:4px;">${esc(w.playerName)}</div>
        <div class="mono" style="font-size:12px; color:var(--muted);">${esc(w.ticketId)}</div>
      </div>
    `
    )
    .join('');

  el.innerHTML = `
    <div class="winner-banner">
      <div style="font-size:12px; font-weight:700; text-transform:uppercase; color:#6ee7b7;">
        ${esc(res.sessionName)} • ${ruleText} • ${res.winners.length} Winner(s) out of ${res.totalSubmissions}
        ${res.savedToLeaderboard ? ' • Added to Final Leaderboard' : ''}
      </div>
      <div class="winner-cards">${cards}</div>
    </div>
  `;
}

document.getElementById('btn-eval-least').addEventListener('click', () => runWinnerEvaluation('least'));
document.getElementById('btn-eval-highest').addEventListener('click', () => runWinnerEvaluation('highest'));
document.getElementById('btn-eval-range').addEventListener('click', () => {
  const min = Number(document.getElementById('range-min').value);
  const max = Number(document.getElementById('range-max').value);
  runWinnerEvaluation('range', { min, max });
});

// Final Combined Leaderboard
async function loadLeaderboard() {
  const data = await api('/api/leaderboard');
  state.leaderboard = data;
  renderLeaderboard(data);
}

function renderLeaderboard(data) {
  const grandBox = document.getElementById('grand-winner-box');
  const roundsBox = document.getElementById('leaderboard-rounds-summary');
  const thead = document.getElementById('leaderboard-thead');
  const tbody = document.getElementById('leaderboard-tbody');

  if (data.grandWinners && data.grandWinners.length > 0) {
    const cards = data.grandWinners
      .map(
        (gw) => `
        <div class="winner-card">
          <div class="winner-number">#${gw.rank} • ${gw.totalPoints} pts</div>
          <div style="font-weight:700; font-size:17px; margin-top:4px;">${esc(gw.playerName)}</div>
          <div class="mono" style="font-size:12px; color:var(--muted);">${esc(gw.ticketId)} • ${gw.totalWins} round win(s)</div>
        </div>
      `
      )
      .join('');
    grandBox.innerHTML = `
      <div class="winner-banner">
        <div style="font-size:12px; font-weight:700; text-transform:uppercase; color:#6ee7b7;">
          Overall Leaderboard Winner(s) • Across ${data.evaluatedRoundsCount} Evaluated Round(s)
        </div>
        <div class="winner-cards">${cards}</div>
      </div>
    `;
  } else {
    grandBox.innerHTML = `
      <div class="alert alert-info">
        Evaluate at least one closed round in Tab 3 (<strong>Round Winner Evaluation</strong>) to crown the combined Final Leaderboard winner(s).
      </div>
    `;
  }

  roundsBox.innerHTML = (data.rounds || [])
    .map((r) => {
      const rule = r.roundResult
        ? `${r.roundResult.mode.toUpperCase()}${r.roundResult.range ? ` (${r.roundResult.range.min}-${r.roundResult.range.max})` : ''}`
        : 'Not Evaluated';
      return `<span class="pill ${r.evaluated ? 'ok' : 'warn'}">${esc(r.sessionName)}: ${esc(rule)}</span>`;
    })
    .join('');

  const roundHeaders = (data.rounds || []).map((r) => `<th>${esc(r.sessionName)}</th>`).join('');
  thead.innerHTML = `
    <tr>
      <th>Rank</th>
      <th>Player</th>
      <th>Ticket ID</th>
      <th>Total Points</th>
      <th>Round Wins</th>
      <th>Played</th>
      <th>Sum of Picks</th>
      ${roundHeaders}
    </tr>
  `;

  if (!data.leaderboard || data.leaderboard.length === 0) {
    tbody.innerHTML = `<tr><td colspan="${7 + (data.rounds || []).length}" style="color:var(--muted)">No players or rounds recorded yet.</td></tr>`;
    return;
  }

  tbody.innerHTML = data.leaderboard
    .map((row) => {
      const roundCells = (row.roundBreakdown || [])
        .map((rb) => {
          if (rb.selectedNumber === null) {
            return '<td style="color:var(--muted)">—</td>';
          }
          if (rb.won) {
            return `<td><span class="pill ok">${rb.selectedNumber} WIN (+${rb.points})</span></td>`;
          }
          return `<td><span class="pill">${rb.selectedNumber}</span></td>`;
        })
        .join('');

      return `
        <tr>
          <td><strong>#${row.rank}</strong></td>
          <td><strong>${esc(row.playerName)}</strong></td>
          <td class="mono">${esc(row.ticketId)}</td>
          <td><strong style="font-size:16px; color:#34d399;">${row.totalPoints}</strong></td>
          <td>${row.totalWins}</td>
          <td>${row.roundsPlayed}</td>
          <td>${row.totalNumberSum}</td>
          ${roundCells}
        </tr>
      `;
    })
    .join('');
}

document.getElementById('refresh-leaderboard-btn').addEventListener('click', loadLeaderboard);

function renderSubmissionsPanel() {
  document.getElementById('pill-submissions').textContent = `Stored Submissions: ${state.submissions.length}`;
  document.getElementById('all-subs-count').textContent = state.submissions.length;

  if (state.exportFiles) {
    document.getElementById('stored-paths-box').innerHTML = `
      <div class="mono">
        <div>Submissions CSV: ${esc(state.exportFiles.subCsvPath)}</div>
        <div>Submissions Excel: ${esc(state.exportFiles.subXlsxPath)}</div>
        <div>Leaderboard CSV: ${esc(state.exportFiles.lbCsvPath)}</div>
        <div>Leaderboard Excel: ${esc(state.exportFiles.lbXlsxPath)}</div>
        <div>Tickets CSV: ${esc(state.exportFiles.tktCsvPath)}</div>
        <div>Tickets Excel: ${esc(state.exportFiles.tktXlsxPath)}</div>
      </div>
    `;
  }

  const tbody = document.getElementById('all-submissions-tbody');
  if (state.submissions.length === 0) {
    tbody.innerHTML = '<tr><td colspan="5" style="color:var(--muted)">No submissions stored yet.</td></tr>';
  } else {
    tbody.innerHTML = [...state.submissions]
      .reverse()
      .map(
        (sub) => `
        <tr>
          <td>${new Date(sub.submittedAt).toLocaleString()}</td>
          <td>${esc(sub.sessionName)}</td>
          <td class="mono">${esc(sub.ticketId)}</td>
          <td>${esc(sub.playerName)}</td>
          <td><strong style="font-size:15px; color:#a5b4fc;">${sub.selectedNumber}</strong></td>
        </tr>
      `
      )
      .join('');
  }
}

// Stored Data & Exports
async function loadSubmissions() {
  const data = await api('/api/submissions');
  state.submissions = data.submissions || [];
  state.exportFiles = data.exportFiles || null;
  renderSubmissionsPanel();
}

document.getElementById('refresh-exports-btn').addEventListener('click', loadSubmissions);

async function clearAllCache() {
  const ok = confirm(
    'This will permanently clear all generated tickets, sessions, submissions, leaderboard results, browser cache, and reset CSV/Excel files to start from scratch. Continue?'
  );
  if (!ok) return;
  try {
    let serverResetDone = true;
    try {
      await api('/api/reset', { method: 'POST' });
    } catch (resetErr) {
      if (resetErr.status === 404) {
        serverResetDone = false;
        // Fallback for an older running server process: delete every ticket & expire active sessions
        for (const t of [...state.tickets]) {
          await api(`/api/tickets/${encodeURIComponent(t.ticketId)}`, { method: 'DELETE' }).catch(() => {});
        }
        for (const s of [...state.sessions]) {
          if (s.status === 'ACTIVE') {
            await api(`/api/sessions/${encodeURIComponent(s.id)}/expire`, { method: 'POST' }).catch(() => {});
          }
        }
      } else {
        throw resetErr;
      }
    }

    try {
      localStorage.removeItem(BROWSER_CACHE_KEY);
      localStorage.clear();
      sessionStorage.clear();
      if (window.caches && caches.keys) {
        const keys = await caches.keys();
        await Promise.all(keys.map((k) => caches.delete(k)));
      }
    } catch {
      // ignore storage errors
    }

    state.tickets = [];
    state.sessions = [];
    state.submissions = [];
    state.leaderboard = null;

    document.getElementById('generate-tickets-form').reset();
    document.getElementById('create-session-form').reset();
    document.getElementById('numbers-per-ticket').value = '10';
    document.getElementById('num-count-label').textContent = '10';
    document.getElementById('per-set-check').checked = true;
    document.getElementById('decade-sets-box').style.display = 'block';
    document.querySelectorAll('.decade-cb').forEach((cb) => {
      cb.checked = true;
    });
    document.getElementById('eval-points').value = '1';
    document.getElementById('range-min').value = '1';
    document.getElementById('range-max').value = '25';
    document.getElementById('save-to-leaderboard').checked = true;
    document.getElementById('session-submissions-card').style.display = 'none';
    document.getElementById('session-submissions-tbody').innerHTML = '';
    document.getElementById('winner-results').innerHTML =
      '<p style="color:var(--muted)">Select a closed session and choose Least Number, Highest Number, or a Specific Range.</p>';
    document.getElementById('ticket-search').value = '';

    await refreshAll();
    updateBrowserCacheStatus();

    if (serverResetDone) {
      showToast('All server data, CSV/Excel files, and browser cache cleared! Ready to start fresh.', 'success');
    } else {
      showToast(
        'Browser cache & all tickets cleared (older server running: restart "npm start" once to also wipe old closed session history).',
        'info'
      );
    }
  } catch (err) {
    showToast(err.message, 'error');
  }
}

document.getElementById('btn-clear-cache-top').addEventListener('click', clearAllCache);
document.getElementById('btn-clear-cache-tab').addEventListener('click', clearAllCache);

refreshAll();
