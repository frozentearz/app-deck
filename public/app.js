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
    await navigator.clipboard.writeText(text);
    toast(successMsg || t('copied'));
  } catch {
    toast(t('requestFailed') + 'clipboard error', { error: true });
  }
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
    pm2Diag.textContent = pm2Installed ? (daemon ? '在线 (守护托管)' : '已就绪 (独立进程)') : '未安装';
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

    // If inline tray is open, refresh logs tray
    if (state.expandedLogs.has(appId)) {
      const tray = card.querySelector('.card-logs-tray');
      if (tray) renderLogsTrayEntries(tray, appId, entries);
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
  const actions = document.createElement('div');
  actions.className = 'card-actions';

  const addBtn = document.createElement('button');
  addBtn.className = 'ghost-btn';
  addBtn.innerHTML = `<span>+ ${t('addButton')}</span>`;
  addBtn.addEventListener('click', () => openButtonForm(app, null));

  const pinBtn = document.createElement('button');
  pinBtn.className = `icon-btn pin-btn ${app.pinned ? 'active' : ''}`;
  pinBtn.title = app.pinned ? t('unpin') : t('pin');
  pinBtn.innerHTML = `
    <svg width="12" height="12" viewBox="0 0 24 24" fill="${app.pinned ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <line x1="12" y1="17" x2="12" y2="22"></line>
      <path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24Z"></path>
    </svg>
    <span>${app.pinned ? t('unpin') : t('pin')}</span>
  `;
  pinBtn.addEventListener('click', () => togglePinApp(app));

  const editBtn = document.createElement('button');
  editBtn.className = 'icon-btn';
  editBtn.textContent = t('edit');
  editBtn.addEventListener('click', () => openAppForm(app));

  const delBtn = document.createElement('button');
  delBtn.className = 'icon-btn';
  delBtn.textContent = t('delete');
  delBtn.addEventListener('click', () => deleteApp(app));

  actions.append(addBtn, pinBtn, editBtn, delBtn);
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

  // 4. Inline Collapsible Logs Tray (if expanded)
  if (state.expandedLogs.has(app.id)) {
    const tray = createCardLogsTray(app);
    card.appendChild(tray);
  }

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

  head.append(label, tag);
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
  trigger.className = `btn-trigger ${isRunning ? 'stop' : ''}`;
  if (isRunning) {
    trigger.innerHTML = `<span>■</span> <span>${t('stop')}</span>`;
    trigger.addEventListener('click', (e) => {
      e.stopPropagation();
      cancelRun(app, button);
    });
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

  const tag = document.createElement('span');
  tag.className = 'activity-tag hidden';

  const time = document.createElement('span');
  time.className = 'activity-time';

  const text = document.createElement('span');
  text.className = 'activity-text';
  text.textContent = t('noHistory');

  summary.append(tag, time, text);
  strip.appendChild(summary);

  const logsBtn = document.createElement('button');
  const isExpanded = state.expandedLogs.has(app.id);
  logsBtn.className = 'activity-btn';
  logsBtn.innerHTML = `<span>${t('logs')}</span> <span>${isExpanded ? '▾' : '▸'}</span>`;
  logsBtn.addEventListener('click', () => toggleLogsTray(app.id));

  strip.appendChild(logsBtn);

  // Initial fetch for strip text
  api(`/api/apps/${encodeURIComponent(app.id)}/logs`).then((res) => {
    const latest = res.entries?.[0];
    if (!latest) return;
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
    time.textContent = new Date(latest.startedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
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

function createCardLogsTray(app) {
  const tray = document.createElement('div');
  tray.className = 'card-logs-tray';

  api(`/api/apps/${encodeURIComponent(app.id)}/logs`).then((res) => {
    renderLogsTrayEntries(tray, app.id, res.entries || []);
  }).catch(() => {
    tray.textContent = t('noHistory');
  });

  return tray;
}

function renderLogsTrayEntries(tray, appId, entries) {
  tray.innerHTML = '';
  if (!entries || entries.length === 0) {
    tray.innerHTML = `<div style="color: var(--text-muted); padding: 8px;">${t('noHistory')}</div>`;
    return;
  }

  for (const e of entries) {
    const row = document.createElement('div');
    row.className = 'tray-row';

    const time = document.createElement('span');
    time.style.color = 'var(--text-muted)';
    time.style.flexShrink = '0';
    time.textContent = new Date(e.startedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

    const lbl = document.createElement('span');
    lbl.style.fontWeight = '600';
    lbl.style.flexShrink = '0';
    lbl.textContent = e.label || '';

    const status = document.createElement('span');
    status.style.fontWeight = '600';
    status.style.flexShrink = '0';
    status.style.color = e.killed ? 'var(--fail)' : (e.success ? 'var(--ok)' : 'var(--fail)');
    status.textContent = e.killed ? t('killed') : (e.success ? `✓ ${e.exitCode}` : `✗ ${e.exitCode}`);

    const sum = document.createElement('span');
    sum.style.color = 'var(--text-secondary)';
    sum.style.overflow = 'hidden';
    sum.style.textOverflow = 'ellipsis';
    sum.style.whiteSpace = 'nowrap';
    sum.style.flex = '1';
    sum.textContent = e.summary || '';

    const arrow = document.createElement('span');
    arrow.style.color = 'var(--text-muted)';
    arrow.style.flexShrink = '0';
    const isOpen = state.expandedLogRows.has(e.id);
    arrow.textContent = isOpen ? '▾' : '▸';

    row.append(time, lbl, status, sum, arrow);
    tray.appendChild(row);

    if (isOpen && e.output) {
      const out = document.createElement('pre');
      out.className = 'tray-output-block';
      out.textContent = e.output;
      tray.appendChild(out);
    }

    row.addEventListener('click', () => {
      if (state.expandedLogRows.has(e.id)) {
        state.expandedLogRows.delete(e.id);
      } else {
        state.expandedLogRows.add(e.id);
      }
      renderLogsTrayEntries(tray, appId, entries);
    });
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

  const nameInput = textInput(app?.name, '例如: 个人博客或数据中台');
  body.appendChild(formField('appName', nameInput));

  const idInput = textInput(app?.id, '例如: blog');
  idInput.disabled = isEdit;
  body.appendChild(formField('appId', idInput, 'appIdHint'));

  const descInput = textArea(app?.description);
  body.appendChild(formField('appDesc', descInput));

  const dirInput = textInput(app?.dir, '/Users/frazier/Project/blog');
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

  const labelInput = textInput(button?.label, '例如: 启动服务');
  body.appendChild(formField('buttonLabel', labelInput));

  const idInput = textInput(button?.id, '例如: start');
  idInput.disabled = isEdit;
  body.appendChild(formField('buttonId', idInput, 'appIdHint'));

  // Type selector (managed / exec)
  const typeSelect = document.createElement('select');
  typeSelect.innerHTML = `
    <option value="exec" ${button?.type !== 'managed' ? 'selected' : ''}>${t('execBadge')} (一次性运行，捕获输出与退出码)</option>
    <option value="managed" ${button?.type === 'managed' ? 'selected' : ''}>${t('managedBadge')} (常驻服务，pm2 守护/崩溃自启)</option>
  `;
  body.appendChild(formField('buttonType', typeSelect));

  // Command input + Presets
  const commandInput = textArea(button?.command);
  const cmdField = formField('buttonCommand', commandInput);

  const tplWrap = document.createElement('div');
  tplWrap.className = 'template-chips';
  const presets = [
    { label: 'npm run dev', cmd: 'npm run dev' },
    { label: 'npm start', cmd: 'npm start' },
    { label: 'python main.py', cmd: 'python main.py' },
    { label: 'docker compose up', cmd: 'docker compose up -d' },
    { label: 'git pull', cmd: 'git pull' },
  ];
  for (const p of presets) {
    const chip = document.createElement('span');
    chip.className = 'tpl-chip';
    chip.textContent = p.label;
    chip.addEventListener('click', () => {
      commandInput.value = p.cmd;
    });
    tplWrap.appendChild(chip);
  }
  cmdField.appendChild(tplWrap);
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
    updateCardsTelemetry();
    updateGlobalStats();
  } catch (err) {
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

// Copy AI Usage
$('#copyAiUsageBtn').addEventListener('click', async () => {
  try {
    const res = await api('/api/aiusage');
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

/* ==========================================================================
   Bootstrap Initialization
   ========================================================================== */

initMode();
initTheme();
loadApps();
loadSystem();
clearInterval(state.pollTimer);
state.pollTimer = setInterval(refreshRunsIncremental, 2000);
