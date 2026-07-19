// ─── Unbrewed Agent Dashboard SPA ──────────────────────

const $ = (sel) => document.querySelector(sel);
const app = $('#app');
const nav = $('#nav');
const userInfo = $('#user-info');
const loginScreen = $('#login-screen');

let currentUser = null;
let currentPage = 'dashboard';
let liveWs = null;
let liveGames = new Map();
let currentGameDetailId = null;
let detailElapsedTimer = null;

// ─── API helpers ───────────────────────────────────────

async function api(path, opts = {}) {
  const res = await fetch(`/api${path}`, {
    headers: { 'Content-Type': 'application/json', ...opts.headers },
    ...opts,
  });
  if (res.status === 401) {
    currentUser = null;
    showLogin();
    return null;
  }
  return res.json();
}

// ─── Auth ──────────────────────────────────────────────

async function checkAuth() {
  const data = await api('/me');
  if (data?.user) {
    currentUser = data.user;
    showApp();
  } else {
    showLogin();
  }
}

function showLogin() {
  loginScreen.style.display = 'flex';
  $('header').style.display = 'none';
  app.style.display = 'none';
}

function showApp() {
  loginScreen.style.display = 'none';
  $('header').style.display = 'flex';
  app.style.display = 'block';
  renderUserInfo();
  connectLiveWs();
  const requestedGameId = new URLSearchParams(location.search).get('game');
  if (requestedGameId) navigate('game-detail', { id: requestedGameId });
  else navigate(currentPage);
}

function renderUserInfo() {
  if (!currentUser) return;
  userInfo.innerHTML = `
    ${currentUser.avatar_url ? `<img src="${currentUser.avatar_url}" alt="">` : ''}
    <span>${currentUser.username}</span>
    <a href="/auth/logout">logout</a>
  `;
}

// ─── Navigation ────────────────────────────────────────

nav.addEventListener('click', (e) => {
  const link = e.target.closest('[data-page]');
  if (!link) return;
  e.preventDefault();
  navigate(link.dataset.page);
});

function navigate(page, params = {}) {
  currentPage = page;
  if (page !== 'game-detail') currentGameDetailId = null;
  const nextUrl = page === 'game-detail' && params.id
    ? `${location.pathname}?game=${encodeURIComponent(params.id)}`
    : location.pathname;
  history.replaceState({}, '', nextUrl);
  if (detailElapsedTimer) {
    clearInterval(detailElapsedTimer);
    detailElapsedTimer = null;
  }
  nav.querySelectorAll('a').forEach((a) => a.classList.toggle('active', a.dataset.page === page));
  switch (page) {
    case 'dashboard': renderDashboard(); break;
    case 'live': renderLive(); break;
    case 'history': renderHistory(); break;
    case 'new-game': renderNewGame(); break;
    case 'game-detail': renderGameDetail(params.id); break;
  }
}

// ─── Dashboard ─────────────────────────────────────────

async function renderDashboard() {
  app.innerHTML = '<div class="card"><div class="card-title">Loading...</div></div>';
  const [stats, games] = await Promise.all([api('/stats'), api('/games?limit=5')]);
  if (!stats || !games) return;

  const winRate = stats.total_games > 0 ? Math.round((stats.wins / stats.total_games) * 100) : 0;

  app.innerHTML = `
    <div class="stats-grid">
      <div class="stat-card">
        <div class="stat-value">${stats.total_games}</div>
        <div class="stat-label">Total Games</div>
      </div>
      <div class="stat-card">
        <div class="stat-value win">${stats.wins}</div>
        <div class="stat-label">Wins</div>
      </div>
      <div class="stat-card">
        <div class="stat-value loss">${stats.losses}</div>
        <div class="stat-label">Losses</div>
      </div>
      <div class="stat-card">
        <div class="stat-value">${winRate}%</div>
        <div class="stat-label">Win Rate</div>
      </div>
      <div class="stat-card">
        <div class="stat-value">${formatCost(stats.total_cost)}</div>
        <div class="stat-label">Total Spent</div>
      </div>
      <div class="stat-card">
        <div class="stat-value">${stats.active}</div>
        <div class="stat-label">Active</div>
      </div>
    </div>

    ${games.activeGames?.length ? `
      <div class="card">
        <div class="card-header">
          <div class="card-title">🔴 Active Games</div>
        </div>
        <div id="dashboard-active"></div>
      </div>
    ` : ''}

    <div class="card">
      <div class="card-header">
        <div class="card-title">Recent Games</div>
        <button class="btn btn-outline btn-sm" onclick="navigate('history')">View All</button>
      </div>
      <div class="game-list">
        ${games.games.length ? games.games.map(gameRow).join('') : '<div class="empty-state"><p>No games yet. Start your first game!</p></div>'}
      </div>
    </div>
  `;

  if (games.activeGames?.length) {
    const container = $('#dashboard-active');
    games.activeGames.forEach((g) => {
      container.innerHTML += liveGameCard(g);
    });
  }
}

// ─── Live Games ────────────────────────────────────────

function renderLive() {
  app.innerHTML = `
    <div class="card">
      <div class="card-header">
        <div class="card-title">🔴 Live Games</div>
        <button class="btn btn-gold btn-sm" onclick="navigate('new-game')">+ New Game</button>
      </div>
      <div id="live-container">
        ${liveGames.size === 0 ? '<div class="empty-state"><p>No live games. Start one!</p></div>' : ''}
      </div>
    </div>
  `;
  updateLiveContainer();
}

function updateLiveContainer() {
  const container = $('#live-container');
  if (!container) return;
  if (liveGames.size === 0) {
    container.innerHTML = '<div class="empty-state"><p>No live games right now.</p></div>';
    return;
  }
  container.innerHTML = '';
  for (const [id, info] of liveGames) {
    container.innerHTML += liveGameCard(info);
  }
}

function liveGameCard(game) {
  const lastReason = game.lastEvent?.type === 'action' ? game.lastEvent.data.reason : null;
  const isThinking = game.lastEvent?.type === 'thinking';
  return `
    <div class="live-card" data-game-id="${game.gameId}" onclick="navigate('game-detail', {id:'${game.gameId}'})">
      <div style="display:flex;justify-content:space-between;align-items:center">
        <div>
          <span class="live-badge">● LIVE</span>
          <span style="margin-left:0.75rem;font-weight:600">${game.heroId}</span>
          <span style="color:var(--text-dim);margin-left:0.5rem">${game.model}</span>
        </div>
        <button class="btn btn-danger btn-sm" onclick="event.stopPropagation();cancelGame('${game.gameId}')">Cancel</button>
      </div>
      <div class="live-info">
        <div class="live-info-item">
          <div class="live-info-value">${game.currentTurn}</div>
          <div class="live-info-label">Turn</div>
        </div>
        <div class="live-info-item">
          <div class="live-info-value">${game.actionsSubmitted}</div>
          <div class="live-info-label">Actions</div>
        </div>
        <div class="live-info-item">
          <div class="live-info-value">${formatCost(game.totalCostUsd)}</div>
          <div class="live-info-label">Cost</div>
        </div>
        <div class="live-info-item">
          <div class="live-info-value">${Math.round((Date.now() - game.startedAt) / 1000)}s</div>
          <div class="live-info-label">Elapsed</div>
        </div>
      </div>
      ${isThinking ? '<div class="live-thinking">🤔 Thinking...</div>' : ''}
      ${lastReason ? `<div class="live-thinking">💭 ${lastReason}</div>` : ''}
    </div>
  `;
}

// ─── History ───────────────────────────────────────────

async function renderHistory() {
  app.innerHTML = '<div class="card"><div class="card-title">Loading...</div></div>';
  const data = await api('/games?limit=100');
  if (!data) return;

  app.innerHTML = `
    <div class="card">
      <div class="card-header">
        <div class="card-title">Game History</div>
        <button class="btn btn-gold btn-sm" onclick="navigate('new-game')">+ New Game</button>
      </div>
      <div class="game-list">
        ${data.games.length ? data.games.map(gameRow).join('') : '<div class="empty-state"><p>No games yet.</p></div>'}
      </div>
    </div>
  `;
}

function gameRow(g) {
  const result = g.status === 'active' ? 'active' : g.won === true ? 'won' : g.won === false ? 'lost' : g.status;
  const resultLabel = g.status === 'active' ? '● LIVE' : g.won === true ? 'WIN' : g.won === false ? 'LOSS' : g.status.toUpperCase();
  const time = g.started_at ? timeAgo(new Date(g.started_at)) : '';
  const cost = g.total_cost_usd != null ? formatCost(g.total_cost_usd) : '-';

  const replayUrl = g.room_id && g.status === 'completed' ? `https://unbrewed.xyz/pro/replays` : null;

  return `
    <div class="game-row" onclick="navigate('game-detail', {id:'${g.id}'})">
      <div>
        <span class="game-hero">${g.our_hero}</span>
        <span class="game-vs"> vs ${g.opponent_hero || '?'}</span>
      </div>
      <div class="game-model">${g.llm_model}</div>
      <div class="game-result ${result}">${resultLabel}</div>
      <div class="game-cost">${cost}</div>
      <div>${g.total_turns ?? '-'} turns</div>
      <div>${g.map_title || '-'}</div>
      <div class="game-time">
        ${time}
        ${replayUrl ? `<a href="${replayUrl}" target="_blank" class="replay-link-sm" onclick="event.stopPropagation()">▶</a>` : ''}
      </div>
    </div>
  `;
}

// ─── Game Detail ───────────────────────────────────────

async function renderGameDetail(id) {
  currentGameDetailId = id;
  app.innerHTML = '<div class="card"><div class="card-title">Loading...</div></div>';
  const data = await api(`/games/${id}`);
  if (!data || currentGameDetailId !== id) return;
  const g = data.game;
  const result = g.status === 'active' ? 'ACTIVE' : g.won === true ? 'WIN' : g.won === false ? 'LOSS' : g.status.toUpperCase();
  const resultClass = g.won === true ? 'win' : g.won === false ? 'loss' : '';
  const replayUrl = g.room_id ? 'https://unbrewed.xyz/pro/replays' : null;

  if (data.live) liveGames.set(id, data.live);

  app.innerHTML = `
    <div class="detail-header">
      <div>
        <button class="btn btn-outline btn-sm" onclick="navigate('history')" style="margin-bottom:0.75rem">← Back</button>
        <div class="detail-title">${escapeHtml(g.our_hero)} vs ${escapeHtml(g.opponent_hero || '?')}</div>
        <div class="detail-meta">
          <span>Model: <strong>${escapeHtml(g.llm_model)}</strong></span>
          <span>Map: ${escapeHtml(g.map_title || '?')}</span>
          ${replayUrl ? `<a href="${replayUrl}" target="_blank" class="replay-link">▶ Replays</a>` : ''}
          <button class="replay-link log-button" onclick="copyGameLogUrl('${id}')">Copy private log URL</button>
          <button class="replay-link log-button" onclick="downloadGameDiagnostic('${id}')">Download diagnostic</button>
          <button class="replay-link log-button" onclick="createDebugShare('${id}')">Create debug share</button>
          <button class="replay-link log-button" onclick="revokeDebugShares('${id}')">Revoke shares</button>
        </div>
      </div>
      <div class="game-result ${resultClass}" id="detail-result" style="font-size:1.5rem">${result}</div>
    </div>

    <div id="game-live-monitor"></div>

    ${g.analysis_summary || g.analysis_mistakes || g.analysis_lessons ? `
      <div class="analysis-section">
        <div class="card-title" style="margin-bottom:0.75rem">Post-Game Analysis</div>
        ${g.analysis_summary ? `<div class="analysis-box"><h4>Summary</h4>${escapeHtml(g.analysis_summary)}</div>` : ''}
        ${g.analysis_mistakes ? `<div class="analysis-box"><h4>Mistakes</h4>${escapeHtml(g.analysis_mistakes)}</div>` : ''}
        ${g.analysis_lessons ? `<div class="analysis-box"><h4>Lessons</h4>${escapeHtml(g.analysis_lessons)}</div>` : ''}
      </div>
    ` : ''}

    <div class="card" style="margin-top:1.5rem">
      <div class="card-title" id="action-log-title" style="margin-bottom:0.75rem">Action Log (${data.actions.length} actions)</div>
      <div class="action-log" id="action-log-container"></div>
    </div>
  `;

  renderGameLiveMonitor(g, data.live);
  renderActionLog(id, data.actions);
  detailElapsedTimer = setInterval(() => {
    if (currentGameDetailId === id) updateDetailElapsed();
  }, 1000);
}

async function copyGameLogUrl(gameId) {
  const url = `${location.origin}${location.pathname}?game=${encodeURIComponent(gameId)}`;
  try {
    await navigator.clipboard.writeText(url);
    alert('Owner-only game log URL copied. The viewer must sign in as the same Discord user.');
  } catch {
    prompt('Copy this owner-only game log URL:', url);
  }
}

async function createDebugShare(gameId) {
  const confirmed = confirm(
    'Create a public diagnostic URL? Anyone with it can read all prompts and private hand snapshots for 7 days. Your OpenRouter key is never included.'
  );
  if (!confirmed) return;
  const data = await api(`/games/${gameId}/share`, { method: 'POST', body: '{}' });
  if (!data?.url) {
    alert(data?.error || 'Could not create debug share.');
    return;
  }
  try {
    await navigator.clipboard.writeText(data.url);
    alert(`Public debug URL copied. It expires ${new Date(data.expiresAt).toLocaleString()}.`);
  } catch {
    prompt('Copy this public debug URL:', data.url);
  }
}

async function revokeDebugShares(gameId) {
  const data = await api(`/games/${gameId}/share`, { method: 'DELETE' });
  if (!data) return;
  alert(`Revoked ${data.revoked || 0} active debug share(s).`);
}

async function downloadGameDiagnostic(gameId) {
  const response = await fetch(`/api/games/${gameId}/export`);
  if (!response.ok) {
    alert('Could not export this game diagnostic.');
    return;
  }
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `unbrewed-game-${gameId}.json`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function renderGameLiveMonitor(game, live) {
  const container = $('#game-live-monitor');
  if (!container) return;
  const isActive = game.status === 'active' && live;
  const turn = live?.currentTurn || game.total_turns || 0;
  const actions = live?.actionsSubmitted ?? game.total_actions ?? 0;
  const cost = live?.totalCostUsd ?? game.total_cost_usd ?? 0;
  const turnOwner = formatTurnOwner(live?.turnOwner, game.our_seat, live?.thinking);
  const phase = live?.phase || (isActive ? 'Waiting for state' : 'Complete');
  const startedAt = live?.startedAt || new Date(game.started_at).getTime();

  container.innerHTML = `
    <div class="live-detail-panel ${isActive ? 'active' : ''}" data-started-at="${startedAt}">
      <div class="live-detail-heading">
        <span class="${isActive ? 'live-badge' : 'game-result'}">${isActive ? '● LIVE' : 'COMPLETE'}</span>
        <span class="live-detail-thinking" id="detail-thinking">${live?.thinking ? '🤔 Model is thinking…' : escapeHtml(phase)}</span>
      </div>
      <div class="live-info">
        <div class="live-info-item"><div class="live-info-value" id="detail-turn">${turn || '-'}</div><div class="live-info-label">Turn</div></div>
        <div class="live-info-item"><div class="live-info-value" id="detail-turn-owner">${escapeHtml(turnOwner)}</div><div class="live-info-label">Who Acts</div></div>
        <div class="live-info-item"><div class="live-info-value" id="detail-actions">${actions}</div><div class="live-info-label">Actions</div></div>
        <div class="live-info-item"><div class="live-info-value" id="detail-cost">${formatCost(cost)}</div><div class="live-info-label">Total Cost</div></div>
        <div class="live-info-item"><div class="live-info-value" id="detail-elapsed">${formatDuration(Date.now() - startedAt)}</div><div class="live-info-label">Elapsed</div></div>
        <div class="live-info-item"><div class="live-info-value live-phase" id="detail-phase">${escapeHtml(phase)}</div><div class="live-info-label">Phase</div></div>
      </div>
    </div>
  `;
}

function renderActionLog(gameId, actions) {
  const container = $('#action-log-container');
  const title = $('#action-log-title');
  if (!container) return;
  if (title) title.textContent = `Action Log (${actions.length} actions)`;
  container.innerHTML = actions.length === 0
    ? '<div class="empty-state"><p>No actions recorded yet.</p></div>'
    : actions.slice().reverse().map((a) => actionRowHtml(gameId, a)).join('');
}

function actionRowHtml(gameId, action) {
  const promptTokens = Number(action.prompt_tokens || 0);
  const completionTokens = Number(action.completion_tokens || 0);
  const totalTokens = Number(action.total_tokens || promptTokens + completionTokens);
  const cacheReadTokens = Number(action.cache_read_tokens || 0);
  const validity = actionValidationInfo(action);
  const cache = cacheStatusInfo(action);
  return `
    <button class="action-row action-row-clickable" onclick="openActionDetail('${gameId}', '${action.id}')">
      <div class="action-index">#${action.action_index}</div>
      <div class="action-reason">${escapeHtml(action.reason || '-')}</div>
      <div class="action-validity ${validity.className}" title="${escapeHtml(validity.title)}">${validity.label}</div>
      <div class="action-tokens" title="${promptTokens} input + ${completionTokens} output; ${cacheReadTokens} cache-read">${cache.icon} ${formatTokenCount(totalTokens)} tok</div>
      <div class="action-cost">${formatCost(action.cost_usd)}</div>
      <div class="action-latency">${formatDuration(action.latency_ms)}</div>
    </button>
  `;
}

async function refreshGameDetail(gameId) {
  if (currentGameDetailId !== gameId) return;
  const data = await api(`/games/${gameId}`);
  if (!data || currentGameDetailId !== gameId) return;
  if (data.live) liveGames.set(gameId, data.live);
  renderGameLiveMonitor(data.game, data.live);
  renderActionLog(gameId, data.actions);
}

async function openActionDetail(gameId, actionId) {
  const data = await api(`/games/${gameId}/actions/${actionId}`);
  if (!data?.action) return;
  const action = data.action;
  const totalTokens = Number(action.total_tokens || (Number(action.prompt_tokens || 0) + Number(action.completion_tokens || 0)));
  const validity = actionValidationInfo(action);
  const cache = cacheStatusInfo(action);
  const systemChars = String(action.system_prompt || '').length;
  const userChars = String(action.user_prompt || '').length;
  const modal = document.createElement('div');
  modal.className = 'modal-overlay';
  modal.id = 'action-detail-modal';
  modal.innerHTML = `
    <div class="modal-content action-detail-modal">
      <div class="modal-header">
        <div>
          <div class="card-title">Action #${action.action_index}</div>
          <div class="action-detail-summary">
            <span class="action-validity ${validity.className}">${validity.label}</span> · ${cache.label} · ${formatCost(action.cost_usd)} · ${formatTokenCount(totalTokens)} tokens · ${formatDuration(action.latency_ms)}
          </div>
        </div>
        <button class="btn btn-outline btn-sm" onclick="closeActionDetail()">✕</button>
      </div>
      <div class="action-detail-metrics">
        <div><strong>${Number(action.prompt_tokens || 0).toLocaleString()}</strong><span>Input tokens</span></div>
        <div><strong>${Number(action.completion_tokens || 0).toLocaleString()}</strong><span>Output tokens</span></div>
        <div><strong>${totalTokens.toLocaleString()}</strong><span>Total tokens</span></div>
        <div><strong>${Number(action.cache_read_tokens || 0).toLocaleString()}</strong><span>Cache-read tokens</span></div>
        <div><strong>${Number(action.cache_write_tokens || 0).toLocaleString()}</strong><span>Cache-write tokens</span></div>
        <div><strong>${formatCost(action.cost_usd)}</strong><span>Cost</span></div>
        <div><strong>${action.legal_action_count ?? '-'}</strong><span>Legal actions</span></div>
        <div><strong>${escapeHtml(action.native_finish_reason || action.finish_reason || '-')}</strong><span>Finish reason</span></div>
      </div>
      <div class="action-detail-scroll">
        <section><h3>System prompt · ${systemChars.toLocaleString()} characters</h3><pre id="action-system-prompt"></pre></section>
        <section><h3>User prompt / game state · ${userChars.toLocaleString()} characters</h3><pre id="action-user-prompt"></pre></section>
        <section><h3>Model output</h3><pre id="action-model-output"></pre></section>
        <section><h3>Selected action</h3><pre id="action-selected-action"></pre></section>
        ${action.error_message ? '<section><h3>Error / fallback</h3><pre id="action-error"></pre></section>' : ''}
      </div>
    </div>
  `;
  document.body.appendChild(modal);
  $('#action-system-prompt').textContent = action.system_prompt || 'Not recorded for this older action.';
  $('#action-user-prompt').textContent = prettyJson(action.user_prompt);
  $('#action-model-output').textContent = action.model_output || `No visible model output. Finish reason: ${action.native_finish_reason || action.finish_reason || 'unknown'}.`;
  $('#action-selected-action').textContent = JSON.stringify(action.selected_action, null, 2);
  if (action.error_message && $('#action-error')) $('#action-error').textContent = action.error_message;
  modal.addEventListener('click', (event) => { if (event.target === modal) closeActionDetail(); });
}

function closeActionDetail() {
  $('#action-detail-modal')?.remove();
}

function updateDetailElapsed() {
  const panel = document.querySelector('.live-detail-panel');
  const elapsed = $('#detail-elapsed');
  if (!panel || !elapsed) return;
  elapsed.textContent = formatDuration(Date.now() - Number(panel.dataset.startedAt || Date.now()));
}

function updateDetailFromLiveEvent(game, event) {
  const data = event.data || {};
  const setText = (selector, value) => {
    const element = $(selector);
    if (element && value !== undefined && value !== null) element.textContent = String(value);
  };
  if (data.turn !== undefined) setText('#detail-turn', data.turn || '-');
  if (data.turnOwner !== undefined || event.type === 'thinking') {
    setText('#detail-turn-owner', formatTurnOwner(data.turnOwner ?? game.turnOwner, null, event.type === 'thinking'));
  }
  if (event.type === 'action' && data.actionIndex !== undefined) setText('#detail-actions', data.actionIndex + 1);
  if (data.costUsd !== undefined) setText('#detail-cost', formatCost(game.totalCostUsd));
  if (data.phase !== undefined) setText('#detail-phase', data.phase || '-');
  setText('#detail-thinking', event.type === 'thinking' ? '🤔 Model is thinking…' : (data.reason || data.phase || 'Waiting for next state'));
}

// ─── New Game ──────────────────────────────────────────

// ─── Model Explorer ────────────────────────────────────

let allModels = [];
let modelsLoaded = false;
let selectedModel = localStorage.getItem('selected_model') || 'anthropic/claude-sonnet-4-20250514';
let selectedModelName = localStorage.getItem('selected_model_name') || 'Claude Sonnet 4';

const PROVIDER_COLORS = {
  anthropic: '#d4a27f', openai: '#74aa9c', google: '#4285f4', deepseek: '#5b8def',
  'meta-llama': '#0668e1', 'x-ai': '#999', mistralai: '#ff7000', qwen: '#6c5ce7',
  cohere: '#39594d', microsoft: '#00a4ef', nvidia: '#76b900', perplexity: '#20808d',
  'amazon-bedrock': '#ff9900',
};

async function loadModels() {
  if (modelsLoaded) return;
  try {
    const data = await api('/models');
    if (data?.data) {
      // Filter to text models only, exclude free/router/image models
      allModels = data.data
        .filter((m) => {
          if (!m.id || !m.name) return false;
          // Skip image-only, embedding, free routers
          if (m.id.includes(':free') && !m.id.includes('free')) return false;
          if (m.architecture?.output_modalities && !m.architecture.output_modalities.includes('text')) return false;
          return true;
        })
        .map((m) => ({
          id: m.id,
          name: m.name,
          provider: m.id.split('/')[0] || 'unknown',
          contextLength: m.context_length || 0,
          promptPrice: parseFloat(m.pricing?.prompt || '0'),
          completionPrice: parseFloat(m.pricing?.completion || '0'),
          cacheReadPrice: parseFloat(m.pricing?.input_cache_read || '0'),
          cacheWritePrice: parseFloat(m.pricing?.input_cache_write || '0'),
          description: m.description?.slice(0, 200) || '',
          created: m.created || 0,
        }))
        .sort((a, b) => b.created - a.created);
      modelsLoaded = true;
    }
  } catch (err) {
    console.error('Failed to load models:', err);
  }
}

function getProviderColor(provider) {
  return PROVIDER_COLORS[provider] || '#888';
}

function formatPrice(pricePerToken) {
  if (!pricePerToken || pricePerToken === 0) return 'free';
  // Price is per token, convert to per 1M tokens
  const perMillion = pricePerToken * 1_000_000;
  if (perMillion < 0.01) return '<$0.01/M';
  if (perMillion < 1) return `$${perMillion.toFixed(2)}/M`;
  return `$${perMillion.toFixed(1)}/M`;
}

function renderModelPicker() {
  const picker = $('#model-picker');
  if (!picker) return;

  const providerSlug = selectedModel.split('/')[0] || '';
  const color = getProviderColor(providerSlug);

  picker.innerHTML = `
    <div class="model-selected-summary" onclick="openModelExplorer()">
      <div>
        <span class="model-selected-provider" style="color: ${color}">${providerSlug}</span>
        <span class="model-selected-name">${selectedModelName}</span>
      </div>
      <span class="model-dropdown-arrow">⚡ Cache enabled · Browse ▶</span>
    </div>
  `;
  $('#model-select').value = selectedModel;
}

function openModelExplorer() {
  // Create modal overlay
  const modal = document.createElement('div');
  modal.id = 'model-explorer-modal';
  modal.className = 'modal-overlay';
  modal.innerHTML = `
    <div class="modal-content model-explorer">
      <div class="modal-header">
        <div>
          <h2 class="card-title" style="font-size:1rem">Select a Cache-Capable Model</h2>
          <div class="form-hint">Only models advertising discounted prompt-cache reads are available.</div>
        </div>
        <button class="btn btn-outline btn-sm" onclick="closeModelExplorer()">✕</button>
      </div>
      <div class="model-explorer-toolbar">
        <input type="text" id="model-search" class="model-search-input" placeholder="Search models..." oninput="filterModels()">
        <div class="model-provider-filters" id="provider-filters"></div>
      </div>
      <div class="model-explorer-body" id="model-explorer-body">
        <div class="empty-state"><p>Loading models...</p></div>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
  modal.addEventListener('click', (e) => { if (e.target === modal) closeModelExplorer(); });

  loadModels().then(() => {
    renderProviderFilters();
    filterModels();
    $('#model-search')?.focus();
  });
}

let activeProviderFilter = null;

function renderProviderFilters() {
  const container = $('#provider-filters');
  if (!container) return;

  // Get unique providers sorted by model count
  const providerCounts = {};
  allModels.forEach((m) => {
    providerCounts[m.provider] = (providerCounts[m.provider] || 0) + 1;
  });
  const providers = Object.entries(providerCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15); // Top 15 providers

  container.innerHTML = `
    <button class="provider-filter-btn ${!activeProviderFilter ? 'active' : ''}"
            onclick="setProviderFilter(null)">All</button>
    ${providers.map(([p, count]) => `
      <button class="provider-filter-btn ${activeProviderFilter === p ? 'active' : ''}"
              style="--pcolor: ${getProviderColor(p)}"
              onclick="setProviderFilter('${p}')">${p} <span class="provider-count">${count}</span></button>
    `).join('')}
  `;
}

function setProviderFilter(provider) {
  activeProviderFilter = provider;
  renderProviderFilters();
  filterModels();
}

function filterModels() {
  const searchEl = $('#model-search');
  const query = searchEl ? searchEl.value.toLowerCase().trim() : '';
  const body = $('#model-explorer-body');
  if (!body) return;

  let filtered = allModels;
  if (activeProviderFilter) {
    filtered = filtered.filter((m) => m.provider === activeProviderFilter);
  }
  if (query) {
    filtered = filtered.filter((m) =>
      m.name.toLowerCase().includes(query) ||
      m.id.toLowerCase().includes(query) ||
      m.provider.toLowerCase().includes(query) ||
      m.description.toLowerCase().includes(query)
    );
  }

  if (filtered.length === 0) {
    body.innerHTML = '<div class="empty-state"><p>No models found.</p></div>';
    return;
  }

  // Group by provider
  const groups = {};
  filtered.forEach((m) => {
    if (!groups[m.provider]) groups[m.provider] = [];
    groups[m.provider].push(m);
  });

  // Sort providers: ones with selected model first, then by count
  const sortedProviders = Object.keys(groups).sort((a, b) => {
    const aHasSelected = groups[a].some((m) => m.id === selectedModel);
    const bHasSelected = groups[b].some((m) => m.id === selectedModel);
    if (aHasSelected && !bHasSelected) return -1;
    if (!aHasSelected && bHasSelected) return 1;
    return groups[b].length - groups[a].length;
  });

  body.onclick = (e) => {
    const el = e.target.closest('.mexplorer-model');
    if (!el) return;
    pickModel(el.dataset.modelId, el.dataset.modelName);
  };

  body.innerHTML = sortedProviders.map((provider) => `
    <div class="mexplorer-group">
      <div class="mexplorer-group-header" style="border-left-color: ${getProviderColor(provider)}">
        <span class="model-provider-name">${provider}</span>
        <span class="provider-count">${groups[provider].length}</span>
      </div>
      <div class="mexplorer-models">
        ${groups[provider].map((m) => `
          <div class="mexplorer-model ${m.id === selectedModel ? 'selected' : ''}"
               data-model-id="${m.id}"
               data-model-name="${m.name.replace(/"/g, '&quot;')}">
            <div class="mexplorer-model-main">
              <div class="mexplorer-model-name">${m.name}</div>
              <div class="mexplorer-model-id">${m.id}</div>
            </div>
            <div class="mexplorer-model-meta">
              <div class="mexplorer-model-ctx">${m.contextLength > 0 ? (m.contextLength >= 1000000 ? `${(m.contextLength/1000000).toFixed(1)}M` : `${Math.round(m.contextLength/1000)}k`) : '?'} ctx</div>
              <div class="mexplorer-model-price">
                <span class="price-label">in</span> ${formatPrice(m.promptPrice)}
                <span class="price-label">cached</span> ${formatPrice(m.cacheReadPrice)}
                <span class="price-label">out</span> ${formatPrice(m.completionPrice)}
              </div>
            </div>
          </div>
        `).join('')}
      </div>
    </div>
  `).join('');
}

function pickModel(modelId, modelName) {
  selectedModel = modelId;
  selectedModelName = modelName;
  localStorage.setItem('selected_model', modelId);
  localStorage.setItem('selected_model_name', modelName);
  if ($('#model-select')) $('#model-select').value = modelId;
  closeModelExplorer();
  renderModelPicker();
}

function closeModelExplorer() {
  const modal = $('#model-explorer-modal');
  if (modal) modal.remove();
}

function renderNewGame() {
  const savedApiKey = localStorage.getItem('openrouter_key') || '';
  app.innerHTML = `
    <div class="card" style="max-width:700px">
      <div class="card-title" style="margin-bottom:1.25rem">Start New Game</div>

      <div class="form-group">
        <label>Game Mode</label>
        <div class="form-radio-group">
          <label class="form-radio"><input type="radio" name="mode" value="bot" checked> vs Bot</label>
          <label class="form-radio"><input type="radio" name="mode" value="join"> Join Room</label>
        </div>
      </div>

      <div class="form-row">
        <div class="form-group">
          <label>Your Hero</label>
          <input id="hero-id" type="text" value="king-taranis" placeholder="e.g. baba-yaga, king-kong">
          <div class="form-hint">Hero ID from Unbrewed Pro</div>
        </div>
        <div class="form-group" id="bot-difficulty-group">
          <label>Bot Difficulty</label>
          <select id="bot-difficulty">
            <option value="easy">Easy</option>
            <option value="medium">Medium</option>
            <option value="hard">Hard</option>
          </select>
        </div>
      </div>

      <div class="form-group" id="room-id-group" style="display:none">
        <label>Room ID</label>
        <input id="room-id" type="text" placeholder="Paste room code here">
      </div>

      <div class="form-group">
        <label>LLM Model (OpenRouter)</label>
        <div class="model-picker" id="model-picker"></div>
        <input type="hidden" id="model-select" value="">
      </div>

      <div class="form-group">
        <label>OpenRouter API Key</label>
        <input id="api-key" type="password" value="${savedApiKey}" placeholder="sk-or-...">
        <div class="form-hint">Stored in your browser only. Never sent to our server except for gameplay.</div>
      </div>

      <button class="btn btn-gold" onclick="startGame()">⚔️ Start Game</button>
    </div>
  `;

  // Render model picker and replace any stale, non-cache-capable selection.
  renderModelPicker();
  void loadModels().then(() => {
    if (allModels.length > 0 && !allModels.some((model) => model.id === selectedModel)) {
      pickModel(allModels[0].id, allModels[0].name);
    }
  });

  // Toggle mode
  document.querySelectorAll('input[name="mode"]').forEach((radio) => {
    radio.addEventListener('change', () => {
      const isBot = document.querySelector('input[name="mode"]:checked').value === 'bot';
      $('#bot-difficulty-group').style.display = isBot ? '' : 'none';
      $('#room-id-group').style.display = isBot ? 'none' : '';
    });
  });
}

async function startGame() {
  const mode = document.querySelector('input[name="mode"]:checked').value;
  const heroId = $('#hero-id').value.trim();
  const model = $('#model-select').value;
  const apiKey = $('#api-key').value.trim();

  if (!heroId || !model || !apiKey) {
    alert('Please fill in all required fields');
    return;
  }

  // Save API key locally
  localStorage.setItem('openrouter_key', apiKey);

  const body = { heroId, model, openRouterApiKey: apiKey };
  if (mode === 'bot') {
    body.botDifficulty = $('#bot-difficulty').value;
  } else {
    body.roomId = $('#room-id').value.trim();
    if (!body.roomId) { alert('Room ID is required'); return; }
  }

  const result = await api('/games', {
    method: 'POST',
    body: JSON.stringify(body),
  });
  if (result?.gameId) {
    navigate('live');
  } else if (result?.error) {
    alert(result.error);
  }
}

async function cancelGame(gameId) {
  if (!confirm('Cancel this game?')) return;
  await api(`/games/${gameId}`, { method: 'DELETE' });
  liveGames.delete(gameId);
  if (currentPage === 'live') renderLive();
}

// ─── Live WebSocket ────────────────────────────────────

function connectLiveWs() {
  if (liveWs) return;
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  liveWs = new WebSocket(`${protocol}//${location.host}/api/live`);

  liveWs.onmessage = (e) => {
    const data = JSON.parse(e.data);

    if (data.type === 'snapshot') {
      data.games.forEach((g) => {
        if (g.userId === currentUser?.id) liveGames.set(g.gameId, g);
      });
      if (currentPage === 'live') updateLiveContainer();
      return;
    }

    // Game events — update our local live game map
    const gameId = data.gameId;
    if (!gameId) return;

    // Only process events for the current user
    if (data.data?.userId && data.data.userId !== currentUser?.id) return;

    let game = liveGames.get(gameId);

    if (data.type === 'started') {
      // We might not have the full info yet, create a placeholder
      if (!game) {
        game = {
          gameId,
          userId: currentUser?.id,
          heroId: '?',
          model: '?',
          status: 'active',
          currentTurn: 0,
          actionsSubmitted: 0,
          totalCostUsd: 0,
          lastEvent: data,
          startedAt: Date.now(),
        };
        liveGames.set(gameId, game);
      }
    }

    if (game) {
      game.lastEvent = data;
      if (data.data?.turn !== undefined) game.currentTurn = data.data.turn;
      if (data.data?.turnOwner !== undefined) game.turnOwner = data.data.turnOwner;
      if (data.data?.phase !== undefined) game.phase = data.data.phase;
      if (data.type === 'action' && data.data?.actionIndex !== undefined) {
        game.actionsSubmitted = data.data.actionIndex + 1;
      }
      if (data.data?.costUsd !== undefined) game.totalCostUsd += data.data.costUsd;
      game.thinking = data.type === 'thinking';

      if (currentGameDetailId === gameId) {
        updateDetailFromLiveEvent(game, data);
        if (data.type === 'action' || data.type === 'ended') void refreshGameDetail(gameId);
      }

      if (data.type === 'ended') {
        liveGames.delete(gameId);
        if (currentPage === 'dashboard') renderDashboard();
      }
    }

    if (currentPage === 'live') updateLiveContainer();
  };

  liveWs.onclose = () => {
    liveWs = null;
    setTimeout(connectLiveWs, 3000);
  };
}

// ─── Utilities ─────────────────────────────────────────

function actionValidationInfo(action) {
  if (action.choice_source === 'model' && !action.error_message) {
    return {
      label: 'VALID',
      className: 'valid',
      title: 'The model output selected an in-range legal action. Engine acceptance is inferred from subsequent state.',
    };
  }
  return {
    label: 'FALLBACK',
    className: 'invalid',
    title: action.error_message || 'The model output was invalid or unavailable, so a fallback action was submitted.',
  };
}

function cacheStatusInfo(action) {
  const reads = Number(action.cache_read_tokens || 0);
  const writes = Number(action.cache_write_tokens || 0);
  if (reads > 0) return { icon: '⚡', label: `Cache hit: ${formatTokenCount(reads)} tokens` };
  if (writes > 0) return { icon: '↥', label: `Cache write: ${formatTokenCount(writes)} tokens` };
  return { icon: '○', label: 'No cache tokens reported' };
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function prettyJson(value) {
  if (!value) return 'Not recorded for this older action.';
  try {
    return JSON.stringify(typeof value === 'string' ? JSON.parse(value) : value, null, 2);
  } catch {
    return String(value);
  }
}

function formatTokenCount(value) {
  const n = Number(value || 0);
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return n.toLocaleString();
}

function formatTurnOwner(owner, ourSeat, thinking = false) {
  if (thinking) return 'Agent';
  if (!owner) return 'Unknown';
  if (ourSeat && owner === ourSeat) return 'Agent';
  if (owner === 'opponent') return 'Opponent';
  return String(owner);
}

function formatCost(value) {
  const n = Number(value || 0);
  if (n === 0) return '$0';
  if (n >= 1) return `$${n.toFixed(2)}`;
  if (n >= 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(6)}`;
}

function formatDuration(ms) {
  const n = Number(ms || 0);
  if (n === 0) return '-';
  if (n < 1000) return `${n}ms`;
  if (n < 60000) return `${(n / 1000).toFixed(1)}s`;
  return `${Math.floor(n / 60000)}m ${Math.round((n % 60000) / 1000)}s`;
}

function timeAgo(date) {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

// ─── Init ──────────────────────────────────────────────

checkAuth();
