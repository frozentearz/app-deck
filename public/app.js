import { t, setLang, initI18n, currentLang } from './i18n.js';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

const state = {
  apps: [],
  appStatus: {}, // Map of appId -> boolean | null (port alive status)
  searchQuery: '',
  system: { daemon: false, startup: false, pm2Installed: false },
  expandedLogs: new Set(), // Set of appIds with expanded log trays
  expandedLogRows: new Set(), // Set of logEntryId with expanded output
  loading: true,
  pollTimer: null,
};

initI18n();

/* ==========================================================================
   API Client & Utilities
   ========================================================================== */

async function api(path, options = {}) {
  const res = await fetch(path, options);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(body.error ?? `${res.status}`);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

function toast(msg, { error = false } = {}) {
  const el = $('#toast');
  if (!el) return;
  el.textContent = msg;
  el.classList.toggle('error', error);
  el.classList.remove('hidden');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.add('hidden'), 4000);
}

async function copyText(text, successMsg) {
  if (!text) return;
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      toast(successMsg || t('copied'));
      return;
    }
  } catch {}

  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    ta.style.top = '-9999px';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const successful = document.execCommand('copy');
    document.body.removeChild(ta);
    if (successful) {
      toast(successMsg || t('copied'));
      return;
    }
  } catch {}

  toast(t('copyFailed'), { error: true });
}

function formatDateTime(timestamp) {
  if (!timestamp) return '';
  const d = new Date(timestamp);
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const h = String(d.getHours()).padStart(2, '0');
  const min = String(d.getMinutes()).padStart(2, '0');
  const s = String(d.getSeconds()).padStart(2, '0');
  return `${m}-${day} ${h}:${min}:${s}`;
}

function formatRelativeDir(dir) {
  if (!dir) return '';
  return dir.replace(/^\/Users\/[^/]+/, '~');
}

/* ==========================================================================
   Data Fetching & Polling
   ========================================================================== */

async function loadApps() {
  try {
    state.apps = await api('/api/apps');
    state.loading = false;
    render();
    updateGlobalStats();
    probeAllAppsStatus().then(updateGlobalStats);
  } catch (err) {
    state.loading = false;
    toast(t('requestFailed') + err.message, { error: true });
  }
}

async function loadSystem() {
  try {
    const sys = await api('/api/system/status');
    state.system = sys;
    updateEngineHubUI();
  } catch (err) {
    console.warn('system status unavailable:', err.message);
  }
}

async function refreshRunsIncremental() {
  try {
    const apps = await api('/api/apps');
    state.apps = apps;
    updateCardsTelemetry();
    await probeAllAppsStatus();
    updateGlobalStats();
  } catch {
    // Silent fail on background poll
  }
}

/** 探活所有配置了端口的项目（TCP 真实探活） */
async function probeAllAppsStatus() {
  const targets = state.apps.filter((a) => a.port);
  if (targets.length === 0) return;
  await Promise.allSettled(
    targets.map(async (app) => {
      try {
        const res = await api(`/api/apps/${encodeURIComponent(app.id)}/status`);
        state.appStatus[app.id] = res.online;
        updateAppProbeUI(app.id, res.online);
      } catch {
        // 静默失败，下次轮询重试
      }
    })
  );
}

function updateAppProbeUI(appId, online) {
  const chip = document.querySelector(`.status-chip[data-probe-id="${appId}"]`);
  if (!chip) return;
  const ping = chip.querySelector('.status-ping');
  const text = chip.querySelector('.status-state-text');
  const isOnline = online === true;
  const isOffline = online === false;

  chip.classList.toggle('is-online', isOnline);
  chip.classList.toggle('is-offline', isOffline);

  if (ping) {
    ping.className = `status-ping ${isOnline ? 'online' : isOffline ? 'offline' : 'unknown'}`;
  }
  if (text) {
    text.className = `status-state-text ${isOnline ? 'online' : 'offline'}`;
    text.textContent = isOnline ? t('online') : t('offline');
  }
}

function updateGlobalStats() {
  const totalApps = state.apps.length;
  let totalButtons = 0;
  let runningRuns = 0;
  let onlineServices = 0;

  for (const app of state.apps) {
    totalButtons += app.buttons.length;
    for (const b of app.buttons) {
      if (b.state === 'running') runningRuns++;
    }
    if (state.appStatus[app.id] === true) {
      onlineServices++;
    }
  }

  const statsEl = $('#globalStatsText');
  if (statsEl) {
    const onlinePart = onlineServices > 0 ? ` · ${onlineServices} ${t('onlineServices')}` : '';
    statsEl.textContent = `${totalApps} ${t('totalApps')}${onlinePart} · ${runningRuns} ${t('activeRuns')}`;
  }
}

function updateEngineHubUI() {
  const { daemon, startup, pm2Installed } = state.system;
  const engineDot = $('#engineDot');
  const engineText = $('#engineStatusText');
  const daemonSwitch = $('#daemonSwitch');
  const startupSwitch = $('#startupSwitch');
  const pm2Diag = $('#pm2DiagStatus');

  if (daemonSwitch) {
    daemonSwitch.disabled = !pm2Installed;
    daemonSwitch.checked = daemon;
  }
  if (startupSwitch) {
    startupSwitch.disabled = !pm2Installed;
    startupSwitch.checked = startup;
  }

  if (pm2Diag) {
    pm2Diag.textContent = pm2Installed ? (daemon ? t('engineRunning') : t('engineStandalone')) : t('engineMissing');
    pm2Diag.style.color = pm2Installed ? 'var(--ok)' : 'var(--fail)';
  }

  if (!pm2Installed) {
    if (engineDot) engineDot.className = 'engine-indicator warning';
    if (engineText) engineText.textContent = t('engineMissing');
    return;
  }

  if (daemon) {
    if (engineDot) engineDot.className = 'engine-indicator online';
    if (engineText) engineText.textContent = t('engineRunning');
  } else {
    if (engineDot) engineDot.className = 'engine-indicator standalone';
    if (engineText) engineText.textContent = t('engineStandalone');
  }
}

/* ==========================================================================
   Incremental Card Telemetry Update
   ========================================================================== */

function updateCardsTelemetry() {
  for (const app of state.apps) {
    const card = document.querySelector(`.card[data-app-id="${app.id}"]`);
    if (!card) continue;

    // Update buttons
    const tiles = card.querySelectorAll('.action-tile');
    app.buttons.forEach((button, idx) => {
      const tile = tiles[idx];
      if (!tile) return;
      const isRunning = button.state === 'running';

      tile.classList.toggle('is-running', isRunning);
      const dot = tile.querySelector('.tile-status-dot');
      if (dot) {
        dot.className = `tile-status-dot ${isRunning ? 'running' : (button.type === 'managed' ? 'idle' : 'idle')}`;
      }

      const triggerBtn = tile.querySelector('.btn-trigger');
      if (triggerBtn) {
        if (isRunning) {
          triggerBtn.className = 'btn-trigger stop';
          triggerBtn.innerHTML = `<span>■</span> <span>${t('stop')}</span>`;
        } else {
          triggerBtn.className = 'btn-trigger';
          triggerBtn.innerHTML = `<span>▶</span> <span>${t('run')}</span>`;
        }
      }
    });

    // Update activity strip
    updateCardActivityStrip(app.id, card);
  }
}

async function updateCardActivityStrip(appId, card) {
  const strip = card.querySelector('.card-activity-strip');
  if (!strip) return;
  try {
    const res = await api(`/api/apps/${encodeURIComponent(appId)}/logs`);
    const entries = res.entries || [];
    const latest = entries[0];
    const summaryText = strip.querySelector('.activity-text');
    const tag = strip.querySelector('.activity-tag');
    const time = strip.querySelector('.activity-time');

    if (!latest) {
      if (summaryText) summaryText.textContent = t('noHistory');
      if (tag) tag.className = 'activity-tag hidden';
      if (time) time.textContent = '';
      return;
    }

    if (tag) {
      tag.classList.remove('hidden');
      if (latest.killed) {
        tag.className = 'activity-tag fail';
        tag.textContent = t('killed');
      } else if (latest.success) {
        tag.className = 'activity-tag ok';
        tag.textContent = `✓ 0`;
      } else {
        tag.className = 'activity-tag fail';
        tag.textContent = `✗ ${latest.exitCode ?? 1}`;
      }
    }

    if (time) {
      time.textContent = new Date(latest.startedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    }

    if (summaryText) {
      summaryText.textContent = `${latest.label || ''}: ${latest.summary || 'done'}`;
    }

    // If dock is active for this app and not streaming live, refresh dock history
    if (dockState.appId === appId && !dockState.eventSource) {
      dockState.history = entries;
      if (!dockState.history.some(h => h.id === dockState.selectedId)) {
        dockState.selectedId = dockState.history[0]?.id || null;
      }
      renderDockHistoryList();
      renderDockOutput();
    }
  } catch {
    // Ignore error
  }
}

/* ==========================================================================
   Main Render Function
   ========================================================================== */

function getFilteredApps() {
  const q = state.searchQuery.trim().toLowerCase();
  if (!q) return state.apps;
  return state.apps.filter((app) => {
    if (app.name?.toLowerCase().includes(q)) return true;
    if (app.id?.toLowerCase().includes(q)) return true;
    if (app.description?.toLowerCase().includes(q)) return true;
    if (app.dir?.toLowerCase().includes(q)) return true;
    if (String(app.port || '').includes(q)) return true;
    if (app.url?.toLowerCase().includes(q)) return true;
    return app.buttons?.some((b) => b.label?.toLowerCase().includes(q) || b.command?.toLowerCase().includes(q));
  });
}

function render() {
  const list = $('#appList');
  const empty = $('#emptyState');
  const noSearch = $('#noSearchResults');
  list.innerHTML = '';

  if (state.loading) {
    empty.classList.add('hidden');
    noSearch.classList.add('hidden');
    list.innerHTML = `
      <div class="skeleton-card">
        <div class="skeleton-bar" style="width: 35%;"></div>
        <div class="skeleton-bar" style="width: 60%;"></div>
        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-top: 10px;">
          <div class="skeleton-bar" style="height: 48px;"></div>
          <div class="skeleton-bar" style="height: 48px;"></div>
        </div>
      </div>
      <div class="skeleton-card">
        <div class="skeleton-bar" style="width: 25%;"></div>
        <div class="skeleton-bar" style="width: 50%;"></div>
      </div>
    `;
    return;
  }

  if (state.apps.length === 0) {
    empty.classList.remove('hidden');
    noSearch.classList.add('hidden');
    return;
  }
  empty.classList.add('hidden');

  const filtered = getFilteredApps();
  if (filtered.length === 0) {
    noSearch.classList.remove('hidden');
    return;
  }
  noSearch.classList.add('hidden');

  for (const app of filtered) {
    list.appendChild(createAppCard(app));
  }
}

/* ==========================================================================
   Card Component Builder
   ========================================================================== */

function createAppCard(app) {
  const card = document.createElement('section');
  card.className = `card ${app.pinned ? 'is-pinned' : ''}`;
  card.dataset.appId = app.id;

  // 1. Card Header
  const head = document.createElement('div');
  head.className = 'card-head';

  const info = document.createElement('div');
  info.className = 'card-main-info';

  const titleRow = document.createElement('div');
  titleRow.className = 'card-title-row';

  const name = document.createElement('h2');
  name.className = 'card-name';
  name.textContent = app.name;

  const idBadge = document.createElement('span');
  idBadge.className = 'card-id-badge';
  idBadge.textContent = app.id;
  idBadge.title = t('copyAppId');
  idBadge.addEventListener('click', () => copyText(app.id, `${t('copied')}: ${app.id}`));

  titleRow.append(name, idBadge);

  if (app.pinned) {
    const pinBadge = document.createElement('span');
    pinBadge.className = 'pinned-badge';
    pinBadge.title = t('pinned');
    pinBadge.innerHTML = `
      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="17" x2="12" y2="22"></line><path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24Z"></path></svg>
      <span>${t('pinned')}</span>
    `;
    titleRow.appendChild(pinBadge);
  }

  info.appendChild(titleRow);

  if (app.description) {
    const desc = document.createElement('p');
    desc.className = 'card-desc';
    desc.textContent = app.description;
    info.appendChild(desc);
  }

  // Meta Chips: URL (with live status if port configured), Dir
  const chips = document.createElement('div');
  chips.className = 'card-meta-chips';

  const online = state.appStatus[app.id];
  const isOnline = online === true;
  const isOffline = online === false;

  if (app.url) {
    const chip = document.createElement('span');
    if (app.port) {
      chip.className = `meta-chip status-chip ${isOnline ? 'is-online' : isOffline ? 'is-offline' : ''}`;
      chip.dataset.probeId = app.id;
      chip.innerHTML = `
        <span class="status-ping ${isOnline ? 'online' : isOffline ? 'offline' : 'unknown'}"></span>
        <span class="status-state-text ${isOnline ? 'online' : 'offline'}">${isOnline ? t('online') : t('offline')}</span>
        <a href="${app.url}" target="_blank" rel="noreferrer">
          <span>${app.url.replace(/^https?:\/\//, '')}</span>
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
        </a>
      `;
    } else {
      chip.className = 'meta-chip';
      const a = document.createElement('a');
      a.href = app.url;
      a.target = '_blank';
      a.rel = 'noreferrer';
      a.innerHTML = `
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
        <span>${app.url.replace(/^https?:\/\//, '')}</span>
      `;
      chip.appendChild(a);
    }
    chips.appendChild(chip);
  }

  // Only show separate port badge if no URL is configured or URL doesn't contain this port
  if (app.port && (!app.url || !app.url.includes(String(app.port)))) {
    const portChip = document.createElement('span');
    portChip.className = `meta-chip status-chip clickable ${isOnline ? 'is-online' : isOffline ? 'is-offline' : ''}`;
    portChip.dataset.probeId = app.id;
    portChip.title = t('copyPort');
    portChip.innerHTML = `
      <span class="status-ping ${isOnline ? 'online' : isOffline ? 'offline' : 'unknown'}"></span>
      <span class="status-state-text ${isOnline ? 'online' : 'offline'}">${isOnline ? t('online') : t('offline')}</span>
      <span>:${app.port}</span>
    `;
    portChip.addEventListener('click', () => copyText(String(app.port), `${t('copied')} :${app.port}`));
    chips.appendChild(portChip);
  }

  if (app.dir) {
    const dirChip = document.createElement('span');
    dirChip.className = 'meta-chip clickable';
    dirChip.title = `${t('copyDir')}: ${app.dir}`;
    dirChip.innerHTML = `
      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
      <span>${formatRelativeDir(app.dir)}</span>
    `;
    dirChip.addEventListener('click', () => copyText(app.dir, `${t('copied')}: ${app.dir}`));
    chips.appendChild(dirChip);
  }

  info.appendChild(chips);

  // Actions on right: + Button, Pin, Edit, Delete
  // Actions on right: Pin, Terminal, + Button, More Menu (⋯)
  const actions = document.createElement('div');
  actions.className = 'card-actions';

  // 1. Pin
  const pinBtn = document.createElement('button');
  pinBtn.className = `icon-btn pin-btn ${app.pinned ? 'active' : ''}`;
  pinBtn.dataset.tooltip = app.pinned ? t('unpin') : t('pin');
  pinBtn.innerHTML = `
    <svg class="pin-svg" width="13" height="13" viewBox="0 0 24 24" fill="${app.pinned ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <line x1="12" y1="17" x2="12" y2="22"></line>
      <path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24Z"></path>
    </svg>
  `;
  pinBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    togglePinApp(app);
  });

  // 2. Terminal
  const termBtn = document.createElement('button');
  termBtn.className = 'icon-btn term-btn';
  const termPath = app.dir ? formatRelativeDir(app.dir) : '';
  termBtn.dataset.tooltip = termPath ? `${t('openTerminal')}: ${termPath}` : t('openTerminal');
  termBtn.innerHTML = `
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
      <polyline class="term-prompt" points="4 17 10 11 4 5"></polyline>
      <line x1="12" y1="19" x2="20" y2="19"></line>
    </svg>
  `;
  termBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    openAppTerminal(app);
  });

  // 3. Add Button
  const addBtn = document.createElement('button');
  addBtn.className = 'compact-add-btn';
  addBtn.dataset.tooltip = t('addButton');
  addBtn.innerHTML = `
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>
    <span>${t('addButton')}</span>
  `;
  addBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    openButtonForm(app, null);
  });

  // 4. More Menu (⋯)
  const moreWrap = document.createElement('div');
  moreWrap.className = 'card-more-wrap';

  const moreBtn = document.createElement('button');
  moreBtn.className = 'icon-btn more-trigger-btn';
  moreBtn.dataset.tooltip = t('more');
  moreBtn.dataset.tooltipPos = 'left';
  moreBtn.innerHTML = `
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/></svg>
  `;

  const dropdown = document.createElement('div');
  dropdown.className = 'card-dropdown-menu hidden';

  const editItem = document.createElement('button');
  editItem.className = 'dropdown-item';
  editItem.innerHTML = `
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
    <span>${t('edit')}</span>
  `;
  editItem.addEventListener('click', (e) => {
    e.stopPropagation();
    dropdown.classList.add('hidden');
    openAppForm(app);
  });

  const delItem = document.createElement('button');
  delItem.className = 'dropdown-item danger';
  delItem.innerHTML = `
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
    <span>${t('delete')}</span>
  `;
  delItem.addEventListener('click', (e) => {
    e.stopPropagation();
    dropdown.classList.add('hidden');
    deleteApp(app);
  });

  dropdown.append(editItem, delItem);

  moreBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    document.querySelectorAll('.card-dropdown-menu').forEach(m => {
      if (m !== dropdown) m.classList.add('hidden');
    });
    dropdown.classList.toggle('hidden');
  });

  moreWrap.append(moreBtn, dropdown);

  actions.append(pinBtn, termBtn, addBtn, moreWrap);
  head.append(info, actions);
  card.appendChild(head);

  // 2. Action Tiles Section
  const btnSec = document.createElement('div');
  btnSec.className = 'card-buttons-section';

  const grid = document.createElement('div');
  grid.className = 'buttons-grid';

  for (const button of app.buttons) {
    grid.appendChild(createActionTile(app, button));
  }

  if (app.buttons.length === 0) {
    const addPrompt = document.createElement('button');
    addPrompt.className = 'add-tile-btn';
    addPrompt.textContent = `+ ${t('addButton')}`;
    addPrompt.addEventListener('click', () => openButtonForm(app, null));
    grid.appendChild(addPrompt);
  }

  btnSec.appendChild(grid);
  card.appendChild(btnSec);

  // 3. Activity Strip (Bottom)
  const strip = createCardActivityStrip(app);
  card.appendChild(strip);

  return card;
}

/* ==========================================================================
   Action Tile Builder
   ========================================================================== */

function createActionTile(app, button) {
  const tile = document.createElement('div');
  const isRunning = button.state === 'running';
  tile.className = `action-tile ${isRunning ? 'is-running' : ''}`;
  tile.dataset.buttonId = button.id;

  const left = document.createElement('div');
  left.className = 'tile-left';

  const dot = document.createElement('span');
  dot.className = `tile-status-dot ${isRunning ? 'running' : 'idle'}`;
  left.appendChild(dot);

  const info = document.createElement('div');
  info.className = 'tile-info';

  const head = document.createElement('div');
  head.className = 'tile-head';

  const label = document.createElement('span');
  label.className = 'tile-label';
  label.textContent = button.label;
  label.title = button.label;

  const tag = document.createElement('span');
  tag.className = `type-tag ${button.type === 'managed' ? 'managed' : 'exec'}`;
  tag.textContent = button.type === 'managed' ? 'pm2' : 'exec';

  const format = button.outputFormat || 'text';
  const fmtTag = document.createElement('span');
  fmtTag.className = `format-badge format-${format}`;
  fmtTag.textContent = format === 'json' ? '{} JSON' : (format === 'markdown' ? '📋 MD' : '📄 LOG');

  head.append(label, tag, fmtTag);
  info.appendChild(head);

  if (button.command) {
    const cmd = document.createElement('div');
    cmd.className = 'tile-command';
    cmd.textContent = button.command;
    cmd.title = `${t('copyCommand')}: ${button.command}`;
    cmd.addEventListener('click', (e) => {
      e.stopPropagation();
      copyText(button.command, `${t('copied')}: ${button.command}`);
    });
    info.appendChild(cmd);
  }

  left.appendChild(info);
  tile.appendChild(left);

  // Controls (Trigger + Edit)
  const controls = document.createElement('div');
  controls.className = 'tile-controls';

  const trigger = document.createElement('button');
  trigger.className = `btn-trigger ${isRunning ? 'is-running' : ''}`;
  if (isRunning) {
    const startTs = button.startedAt || Date.now();
    trigger.title = t('cancelRun');
    trigger.innerHTML = `
      <span class="live-progress-fill"></span>
      <span class="btn-label-wrap default-label"><span>⏳</span> <span class="elapsed-timer">0.0s</span></span>
      <span class="btn-label-wrap hover-stop"><span>⏹</span> <span>${t('stop')}</span></span>
    `;
    trigger.addEventListener('click', (e) => {
      e.stopPropagation();
      cancelRun(app, button);
    });

    const timerEl = trigger.querySelector('.elapsed-timer');
    if (timerEl) {
      const updateTimer = () => {
        if (!trigger.classList.contains('is-running')) return;
        const elapsed = ((Date.now() - startTs) / 1000).toFixed(1);
        timerEl.textContent = `${elapsed}s`;
      };
      updateTimer();
      const intervalId = setInterval(() => {
        if (!document.body.contains(trigger) || !trigger.classList.contains('is-running')) {
          clearInterval(intervalId);
          return;
        }
        updateTimer();
      }, 100);
    }
  } else {
    trigger.innerHTML = `<span>▶</span> <span>${t('run')}</span>`;
    trigger.addEventListener('click', (e) => {
      e.stopPropagation();
      runButton(app, button);
    });
  }

  const edit = document.createElement('button');
  edit.className = 'btn-tile-edit';
  edit.title = t('editButton');
  edit.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>`;
  edit.addEventListener('click', (e) => {
    e.stopPropagation();
    openButtonForm(app, button);
  });

  controls.append(trigger, edit);
  tile.appendChild(controls);

  return tile;
}

/* ==========================================================================
   Activity Strip & Tray Builders
   ========================================================================== */

function createCardActivityStrip(app) {
  const strip = document.createElement('div');
  strip.className = 'card-activity-strip';

  const summary = document.createElement('div');
  summary.className = 'activity-summary';
  summary.style.cursor = 'pointer';

  const tag = document.createElement('span');
  tag.className = 'activity-tag hidden';

  const time = document.createElement('span');
  time.className = 'activity-time';

  const text = document.createElement('span');
  text.className = 'activity-text';
  text.textContent = t('noHistory');

  summary.append(tag, time, text);
  strip.appendChild(summary);

  let latestEntry = null;
  summary.addEventListener('click', () => {
    showDockForApp(app.id, latestEntry?.id);
  });

  const actions = document.createElement('div');
  actions.style.display = 'flex';
  actions.style.alignItems = 'center';
  actions.style.gap = '6px';

  const viewOutBtn = document.createElement('button');
  viewOutBtn.className = 'activity-btn';
  viewOutBtn.innerHTML = `<span>${t('viewOutput')} ↗</span>`;
  viewOutBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    showDockForApp(app.id, latestEntry?.id);
  });

  actions.append(viewOutBtn);
  strip.appendChild(actions);

  // Initial fetch for strip text
  api(`/api/apps/${encodeURIComponent(app.id)}/logs`).then((res) => {
    const latest = res.entries?.[0];
    if (!latest) return;
    latestEntry = latest;
    tag.classList.remove('hidden');
    if (latest.killed) {
      tag.className = 'activity-tag fail';
      tag.textContent = t('killed');
    } else if (latest.success) {
      tag.className = 'activity-tag ok';
      tag.textContent = `✓ 0`;
    } else {
      tag.className = 'activity-tag fail';
      tag.textContent = `✗ ${latest.exitCode ?? 1}`;
    }
    time.textContent = formatDateTime(latest.startedAt);
    text.textContent = `${latest.label || ''}: ${latest.summary || 'done'}`;
  }).catch(() => {});

  return strip;
}

function toggleLogsTray(appId) {
  if (state.expandedLogs.has(appId)) {
    state.expandedLogs.delete(appId);
  } else {
    state.expandedLogs.add(appId);
  }
  render();
}

/* ==========================================================================
   Output Formatter & Ansi Parser
   ========================================================================== */

function escapeHtml(str) {
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function parseAnsi(text) {
  if (!text) return '';
  const colors = {
    30: 'ansi-black', 31: 'ansi-red', 32: 'ansi-green', 33: 'ansi-yellow',
    34: 'ansi-blue', 35: 'ansi-magenta', 36: 'ansi-cyan', 37: 'ansi-white',
    90: 'ansi-bright-black', 91: 'ansi-bright-red', 92: 'ansi-bright-green',
    93: 'ansi-bright-yellow', 94: 'ansi-bright-blue', 95: 'ansi-bright-magenta',
    96: 'ansi-bright-cyan', 97: 'ansi-bright-white',
  };
  
  const parts = text.split(/\x1b\[([0-9;]+)m/);
  let html = '';
  let currentClass = '';
  let isBold = false;

  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 1) {
      const codes = parts[i].split(';');
      for (const code of codes) {
        const c = parseInt(code, 10);
        if (c === 0) {
          currentClass = '';
          isBold = false;
        } else if (c === 1) {
          isBold = true;
        } else if (colors[c]) {
          currentClass = colors[c];
        }
      }
    } else {
      const escaped = escapeHtml(parts[i]);
      if (currentClass || isBold) {
        const classes = [currentClass, isBold ? 'ansi-bold' : ''].filter(Boolean).join(' ');
        html += `<span class="${classes}">${escaped}</span>`;
      } else {
        html += escaped;
      }
    }
  }
  return html;
}

function highlightLog(text) {
  if (!text) return '';
  const lines = text.split('\n');
  return lines.map((line) => {
    let lineHtml = parseAnsi(line);
    if (/\b(ERROR|SEVERE|FATAL|Exception|Error:)\b/i.test(line)) {
      return `<div class="log-line log-error">${lineHtml || '&nbsp;'}</div>`;
    }
    if (/\b(WARN|WARNING)\b/i.test(line)) {
      return `<div class="log-line log-warn">${lineHtml || '&nbsp;'}</div>`;
    }
    if (/\b(INFO)\b/.test(line)) {
      return `<div class="log-line log-info">${lineHtml || '&nbsp;'}</div>`;
    }
    if (/\b(DEBUG|TRACE)\b/.test(line)) {
      return `<div class="log-line log-debug">${lineHtml || '&nbsp;'}</div>`;
    }
    return `<div class="log-line">${lineHtml || '&nbsp;'}</div>`;
  }).join('');
}

function formatJsonTree(text) {
  if (!text) return null;
  try {
    let clean = typeof text === 'object' ? text : text;
    if (typeof clean === 'string') {
      // Strip ANSI codes
      clean = clean.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').trim();
      // If wrapped in markdown ```json ... ```, unwrap
      const matchFence = clean.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
      if (matchFence) clean = matchFence[1].trim();
      // If there is JSON embedded in text, try extracting substring
      if (!clean.startsWith('{') && !clean.startsWith('[')) {
        const firstBrace = clean.search(/[\{\[]/);
        const lastBrace = Math.max(clean.lastIndexOf('}'), clean.lastIndexOf(']'));
        if (firstBrace !== -1 && lastBrace > firstBrace) {
          clean = clean.substring(firstBrace, lastBrace + 1);
        }
      }
    }
    const obj = typeof clean === 'object' ? clean : JSON.parse(clean);
    const jsonStr = JSON.stringify(obj, null, 2);
    const formatted = escapeHtml(jsonStr).replace(
      /("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?)/g,
      (match) => {
        let cls = 'json-number';
        if (/^"/.test(match)) {
          if (/:$/.test(match)) {
            cls = 'json-key';
          } else {
            cls = 'json-string';
          }
        } else if (/true|false/.test(match)) {
          cls = 'json-boolean';
        } else if (/null/.test(match)) {
          cls = 'json-null';
        }
        return `<span class="${cls}">${match}</span>`;
      }
    );
    return `<pre class="json-tree-pre">${formatted}</pre>`;
  } catch (e) {
    return null;
  }
}

let mermaidInstance = null;
async function ensureMermaid() {
  if (mermaidInstance) return mermaidInstance;
  try {
    const mod = await import('https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.esm.min.mjs');
    mermaidInstance = mod.default || mod;
    mermaidInstance.initialize({ startOnLoad: false, theme: 'dark' });
    return mermaidInstance;
  } catch (e) {
    console.warn('Failed to load mermaid via ESM:', e);
    return null;
  }
}

async function renderMarkdown(text, container) {
  const mermaidBlocks = [];
  let processed = text.replace(/```mermaid([\s\S]*?)```/g, (match, code) => {
    const id = `mermaid-${Math.random().toString(36).slice(2, 9)}`;
    mermaidBlocks.push({ id, code: code.trim() });
    return `<div class="mermaid-svg-container" id="${id}"><div class="hint">Rendering diagram...</div></div>`;
  });

  // Table markdown parser
  processed = processed.replace(/\|(.+)\|\n\|[-:| ]+\|\n((?:\|.*\|\n?)*)/g, (match, header, rows) => {
    const headers = header.split('|').map(h => h.trim()).filter(Boolean);
    const ths = headers.map(h => `<th>${escapeHtml(h)}</th>`).join('');
    const trs = rows.trim().split('\n').map(row => {
      const cols = row.split('|').map(c => c.trim()).filter(Boolean);
      return `<tr>${cols.map(c => `<td>${escapeHtml(c)}</td>`).join('')}</tr>`;
    }).join('');
    return `<table><thead><tr>${ths}</tr></thead><tbody>${trs}</tbody></table>`;
  });

  processed = processed
    .replace(/^### (.*$)/gim, '<h3>$1</h3>')
    .replace(/^## (.*$)/gim, '<h2>$1</h2>')
    .replace(/^# (.*$)/gim, '<h1>$1</h1>')
    .replace(/\*\*(.*?)\*\*/gim, '<strong>$1</strong>')
    .replace(/```([a-z]*)([\s\S]*?)```/gim, '<pre><code>$2</code></pre>')
    .replace(/`([^`]+)`/gim, '<code>$1</code>')
    .replace(/\n\n/gim, '<br/><br/>');

  container.innerHTML = processed;

  if (mermaidBlocks.length > 0) {
    const mm = await ensureMermaid();
    if (mm) {
      for (const b of mermaidBlocks) {
        const el = container.querySelector(`#${b.id}`);
        if (el) {
          try {
            const cleanId = 'mm_' + Math.random().toString(36).slice(2, 9);
            const { svg } = await mm.render(cleanId, b.code);
            el.innerHTML = svg;
          } catch (err) {
            el.innerHTML = `<pre class="log-error" style="padding: 10px; margin: 0;">Mermaid render error: ${escapeHtml(err.message)}</pre>`;
          }
        }
      }
    }
  }
}

/* ==========================================================================
   Master-Detail Workspace Dock Module (Bottom Split Panel)
   ========================================================================== */

const dockState = {
  appId: null,
  history: [],
  selectedId: null,
  autoScroll: true,
  eventSource: null,
  filterQuery: ''
};

function initDockResize() {
  const handle = $('#dockResizeHandle');
  const dock = $('#dockPanel');
  if (!handle || !dock) return;

  const savedHeight = localStorage.getItem('appdeck-dock-height');
  if (savedHeight && Number(savedHeight) >= 180) {
    document.documentElement.style.setProperty('--dock-height', `${savedHeight}px`);
  }

  let isDragging = false;
  let startY = 0;
  let startHeight = 0;

  handle.addEventListener('mousedown', (e) => {
    if (dock.classList.contains('expanded')) return;
    isDragging = true;
    startY = e.clientY;
    startHeight = dock.offsetHeight;
    handle.classList.add('is-resizing');
    dock.classList.add('no-transition');
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'ns-resize';
  });

  window.addEventListener('mousemove', (e) => {
    if (!isDragging) return;
    const deltaY = startY - e.clientY;
    const minHeight = 180;
    const maxHeight = window.innerHeight - 52;
    const newHeight = Math.max(minHeight, Math.min(maxHeight, startHeight + deltaY));
    document.documentElement.style.setProperty('--dock-height', `${newHeight}px`);
    localStorage.setItem('appdeck-dock-height', String(newHeight));
  });

  window.addEventListener('mouseup', () => {
    if (!isDragging) return;
    isDragging = false;
    handle.classList.remove('is-resizing');
    dock.classList.remove('no-transition');
    document.body.style.userSelect = '';
    document.body.style.cursor = '';
  });
}

function initDock() {
  // Resize Handle
  initDockResize();

  // Copy
  $('#dockCopyBtn')?.addEventListener('click', () => {
    const entry = dockState.history.find(h => h.id === dockState.selectedId);
    copyText(entry?.output || $('#dockBody')?.innerText || '', t('outputCopied'));
  });

  // Fullscreen toggle button
  $('#btnFullscreen')?.addEventListener('click', toggleDockExpand);

  // Close dock button
  $('#btnCloseDock')?.addEventListener('click', () => toggleDock(false));

  // Clear all history for current project
  $('#dockClearHistoryBtn')?.addEventListener('click', clearCurrentAppHistory);

  // Filter / grep
  $('#dockSearchInput')?.addEventListener('input', (e) => {
    dockState.filterQuery = e.target.value.trim().toLowerCase();
    applyDockFilter();
  });

  // Keyboard shortcuts for F and Esc
  window.addEventListener('keydown', (e) => {
    if (['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName)) return;

    const dock = $('#dockPanel');
    const isOpen = dock && !dock.classList.contains('collapsed');

    if (e.key === 'f' || e.key === 'F') {
      e.preventDefault();
      if (!isOpen) {
        const targetAppId = dockState.appId || state.apps[0]?.id;
        if (targetAppId) showDockForApp(targetAppId);
      } else {
        toggleDockExpand();
      }
    } else if (e.key === 'Escape') {
      if (dock && dock.classList.contains('expanded')) {
        toggleDockExpand();
      } else if (isOpen) {
        toggleDock(false);
      }
    }
  });
}

function toggleDock(show) {
  const dock = $('#dockPanel');
  if (!dock) return;
  if (show === undefined) {
    dock.classList.toggle('collapsed');
  } else if (show) {
    dock.classList.remove('collapsed');
    dock.setAttribute('aria-hidden', 'false');
  } else {
    dock.classList.add('collapsed');
    dock.classList.remove('expanded');
    dock.setAttribute('aria-hidden', 'true');
    const btn = $('#btnFullscreen');
    if (btn) btn.classList.remove('active');
    const text = $('#fsText');
    if (text) text.textContent = t('fullscreen');
    const hint = $('#fsKbdHint');
    if (hint) hint.textContent = 'F';
    if (dockState.eventSource) {
      dockState.eventSource.close();
      dockState.eventSource = null;
    }
  }
}

function toggleDockExpand() {
  const dock = $('#dockPanel');
  if (!dock) return;
  dock.classList.toggle('expanded');
  const isExp = dock.classList.contains('expanded');
  const btn = $('#btnFullscreen');
  if (btn) btn.classList.toggle('active', isExp);
  const text = $('#fsText');
  if (text) text.textContent = isExp ? t('restore') : t('fullscreen');
  const hint = $('#fsKbdHint');
  if (hint) hint.textContent = 'F';
}

async function showDockForApp(appId, selectId = null) {
  dockState.appId = appId;
  const app = state.apps.find(a => a.id === appId) || { id: appId, name: appId };
  
  const leftTitle = $('#dockLeftTitle');
  if (leftTitle) {
    leftTitle.textContent = `${app.name || app.id}`;
  }

  toggleDock(true);

  try {
    const res = await api(`/api/apps/${encodeURIComponent(appId)}/logs`);
    dockState.history = res.entries || [];
    if (selectId && dockState.history.some(h => h.id === selectId)) {
      dockState.selectedId = selectId;
    } else if (dockState.history.length > 0) {
      dockState.selectedId = dockState.history[0].id;
    } else {
      dockState.selectedId = null;
    }
    renderDockHistoryList();
    renderDockOutput();
  } catch (err) {
    dockState.history = [];
    dockState.selectedId = null;
    renderDockHistoryList();
    renderDockOutput();
  }
}

function renderDockHistoryList() {
  const container = $('#dockHistoryList');
  if (!container) return;
  container.innerHTML = '';

  const count = dockState.history.length;
  const app = state.apps.find(a => a.id === dockState.appId) || { id: dockState.appId, name: dockState.appId };
  const leftTitle = $('#dockLeftTitle');
  if (leftTitle) {
    leftTitle.textContent = `${app.name || app.id} (${count})`;
  }

  if (count === 0) {
    const empty = document.createElement('div');
    empty.style.color = 'var(--text-muted)';
    empty.style.padding = '16px';
    empty.style.fontSize = '11px';
    empty.style.textAlign = 'center';
    empty.textContent = t('noHistory');
    container.appendChild(empty);
    return;
  }

  dockState.history.forEach((item) => {
    const row = document.createElement('div');
    row.className = `history-item-row ${item.id === dockState.selectedId ? 'active' : ''}`;
    row.addEventListener('click', () => {
      dockState.selectedId = item.id;
      renderDockHistoryList();
      renderDockOutput();
    });

    const left = document.createElement('div');
    left.className = 'history-item-left';

    const badge = document.createElement('span');
    if (item.running) {
      badge.className = 'activity-tag running';
      badge.textContent = '⏳';
    } else if (item.killed) {
      badge.className = 'activity-tag fail';
      badge.textContent = t('killed');
    } else if (item.success || item.exitCode === 0) {
      badge.className = 'activity-tag ok';
      badge.textContent = `✓ 0`;
    } else {
      badge.className = 'activity-tag fail';
      badge.textContent = `✗ ${item.exitCode ?? 1}`;
    }

    const info = document.createElement('div');
    info.className = 'history-item-info';

    const title = document.createElement('span');
    title.className = 'history-item-title';
    title.textContent = item.label || item.buttonId || t('viewOutput');

    const time = document.createElement('span');
    time.className = 'history-item-time';
    time.textContent = item.startedAt ? formatDateTime(item.startedAt) : (item.time || '');

    const format = item.outputFormat || 'text';
    const fmtBadge = document.createElement('span');
    fmtBadge.className = `format-badge format-${format}`;
    fmtBadge.textContent = format === 'json' ? '{} JSON' : (format === 'markdown' ? '📋 MD' : '📄 LOG');

    info.append(title, time);
    left.append(badge, info, fmtBadge);

    const delBtn = document.createElement('button');
    delBtn.className = 'icon-btn';
    delBtn.style.padding = '2px';
    delBtn.style.width = '18px';
    delBtn.style.height = '18px';
    delBtn.title = t('delete');
    delBtn.innerHTML = `✕`;
    delBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!confirm(t('confirmDeleteLog'))) return;
      try {
        await api(`/api/apps/${encodeURIComponent(dockState.appId)}/logs/${encodeURIComponent(item.id)}`, { method: 'DELETE' });
        toast(t('logDeleted'));
        dockState.history = dockState.history.filter(h => h.id !== item.id);
        if (dockState.selectedId === item.id) {
          dockState.selectedId = dockState.history[0]?.id || null;
        }
        renderDockHistoryList();
        renderDockOutput();
        render();
      } catch (err) {
        toast(t('requestFailed') + err.message, { error: true });
      }
    });

    row.append(left, delBtn);
    container.appendChild(row);
  });
}

async function renderDockOutput() {
  const item = dockState.history.find(h => h.id === dockState.selectedId);
  const titleEl = $('#dockSessionTitle');
  const badgeEl = $('#dockFormatBadge');
  const bodyEl = $('#dockBody');
  const footLeft = $('#dockFooterLeft');
  const footRight = $('#dockFooterRight');

  if (!item) {
    if (titleEl) titleEl.textContent = `[${dockState.appId || ''} :: ${t('noHistory')}]`;
    if (badgeEl) badgeEl.innerHTML = '';
    if (bodyEl) bodyEl.innerHTML = `<span style="color:var(--text-muted); padding: 16px; display: block;">${t('noHistory')}</span>`;
    if (footLeft) footLeft.innerHTML = '';
    if (footRight) footRight.innerHTML = '';
    return;
  }

  const format = item.outputFormat || 'text';

  if (titleEl) {
    titleEl.textContent = `[${dockState.appId} :: ${item.label || item.buttonId || ''}]`;
  }

  if (badgeEl) {
    badgeEl.className = `format-badge format-${format}`;
    badgeEl.textContent = format === 'json' ? '{} JSON' : (format === 'markdown' ? '📋 MD' : '📄 LOG');
  }

  const text = item.output || '';
  if (format === 'json') {
    bodyEl.className = 'dock-body';
    const tree = formatJsonTree(text);
    if (tree) {
      bodyEl.innerHTML = tree;
    } else {
      bodyEl.innerHTML = `<div class="hint" style="padding: 16px;">(Invalid JSON)</div>${highlightLog(text)}`;
    }
  } else if (format === 'markdown') {
    bodyEl.className = 'dock-body markdown-view-container';
    await renderMarkdown(text, bodyEl);
  } else {
    bodyEl.className = 'dock-body';
    bodyEl.innerHTML = highlightLog(text) || `<div style="color: var(--text-muted); padding: 16px;">(No output)</div>`;
    applyDockFilter();
  }

  if (dockState.autoScroll) {
    bodyEl.scrollTop = bodyEl.scrollHeight;
  }

  // Footer controls
  if (footLeft) {
    footLeft.innerHTML = '';
    const scrollToggle = document.createElement('button');
    scrollToggle.className = 'dock-footer-btn';
    scrollToggle.textContent = dockState.autoScroll ? t('pauseAutoScroll') : t('resumeAutoScroll');
    scrollToggle.addEventListener('click', () => {
      dockState.autoScroll = !dockState.autoScroll;
      scrollToggle.textContent = dockState.autoScroll ? t('pauseAutoScroll') : t('resumeAutoScroll');
      if (dockState.autoScroll) bodyEl.scrollTop = bodyEl.scrollHeight;
    });
    footLeft.appendChild(scrollToggle);

    if (item.startedAt) {
      const timeTag = document.createElement('span');
      timeTag.className = 'dock-time-pill';
      timeTag.innerHTML = `<span>🕒</span> <span>${formatDateTime(item.startedAt)}</span>`;
      footLeft.appendChild(timeTag);
    }
  }

  if (footRight) {
    footRight.innerHTML = '';
    if (item.running) {
      const killBtn = document.createElement('button');
      killBtn.className = 'dock-footer-btn danger';
      killBtn.textContent = t('cancelRun');
      killBtn.addEventListener('click', async () => {
        try {
          await api(`/api/apps/${encodeURIComponent(dockState.appId)}/buttons/${encodeURIComponent(item.buttonId)}/cancel`, { method: 'POST' });
          toast(t('runCancelled'));
          item.running = false;
          item.killed = true;
          renderDockHistoryList();
          renderDockOutput();
        } catch (err) {
          toast(t('requestFailed') + err.message, { error: true });
        }
      });
      footRight.appendChild(killBtn);
    }
  }
}

function applyDockFilter() {
  const query = dockState.filterQuery;
  const bodyEl = $('#dockBody');
  if (!bodyEl) return;
  if (!query) {
    bodyEl.querySelectorAll('.log-line').forEach(el => el.classList.remove('highlight-match'));
    return;
  }
  bodyEl.querySelectorAll('.log-line').forEach(el => {
    const match = el.textContent.toLowerCase().includes(query);
    el.classList.toggle('highlight-match', match);
  });
}

async function clearCurrentAppHistory() {
  if (!dockState.appId) return;
  if (!confirm(t('confirmClearLogs'))) return;
  try {
    await api(`/api/apps/${encodeURIComponent(dockState.appId)}/logs`, { method: 'DELETE' });
    toast(t('logsCleared'));
    dockState.history = [];
    dockState.selectedId = null;
    renderDockHistoryList();
    renderDockOutput();
    render();
  } catch (err) {
    toast(t('requestFailed') + err.message, { error: true });
  }
}

/* ==========================================================================
   Drawer Form Management (App & Button Forms)
   ========================================================================== */

let drawerCleanup = null;

function openDrawer({ title, body, foot }) {
  const drawer = $('#drawer');
  const overlay = $('#overlay');
  drawer.innerHTML = '';

  const head = document.createElement('div');
  head.className = 'drawer-head';
  const titleEl = document.createElement('div');
  titleEl.className = 'drawer-title';
  titleEl.textContent = title;

  const closeBtn = document.createElement('button');
  closeBtn.className = 'popover-close-btn';
  closeBtn.textContent = '×';
  closeBtn.addEventListener('click', closeDrawer);

  head.append(titleEl, closeBtn);
  drawer.appendChild(head);

  const bodyEl = document.createElement('div');
  bodyEl.className = 'drawer-body';
  bodyEl.appendChild(body);
  drawer.appendChild(bodyEl);

  if (foot) {
    const footEl = document.createElement('div');
    footEl.className = 'drawer-foot';
    footEl.append(...foot);
    drawer.appendChild(footEl);
  }

  if (drawerCleanup) drawerCleanup();
  drawerCleanup = () => {
    drawer.classList.add('hidden');
    overlay.classList.add('hidden');
    drawer.setAttribute('aria-hidden', 'true');
    drawerCleanup = null;
  };

  drawer.classList.remove('hidden');
  overlay.classList.remove('hidden');
  drawer.setAttribute('aria-hidden', 'false');
}

function closeDrawer() {
  if (drawerCleanup) drawerCleanup();
}

function formField(labelKey, inputEl, hintKey) {
  const wrap = document.createElement('div');
  wrap.className = 'field';
  const label = document.createElement('label');
  label.textContent = t(labelKey);
  wrap.appendChild(label);
  wrap.appendChild(inputEl);
  if (hintKey) {
    const hint = document.createElement('p');
    hint.className = 'hint';
    hint.textContent = t(hintKey);
    wrap.appendChild(hint);
  }
  return wrap;
}

function textInput(value = '', placeholder = '') {
  const input = document.createElement('input');
  input.type = 'text';
  input.value = value ?? '';
  input.placeholder = placeholder;
  return input;
}

function textArea(value = '') {
  const textarea = document.createElement('textarea');
  textarea.value = value ?? '';
  return textarea;
}

/* App Create / Edit Form */
function openAppForm(app = null) {
  const isEdit = !!app;
  const body = document.createElement('div');
  body.style.display = 'flex';
  body.style.flexDirection = 'column';
  body.style.gap = '14px';

  const nameInput = textInput(app?.name, t('appNamePlaceholder'));
  body.appendChild(formField('appName', nameInput));

  const idInput = textInput(app?.id, t('appIdPlaceholder'));
  idInput.disabled = isEdit;
  body.appendChild(formField('appId', idInput, 'appIdHint'));

  const descInput = textArea(app?.description);
  body.appendChild(formField('appDesc', descInput));

  const dirInput = textInput(app?.dir, t('appDirPlaceholder'));
  body.appendChild(formField('appDir', dirInput, 'appDirHint'));

  const urlInput = textInput(app?.url, 'http://localhost:3000');
  body.appendChild(formField('appUrl', urlInput));

  const portInput = textInput(app?.port ?? '', '3000');
  portInput.inputMode = 'numeric';
  body.appendChild(formField('appPort', portInput, 'appPortHint'));

  const saveBtn = document.createElement('button');
  saveBtn.className = 'primary-btn';
  saveBtn.textContent = t('save');
  saveBtn.addEventListener('click', async () => {
    const id = isEdit ? app.id : (idInput.value.trim() || `app-${Math.random().toString(36).slice(2, 8)}`);
    const payload = {
      name: nameInput.value.trim(),
      description: descInput.value.trim(),
      dir: dirInput.value.trim() || null,
      url: urlInput.value.trim() || null,
      port: portInput.value.trim() ? Number(portInput.value.trim()) : null,
    };
    if (!payload.name) return toast(t('nameRequired'), { error: true });

    try {
      if (isEdit) {
        await api(`/api/apps/${encodeURIComponent(id)}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
      } else {
        await api('/api/apps', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
      }
      toast(t('saveOk'));
      closeDrawer();
      loadApps();
    } catch (err) {
      toast(t('requestFailed') + err.message, { error: true });
    }
  });

  openDrawer({ title: t(isEdit ? 'editApp' : 'addApp'), body, foot: [saveBtn] });
}

/* Button Create / Edit Form */
function openButtonForm(app, button = null) {
  const isEdit = !!button;
  const body = document.createElement('div');
  body.style.display = 'flex';
  body.style.flexDirection = 'column';
  body.style.gap = '14px';

  const labelInput = textInput(button?.label, t('btnLabelPlaceholder'));
  body.appendChild(formField('buttonLabel', labelInput));

  const idInput = textInput(button?.id, t('btnIdPlaceholder'));
  idInput.disabled = isEdit;
  body.appendChild(formField('buttonId', idInput, 'appIdHint'));

  // Type selector (managed / exec)
  const typeSelect = document.createElement('select');
  typeSelect.innerHTML = `
    <option value="exec" ${button?.type !== 'managed' ? 'selected' : ''}>${t('execBadge')} ${t('execBadgeDesc')}</option>
    <option value="managed" ${button?.type === 'managed' ? 'selected' : ''}>${t('managedBadge')} ${t('managedBadgeDesc')}</option>
  `;
  body.appendChild(formField('buttonType', typeSelect));

  // Output Format selector (text / json / markdown)
  const formatSelect = document.createElement('select');
  formatSelect.innerHTML = `
    <option value="text" ${(!button?.outputFormat || button?.outputFormat === 'text') ? 'selected' : ''}>${t('formatText')}</option>
    <option value="json" ${button?.outputFormat === 'json' ? 'selected' : ''}>${t('formatJson')}</option>
    <option value="markdown" ${button?.outputFormat === 'markdown' ? 'selected' : ''}>${t('formatMarkdown')}</option>
  `;
  body.appendChild(formField('outputFormat', formatSelect, 'outputFormatHint'));

  // Command input + Copy button + 4 Script Modes Presets
  const commandInput = textArea(button?.command);
  commandInput.rows = 3;
  commandInput.style.fontFamily = 'var(--font-mono, "SF Mono", Menlo, Consolas, monospace)';
  commandInput.style.fontSize = '12px';
  commandInput.style.lineHeight = '1.45';
  commandInput.style.resize = 'vertical';
  commandInput.style.minHeight = '72px';
  commandInput.placeholder = t('commandPlaceholder');

  const cmdField = document.createElement('div');
  cmdField.className = 'field';

  const cmdHeader = document.createElement('div');
  cmdHeader.style.display = 'flex';
  cmdHeader.style.justifyContent = 'space-between';
  cmdHeader.style.alignItems = 'center';
  cmdHeader.style.marginBottom = '6px';

  const cmdLabel = document.createElement('label');
  cmdLabel.textContent = t('buttonCommand');
  cmdLabel.style.margin = '0';

  const copyCmdBtn = document.createElement('button');
  copyCmdBtn.type = 'button';
  copyCmdBtn.className = 'ghost-btn';
  copyCmdBtn.style.padding = '2px 8px';
  copyCmdBtn.style.fontSize = '11px';
  copyCmdBtn.style.display = 'inline-flex';
  copyCmdBtn.style.alignItems = 'center';
  copyCmdBtn.style.gap = '4px';
  copyCmdBtn.title = t('copyCommand');
  copyCmdBtn.innerHTML = `
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
    </svg>
    <span>${t('copyCommand')}</span>
  `;
  copyCmdBtn.addEventListener('click', () => {
    const cmdVal = commandInput.value.trim();
    if (!cmdVal) return toast(t('noCommandToCopy'), { error: true });
    copyText(cmdVal, t('commandCopied'));
  });

  cmdHeader.append(cmdLabel, copyCmdBtn);
  cmdField.append(cmdHeader, commandInput);

  // 4 Script Modes Templates
  const tplSection = document.createElement('div');
  tplSection.className = 'script-modes-wrapper';

  const tplTitle = document.createElement('div');
  tplTitle.style.fontSize = '12px';
  tplTitle.style.fontWeight = '600';
  tplTitle.style.color = 'var(--text-secondary)';
  tplTitle.style.display = 'flex';
  tplTitle.style.alignItems = 'center';
  tplTitle.style.gap = '5px';
  tplTitle.innerHTML = `
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
      <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon>
    </svg>
    <span>${t('scriptModesHint')}</span>
  `;
  tplSection.appendChild(tplTitle);

  const scriptModes = [
    {
      group: t('modeSingle'),
      items: [
        { label: 'npm run dev', cmd: 'npm run dev' },
        { label: 'python3 server.py', cmd: 'python3 server.py' },
        { label: 'tail -n 20 logs', cmd: 'tail -n 20 logs/catalina.log' }
      ]
    },
    {
      group: t('modeChained'),
      items: [
        { label: 'git pull && build', cmd: 'git pull && npm run build' },
        { label: t('tplPsGrep'), cmd: 'ps aux | grep node' }
      ]
    },
    {
      group: t('modeInlinePy'),
      items: [
        { label: t('tplPyCountdown'), cmd: 'python3 -c "import time; print(\'准备备份...\'); time.sleep(1); print(\'完成\')"' },
        { label: t('tplPyHealth'), cmd: 'python3 -c "import urllib.request; print(urllib.request.urlopen(\'http://localhost:6969/api/health\').read().decode())"' }
      ]
    },
    {
      group: t('modeInlineBash'),
      items: [
        { label: t('tplBashLoop'), cmd: "bash -c 'for i in 1 2 3 4 5; do echo \"进度: $i\"; sleep 1; done'" },
        { label: t('tplBashSnapshot'), cmd: "bash -c 'echo \"== 负载 ==\"; uptime; echo \"\\n== 磁盘 ==\"; df -h'" }
      ]
    }
  ];

  for (const mode of scriptModes) {
    const row = document.createElement('div');
    row.className = 'tpl-group-row';

    const tag = document.createElement('span');
    tag.className = 'tpl-group-tag';
    tag.textContent = mode.group + ':';
    row.appendChild(tag);

    for (const item of mode.items) {
      const chip = document.createElement('span');
      chip.className = 'tpl-chip';
      chip.textContent = item.label;
      chip.title = item.cmd;
      chip.addEventListener('click', () => {
        commandInput.value = item.cmd;
        commandInput.focus();
      });
      row.appendChild(chip);
    }
    tplSection.appendChild(row);
  }

  cmdField.appendChild(tplSection);
  body.appendChild(cmdField);

  const cwdInput = textInput(button?.cwd ?? '', app.dir ?? '');
  body.appendChild(formField('buttonCwd', cwdInput, 'buttonCwdHint'));

  const saveBtn = document.createElement('button');
  saveBtn.className = 'primary-btn';
  saveBtn.textContent = t('save');
  saveBtn.addEventListener('click', async () => {
    const id = isEdit ? button.id : (idInput.value.trim() || `btn-${Math.random().toString(36).slice(2, 8)}`);
    const payload = {
      label: labelInput.value.trim(),
      type: typeSelect.value,
      outputFormat: formatSelect.value,
      command: commandInput.value.trim() || null,
      cwd: cwdInput.value.trim() || null,
    };
    if (!payload.label) return toast(t('fieldsRequired'), { error: true });

    const method = isEdit ? 'PATCH' : 'PUT';
    try {
      await api(`/api/apps/${encodeURIComponent(app.id)}/buttons/${encodeURIComponent(id)}`, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      toast(t('saveOk'));
      closeDrawer();
      loadApps();
    } catch (err) {
      toast(t('requestFailed') + err.message, { error: true });
    }
  });

  let foot = [saveBtn];
  if (isEdit) {
    const delBtn = document.createElement('button');
    delBtn.className = 'ghost-btn danger';
    delBtn.textContent = t('delete');
    delBtn.addEventListener('click', async () => {
      if (!confirm(t('confirmDeleteButton').replace('{label}', button.label))) return;
      try {
        await api(`/api/apps/${encodeURIComponent(app.id)}/buttons/${encodeURIComponent(button.id)}`, { method: 'DELETE' });
        toast(t('deleteOk'));
        closeDrawer();
        loadApps();
      } catch (err) {
        toast(t('requestFailed') + err.message, { error: true });
      }
    });
    foot = [delBtn, saveBtn];
  }

  openDrawer({ title: t(isEdit ? 'editButton' : 'addButton'), body, foot });
}

/* Open Native Terminal Handler */
async function openAppTerminal(app) {
  if (!app.dir) {
    toast(t('noDirConfigured'), { error: true });
    return;
  }
  try {
    await api(`/api/apps/${encodeURIComponent(app.id)}/open-terminal`, { method: 'POST' });
    toast(t('terminalOpened'));
  } catch (err) {
    toast(t('requestFailed') + err.message, { error: true });
  }
}

/* Pin / Unpin App Handler */
async function togglePinApp(app) {
  const nextPinned = !app.pinned;
  try {
    await api(`/api/apps/${encodeURIComponent(app.id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pinned: nextPinned }),
    });
    toast(nextPinned ? t('pinSuccess') : t('unpinSuccess'));
    loadApps();
  } catch (err) {
    toast(t('requestFailed') + err.message, { error: true });
  }
}

/* Delete App Handler */
async function deleteApp(app) {
  if (!confirm(t('confirmDeleteApp').replace('{name}', app.name))) return;
  try {
    await api(`/api/apps/${encodeURIComponent(app.id)}`, { method: 'DELETE' });
    toast(t('deleteOk'));
    loadApps();
  } catch (err) {
    toast(t('requestFailed') + err.message, { error: true });
  }
}

/* Run / Cancel Handlers */
async function runButton(app, button) {
  try {
    await api(`/api/apps/${encodeURIComponent(app.id)}/buttons/${encodeURIComponent(button.id)}/run`, { method: 'POST' });
    toast(button.type === 'managed' ? t('started') : t('executed'));
    button.state = 'running';
    button.startedAt = Date.now();
    updateCardsTelemetry();
    updateGlobalStats();
    render();

    if (button.type === 'exec') {
      dockState.appId = app.id;
      toggleDock(true);

      const liveId = 'live-' + Date.now();
      const liveItem = {
        id: liveId,
        buttonId: button.id,
        label: button.label,
        running: true,
        output: '',
        startedAt: Date.now()
      };
      dockState.history.unshift(liveItem);
      dockState.selectedId = liveId;
      renderDockHistoryList();
      renderDockOutput();

      if (dockState.eventSource) {
        dockState.eventSource.close();
        dockState.eventSource = null;
      }

      const streamUrl = `/api/apps/${encodeURIComponent(app.id)}/buttons/${encodeURIComponent(button.id)}/stream`;
      const es = new EventSource(streamUrl);
      dockState.eventSource = es;

      es.addEventListener('init', (e) => {
        try {
          const data = JSON.parse(e.data);
          if (data.output) {
            liveItem.output = data.output;
            if (dockState.selectedId === liveId) renderDockOutput();
          }
        } catch {}
      });

      es.addEventListener('data', (e) => {
        try {
          const data = JSON.parse(e.data);
          if (data.chunk) {
            liveItem.output += data.chunk;
            if (dockState.selectedId === liveId) renderDockOutput();
          }
        } catch {}
      });

      es.addEventListener('end', (e) => {
        try {
          const data = JSON.parse(e.data);
          liveItem.running = false;
          liveItem.exitCode = data.exitCode ?? 0;
          liveItem.success = data.success ?? (data.exitCode === 0);
          liveItem.killed = data.killed ?? false;
          renderDockHistoryList();
          if (dockState.selectedId === liveId) renderDockOutput();
        } catch {}
        es.close();
        if (dockState.eventSource === es) dockState.eventSource = null;
        button.startedAt = null;
        button.state = 'idle';
        loadApps();
      });

      es.onerror = () => {
        es.close();
        if (dockState.eventSource === es) dockState.eventSource = null;
        button.startedAt = null;
        button.state = 'idle';
        loadApps();
      };
    }
  } catch (err) {
    button.startedAt = null;
    button.state = 'idle';
    if (err.status === 409) toast(t('busy'), { error: true });
    else toast(t('requestFailed') + err.message, { error: true });
    loadApps();
  }
}

async function cancelRun(app, button) {
  if (!confirm(t('confirmCancelRun'))) return;
  try {
    await api(`/api/apps/${encodeURIComponent(app.id)}/buttons/${encodeURIComponent(button.id)}/cancel`, { method: 'POST' });
    toast(t('cancelOk'));
    refreshRunsIncremental();
  } catch (err) {
    toast(t('requestFailed') + err.message, { error: true });
  }
}

/* ==========================================================================
   Engine Hub Popover & System Toggles
   ========================================================================== */

function toggleEnginePopover() {
  const pop = $('#enginePopover');
  pop.classList.toggle('hidden');
}

$('#engineBtn').addEventListener('click', toggleEnginePopover);
$('#closeEnginePopoverBtn').addEventListener('click', () => $('#enginePopover').classList.add('hidden'));

async function waitForServer(maxSeconds = 15) {
  for (let i = 0; i < maxSeconds; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    try {
      const response = await fetch('/api/health');
      if (response.ok) return true;
    } catch {}
  }
  return false;
}

$('#daemonSwitch').addEventListener('change', async (e) => {
  const enabled = e.target.checked;
  e.target.disabled = true;
  try {
    await api('/api/system/daemon', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled }),
    });
    toast(t('switching'));
    const recovered = await waitForServer(15);
    if (recovered) {
      toast(enabled ? t('daemonOn') : t('daemonOff'));
      await loadSystem();
      await loadApps();
    } else {
      toast(t('recoverTimeout'), { error: true });
    }
  } catch (err) {
    e.target.checked = !enabled;
    toast(t('requestFailed') + err.message, { error: true });
  } finally {
    e.target.disabled = false;
  }
});

$('#startupSwitch').addEventListener('change', async (e) => {
  const enabled = e.target.checked;
  e.target.disabled = true;
  try {
    toast(t('waitingAuth'));
    const res = await api('/api/system/startup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled }),
    });
    if (res.manual) {
      showManualStartupDialog(res.manual, enabled);
      e.target.checked = false;
    } else {
      toast(enabled ? t('startupOn') : t('startupOff'));
    }
    await loadSystem();
  } catch (err) {
    e.target.checked = !enabled;
    toast(t('requestFailed') + err.message, { error: true });
  } finally {
    e.target.disabled = false;
  }
});

function showManualStartupDialog(command, enabled) {
  const body = document.createElement('div');
  body.style.display = 'flex';
  body.style.flexDirection = 'column';
  body.style.gap = '10px';

  const text = document.createElement('p');
  text.textContent = t(enabled ? 'manualStartup' : 'manualUnstartup');

  const pre = document.createElement('pre');
  pre.className = 'tray-output-block';
  pre.textContent = command;

  const copyBtn = document.createElement('button');
  copyBtn.className = 'ghost-btn';
  copyBtn.textContent = t('copy');
  copyBtn.addEventListener('click', async () => {
    await copyText(command, t('copied'));
    copyBtn.textContent = t('copied');
  });

  body.append(text, pre, copyBtn);
  openDrawer({ title: t('startup'), body });
}

/* ==========================================================================
   Global Search, Shortcuts & Listeners
   ========================================================================== */

const searchInput = $('#searchInput');
const clearSearchBtn = $('#clearSearchBtn');

searchInput.addEventListener('input', (e) => {
  state.searchQuery = e.target.value;
  clearSearchBtn.classList.toggle('hidden', !state.searchQuery);
  render();
});

clearSearchBtn.addEventListener('click', () => {
  searchInput.value = '';
  state.searchQuery = '';
  clearSearchBtn.classList.add('hidden');
  render();
  searchInput.focus();
});

$('#resetSearchBtn').addEventListener('click', () => {
  searchInput.value = '';
  state.searchQuery = '';
  clearSearchBtn.classList.add('hidden');
  render();
});

// Lang switcher
$('#langBtn').addEventListener('click', () => {
  const next = currentLang === 'zh' ? 'en' : 'zh';
  setLang(next);
  $('#langBtn').textContent = t('langName');
  updateEngineHubUI();
  updateGlobalStats();
  render();
});
$('#langBtn').textContent = t('langName');

// Copy AI Agent Guide
$('#copyAiUsageBtn').addEventListener('click', async () => {
  try {
    const res = await api('/api/agent-guide');
    await copyText(res.content, t('aiUsageCopied'));
  } catch (err) {
    toast(t('requestFailed') + err.message, { error: true });
  }
});

// App Add Action
$('#addAppBtn').addEventListener('click', () => openAppForm());
document.querySelector('[data-action="add-app"]').addEventListener('click', () => openAppForm());
$('#overlay').addEventListener('click', closeDrawer);

// Keyboard Shortcuts
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    closeDrawer();
    $('#enginePopover').classList.add('hidden');
    if (document.activeElement === searchInput) {
      searchInput.blur();
    }
  }
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    searchInput.focus();
    searchInput.select();
  }
});

// Close popover when clicked outside
document.addEventListener('click', (e) => {
  const pop = $('#enginePopover');
  const btn = $('#engineBtn');
  if (!pop.classList.contains('hidden') && !pop.contains(e.target) && !btn.contains(e.target)) {
    pop.classList.add('hidden');
  }
});

// Dark / Light Mode Switcher
function setMode(mode) {
  document.documentElement.setAttribute('data-mode', mode);
  localStorage.setItem('appdeck-mode', mode);
  const moon = $('#modeIconMoon');
  const sun = $('#modeIconSun');
  if (moon && sun) {
    moon.classList.toggle('hidden', mode === 'light');
    sun.classList.toggle('hidden', mode === 'dark');
  }
}

function initMode() {
  const saved = localStorage.getItem('appdeck-mode') || 'dark';
  setMode(saved);
  $('#modeToggleBtn')?.addEventListener('click', () => {
    const current = document.documentElement.getAttribute('data-mode') || 'dark';
    const next = current === 'dark' ? 'light' : 'dark';
    setMode(next);
  });
}

// Theme Palette Switcher
function setTheme(theme) {
  if (theme === 'indigo') {
    document.documentElement.removeAttribute('data-theme');
  } else {
    document.documentElement.setAttribute('data-theme', theme);
  }
  localStorage.setItem('appdeck-theme', theme);
  $$('.theme-dot').forEach((dot) => {
    dot.classList.toggle('active', dot.dataset.theme === theme);
  });
}

function initTheme() {
  const saved = localStorage.getItem('appdeck-theme') || 'indigo';
  setTheme(saved);
  $$('.theme-dot').forEach((dot) => {
    dot.addEventListener('click', () => setTheme(dot.dataset.theme));
  });
}

window.addEventListener('click', (e) => {
  if (!e.target.closest('.card-more-wrap')) {
    document.querySelectorAll('.card-dropdown-menu').forEach(m => m.classList.add('hidden'));
  }
});

/* ==========================================================================
   Bootstrap Initialization
   ========================================================================== */

initMode();
initTheme();
initDock();
loadApps();
loadSystem();
clearInterval(state.pollTimer);
state.pollTimer = setInterval(refreshRunsIncremental, 2000);

