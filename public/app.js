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
  navigate(currentPage);
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
      <div class="game-time">${time}</div>
    </div>
  `;
}

// ─── Game Detail ───────────────────────────────────────

async function renderGameDetail(id) {
  app.innerHTML = '<div class="card"><div class="card-title">Loading...</div></div>';
  const data = await api(`/games/${id}`);
  if (!data) return;
  const g = data.game;
  const actions = data.actions;

  const result = g.status === 'active' ? 'ACTIVE' : g.won === true ? 'WIN' : g.won === false ? 'LOSS' : g.status.toUpperCase();
  const resultClass = g.won === true ? 'win' : g.won === false ? 'loss' : '';

  app.innerHTML = `
    <div class="detail-header">
      <div>
        <button class="btn btn-outline btn-sm" onclick="navigate('history')" style="margin-bottom:0.75rem">← Back</button>
        <div class="detail-title">${g.our_hero} vs ${g.opponent_hero || '?'}</div>
        <div class="detail-meta">
          <span>Model: <strong>${g.llm_model}</strong></span>
          <span>Map: ${g.map_title || '?'}</span>
          <span>Turns: ${g.total_turns ?? '?'}</span>
          <span>Cost: <strong class="game-cost">${formatCost(g.total_cost_usd)}</strong></span>
        </div>
      </div>
      <div class="game-result ${resultClass}" style="font-size:1.5rem">${result}</div>
    </div>

    ${g.analysis_summary || g.analysis_mistakes || g.analysis_lessons ? `
      <div class="analysis-section">
        <div class="card-title" style="margin-bottom:0.75rem">Post-Game Analysis</div>
        ${g.analysis_summary ? `<div class="analysis-box"><h4>Summary</h4>${g.analysis_summary}</div>` : ''}
        ${g.analysis_mistakes ? `<div class="analysis-box"><h4>Mistakes</h4>${g.analysis_mistakes}</div>` : ''}
        ${g.analysis_lessons ? `<div class="analysis-box"><h4>Lessons</h4>${g.analysis_lessons}</div>` : ''}
      </div>
    ` : ''}

    <div class="card" style="margin-top:1.5rem">
      <div class="card-title" style="margin-bottom:0.75rem">Action Log (${actions.length} actions)</div>
      <div class="action-log">
        ${actions.map((a) => `
          <div class="action-row">
            <div class="action-index">#${a.action_index}</div>
            <div class="action-reason">${a.reason || '-'}</div>
            <div class="action-source ${a.choice_source}">${a.choice_source}</div>
            <div class="action-cost">${formatCost(a.cost_usd)}</div>
            <div class="action-latency">${a.latency_ms || 0}ms</div>
          </div>
        `).join('')}
        ${actions.length === 0 ? '<div class="empty-state"><p>No actions recorded yet.</p></div>' : ''}
      </div>
    </div>
  `;
}

// ─── New Game ──────────────────────────────────────────

// ─── Model Catalog ─────────────────────────────────────

const MODEL_CATALOG = [
  {
    provider: 'Anthropic',
    color: '#d4a27f',
    models: [
      { id: 'anthropic/claude-sonnet-4-20250514', name: 'Claude Sonnet 4', tier: 'pro', price: '$$' },
      { id: 'anthropic/claude-3.5-sonnet', name: 'Claude 3.5 Sonnet', tier: 'pro', price: '$$' },
      { id: 'anthropic/claude-3.5-haiku', name: 'Claude 3.5 Haiku', tier: 'budget', price: '$' },
    ],
  },
  {
    provider: 'OpenAI',
    color: '#74aa9c',
    models: [
      { id: 'openai/gpt-4.1', name: 'GPT-4.1', tier: 'pro', price: '$$' },
      { id: 'openai/gpt-4o', name: 'GPT-4o', tier: 'pro', price: '$$' },
      { id: 'openai/gpt-4o-mini', name: 'GPT-4o Mini', tier: 'budget', price: '$' },
      { id: 'openai/o4-mini', name: 'o4-mini', tier: 'reasoning', price: '$$' },
    ],
  },
  {
    provider: 'Google',
    color: '#4285f4',
    models: [
      { id: 'google/gemini-2.5-pro-preview', name: 'Gemini 2.5 Pro', tier: 'pro', price: '$$' },
      { id: 'google/gemini-2.5-flash-preview', name: 'Gemini 2.5 Flash', tier: 'budget', price: '$' },
      { id: 'google/gemini-2.5-flash-preview:thinking', name: 'Gemini 2.5 Flash Thinking', tier: 'reasoning', price: '$' },
    ],
  },
  {
    provider: 'DeepSeek',
    color: '#5b8def',
    models: [
      { id: 'deepseek/deepseek-r1', name: 'DeepSeek R1', tier: 'reasoning', price: '$' },
      { id: 'deepseek/deepseek-chat-v3-0324', name: 'DeepSeek V3', tier: 'budget', price: '$' },
      { id: 'deepseek/deepseek-v4-flash', name: 'DeepSeek V4 Flash', tier: 'budget', price: '$' },
    ],
  },
  {
    provider: 'Meta',
    color: '#0668e1',
    models: [
      { id: 'meta-llama/llama-4-maverick', name: 'Llama 4 Maverick', tier: 'pro', price: '$' },
      { id: 'meta-llama/llama-4-scout', name: 'Llama 4 Scout', tier: 'budget', price: '$' },
    ],
  },
  {
    provider: 'xAI',
    color: '#999',
    models: [
      { id: 'x-ai/grok-3', name: 'Grok 3', tier: 'pro', price: '$$' },
      { id: 'x-ai/grok-3-mini', name: 'Grok 3 Mini', tier: 'budget', price: '$' },
    ],
  },
  {
    provider: 'Mistral',
    color: '#ff7000',
    models: [
      { id: 'mistralai/mistral-large-2411', name: 'Mistral Large', tier: 'pro', price: '$$' },
      { id: 'mistralai/mistral-small-3.1-24b-instruct', name: 'Mistral Small 3.1', tier: 'budget', price: '$' },
    ],
  },
  {
    provider: 'Qwen',
    color: '#6c5ce7',
    models: [
      { id: 'qwen/qwen3-235b-a22b', name: 'Qwen3 235B', tier: 'pro', price: '$' },
      { id: 'qwen/qwen3-30b-a3b', name: 'Qwen3 30B', tier: 'budget', price: '$' },
    ],
  },
];

let selectedModel = localStorage.getItem('selected_model') || 'anthropic/claude-sonnet-4-20250514';

function renderModelPicker() {
  const picker = $('#model-picker');
  if (!picker) return;

  picker.innerHTML = MODEL_CATALOG.map((group) => `
    <div class="model-group">
      <div class="model-group-header" style="border-left-color: ${group.color}">
        <span class="model-provider-name">${group.provider}</span>
      </div>
      <div class="model-group-models">
        ${group.models.map((m) => `
          <div class="model-option ${m.id === selectedModel ? 'selected' : ''}"
               data-model-id="${m.id}"
               onclick="selectModel('${m.id}')">
            <div class="model-option-name">${m.name}</div>
            <div class="model-option-meta">
              <span class="model-tier model-tier-${m.tier}">${m.tier}</span>
              <span class="model-price">${m.price}</span>
            </div>
          </div>
        `).join('')}
      </div>
    </div>
  `).join('');

  // Set the hidden input
  $('#model-select').value = selectedModel;
}

function selectModel(modelId) {
  selectedModel = modelId;
  localStorage.setItem('selected_model', modelId);
  // Update UI
  document.querySelectorAll('.model-option').forEach((el) => {
    el.classList.toggle('selected', el.dataset.modelId === modelId);
  });
  $('#model-select').value = modelId;
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

  // Render model picker
  renderModelPicker();

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
      if (data.data?.actionIndex !== undefined) game.actionsSubmitted = data.data.actionIndex + 1;
      if (data.data?.costUsd !== undefined) game.totalCostUsd += data.data.costUsd;

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

function formatCost(value) {
  const n = Number(value || 0);
  if (n === 0) return '$0';
  if (n >= 1) return `$${n.toFixed(2)}`;
  if (n >= 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(6)}`;
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
