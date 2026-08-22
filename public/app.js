import { t, setLang, initI18n, currentLang } from './i18n.js';

const $ = (sel) => document.querySelector(sel);
const state = {
  apps: [],
  runs: {},
  lang: localStorage.getItem('appdeck-lang') || 'zh',
  pollTimer: null,
  loading: true,
  appLogs: {}, // appId -> { follow: bool, scrollTop: number }
};

initI18n();

/* ---------- api ---------- */

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
  el.textContent = msg;
  el.classList.toggle('error', error);
  el.classList.remove('hidden');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.add('hidden'), 5000);
}

/* ---------- data ---------- */

async function loadApps() {
  const apps = await api('/api/apps');
  state.apps = apps;
  state.loading = false;
  render();
}

async function loadSystem() {
  try {
    const sys = await api('/api/system/status');
    const daemonEl = $('#daemonSwitch');
    const startupEl = $('#startupSwitch');
    daemonEl.disabled = !sys.pm2Installed;
    startupEl.disabled = !sys.pm2Installed;
    daemonEl.checked = sys.daemon;
    startupEl.checked = sys.startup;
    if (!sys.pm2Installed) {
      $('.topbar-actions').title = t('pm2Missing');
    }
  } catch (err) {
    console.warn('system status unavailable:', err.message);
  }
}

async function refreshRuns() {
  const apps = await api('/api/apps');
  state.apps = apps;
  updateCards();
}

/** 增量更新：只刷新按钮状态点与执行记录区，不重建整个列表 */
function updateCards() {
  for (const app of state.apps) {
    const card = document.querySelector(`.card[data-app-id="${app.id}"]`);
    if (!card) continue;

    const tiles = card.querySelectorAll('.button-tile');
    app.buttons.forEach((button, i) => {
      const tile = tiles[i];
      if (!tile) return;
      const dot = tile.querySelector('.dot');
      if (dot) dot.className = `dot ${statusDot(button)}`;
      const stopBtn = tile.querySelector('.btn-stop');
      if (button.state === 'running' && !stopBtn) {
        const stop = document.createElement('button');
        stop.className = 'icon-btn btn-stop';
        stop.textContent = '■';
        stop.title = t('cancel');
        stop.addEventListener('click', () => cancelRun(app, button));
        tile.appendChild(stop);
      } else if (button.state !== 'running' && stopBtn) {
        stopBtn.remove();
      }
    });

    refreshAppLogs(app.id, card);
  }
}

/** 执行记录区：仅当内容变化时才重绘，避免每 2 秒闪烁 */
async function refreshAppLogs(appId, card) {
  const box = card.querySelector('.app-logs-box');
  if (!box) return;
  try {
    const res = await api(`/api/apps/${encodeURIComponent(appId)}/logs`);
    const key = res.entries.map((e) => `${e.id}:${e.finishedAt}`).join('|');
    if (box.dataset.lastKey !== key) {
      renderLogEntries(box, appId, res.entries);
      box.dataset.lastKey = key;
    }
  } catch {
    // 静默失败，下次轮询重试
  }
}

/* ---------- render ---------- */

function statusDot(button) {
  if (button.state === 'running') return 'running';
  return '';
}

function render() {
  const list = $('#appList');
  const empty = $('#emptyState');
  list.innerHTML = '';
  if (state.loading) {
    empty.classList.add('hidden');
    const skeleton = document.createElement('div');
    skeleton.className = 'skeleton';
    skeleton.innerHTML = `
      <div class="skeleton-card">
        <div class="skeleton-line w-40"></div>
        <div class="skeleton-line w-64"></div>
        <div class="skeleton-rows">
          <div class="skeleton-btn"></div>
          <div class="skeleton-btn"></div>
          <div class="skeleton-btn"></div>
        </div>
      </div>
      <div class="skeleton-card">
        <div class="skeleton-line w-32"></div>
        <div class="skeleton-line w-56"></div>
        <div class="skeleton-rows">
          <div class="skeleton-btn"></div>
          <div class="skeleton-btn"></div>
        </div>
      </div>`;
    list.appendChild(skeleton);
    return;
  }
  if (state.apps.length === 0) {
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');

  for (const app of state.apps) {
    const card = document.createElement('section');
    card.className = 'card';
    card.dataset.appId = app.id;

    const head = document.createElement('div');
    head.className = 'card-head';

    const info = document.createElement('div');
    info.className = 'card-info';

    const titleRow = document.createElement('div');
    titleRow.className = 'card-title-row';
    const name = document.createElement('h2');
    name.className = 'card-name';
    name.textContent = app.name;
    const id = document.createElement('span');
    id.className = 'card-id';
    id.textContent = app.id;
    titleRow.append(name, id);
    info.appendChild(titleRow);

    if (app.description) {
      const desc = document.createElement('p');
      desc.className = 'card-desc';
      desc.textContent = app.description;
      info.appendChild(desc);
    }

    const meta = document.createElement('div');
    meta.className = 'card-meta';
    if (app.url) {
      const chip = document.createElement('span');
      chip.className = 'chip';
      const a = document.createElement('a');
      a.href = app.url;
      a.target = '_blank';
      a.rel = 'noreferrer';
      a.textContent = app.url.replace(/^https?:\/\//, '');
      chip.appendChild(a);
      meta.appendChild(chip);
    }
    if (app.dir) {
      const chip = document.createElement('span');
      chip.className = 'chip';
      chip.textContent = app.dir;
      meta.appendChild(chip);
    }
    info.appendChild(meta);

    const actions = document.createElement('div');
    actions.className = 'card-actions';
    const editBtn = document.createElement('button');
    editBtn.className = 'icon-btn';
    editBtn.textContent = t('edit');
    editBtn.addEventListener('click', () => openAppForm(app));
    const delBtn = document.createElement('button');
    delBtn.className = 'icon-btn';
    delBtn.textContent = t('delete');
    delBtn.addEventListener('click', () => deleteApp(app));
    actions.append(editBtn, delBtn);

    head.append(info, actions);
    card.appendChild(head);

    const buttonsWrap = document.createElement('div');
    buttonsWrap.className = 'buttons';
    for (const button of app.buttons) {
      buttonsWrap.appendChild(renderButton(app, button));
    }
    const addBtn = document.createElement('button');
    addBtn.className = 'ghost-btn';
    addBtn.textContent = `+ ${t('addButton')}`;
    addBtn.addEventListener('click', () => openButtonForm(app, null));
    buttonsWrap.appendChild(addBtn);
    card.appendChild(buttonsWrap);

    card.appendChild(renderAppLogs(app));

    list.appendChild(card);
  }
}

/** 项目级执行记录区：约 7 行、可滚动、新日志自动滚到底，上翻暂停跟随 */
function renderAppLogs(app) {
  const wrap = document.createElement('div');
  wrap.className = 'app-logs';
  const header = document.createElement('div');
  header.className = 'app-logs-header';
  header.textContent = t('execRecords');
  wrap.appendChild(header);

  const box = document.createElement('div');
  box.className = 'app-logs-box';
  box.dataset.appId = app.id;

  const saved = state.appLogs[app.id] || { follow: true, scrollTop: 0 };
  state.appLogs[app.id] = saved;

  box.addEventListener('scroll', () => {
    const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
    saved.follow = nearBottom;
    if (!nearBottom) saved.scrollTop = box.scrollTop;
  });

  // 上翻查看历史时暂停跟随；移出区域（失焦）恢复跟随最新
  box.addEventListener('mouseenter', () => {
    saved.follow = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
  });
  box.addEventListener('mouseleave', () => {
    if (!saved.follow) {
      saved.follow = true;
      box.scrollTop = box.scrollHeight;
    }
  });

  const load = async () => {
    try {
      const res = await api(`/api/apps/${encodeURIComponent(app.id)}/logs`);
      renderLogEntries(box, app.id, res.entries);
      box.dataset.lastKey = res.entries.map((e) => `${e.id}:${e.finishedAt}`).join('|');
    } catch {
      // 静默失败，下次轮询重试
    }
  };
  load();
  wrap.appendChild(box);
  return wrap;
}

function renderLogEntries(box, appId, entries) {
  const saved = state.appLogs[appId] || { follow: true, scrollTop: 0 };
  const stickBottom = saved.follow;
  const scrollTop = saved.scrollTop;

  box.innerHTML = '';
  if (!entries || entries.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'app-logs-empty';
    empty.textContent = t('noHistory');
    box.appendChild(empty);
    return;
  }
  for (const e of [...entries].reverse()) {
    const row = document.createElement('div');
    row.className = `log-row ${e.success ? 'ok' : 'fail'}`;
    const time = document.createElement('span');
    time.className = 'log-time';
    time.textContent = new Date(e.startedAt).toLocaleTimeString();
    const label = document.createElement('span');
    label.className = 'log-label';
    label.textContent = e.label || '';
    const status = document.createElement('span');
    status.className = 'log-status';
    status.textContent = e.killed ? t('killed') : (e.success ? `✓ ${e.exitCode}` : `✗ ${e.exitCode}`);
    const sum = document.createElement('span');
    sum.className = 'log-summary';
    sum.textContent = e.summary || '';
    row.append(time, label, status, sum);

    // 点击行展开完整输出
    if (e.output) {
      row.classList.add('expandable');
      row.addEventListener('click', () => {
        const expanded = row.nextElementSibling;
        if (expanded && expanded.classList.contains('log-expanded')) {
          expanded.remove();
          row.classList.remove('open');
          return;
        }
        const pre = document.createElement('pre');
        pre.className = 'log-expanded';
        pre.textContent = e.output;
        row.insertAdjacentElement('afterend', pre);
        row.classList.add('open');
      });
    }

    box.appendChild(row);
  }
  if (stickBottom) {
    box.scrollTop = box.scrollHeight;
  } else {
    box.scrollTop = scrollTop;
  }
}

function renderButton(app, button) {
  const tile = document.createElement('div');
  tile.className = 'button-tile';
  const running = button.state === 'running';

  const dot = document.createElement('span');
  dot.className = `dot ${statusDot(button)}`;
  dot.title = running ? t('running') : '';

  const main = document.createElement('div');
  main.className = 'tile-main';
  const label = document.createElement('div');
  label.className = 'tile-label';
  label.textContent = button.label;
  const command = document.createElement('div');
  command.className = 'tile-command';
  command.textContent = button.command;
  command.title = button.command;
  main.append(label, command);

  tile.append(dot, main);

  if (running) {
    const stop = document.createElement('button');
    stop.className = 'icon-btn';
    stop.textContent = '■';
    stop.title = t('cancel');
    stop.addEventListener('click', () => cancelRun(app, button));
    tile.appendChild(stop);
  }

  const edit = document.createElement('button');
  edit.className = 'icon-btn';
  edit.textContent = t('edit');
  edit.addEventListener('click', () => openButtonForm(app, button));
  tile.appendChild(edit);

  tile.addEventListener('click', (e) => {
    if (e.target.closest('button')) return;
    runButton(app, button);
  });

  return tile;
}

/* ---------- drawer ---------- */

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
  closeBtn.className = 'icon-btn';
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

$('#overlay').addEventListener('click', closeDrawer);

function field(labelKey, inputEl, hintKey) {
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

/* ---------- app form ---------- */

function openAppForm(app = null) {
  const isEdit = !!app;
  const body = document.createElement('div');

  const nameInput = textInput(app?.name);
  body.appendChild(field('appName', nameInput));

  const idInput = textInput(app?.id);
  idInput.disabled = isEdit;
  body.appendChild(field('appId', idInput, 'appIdHint'));

  const descInput = textArea(app?.description);
  body.appendChild(field('appDesc', descInput));

  const dirInput = textInput(app?.dir);
  body.appendChild(field('appDir', dirInput, 'appDirHint'));

  const urlInput = textInput(app?.url, 'http://localhost:3000');
  body.appendChild(field('appUrl', urlInput));

  const portInput = textInput(app?.port ?? '');
  portInput.inputMode = 'numeric';
  body.appendChild(field('appPort', portInput, 'appPortHint'));

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

/* ---------- button form ---------- */

function openButtonForm(app, button = null) {
  const isEdit = !!button;
  const body = document.createElement('div');

  const labelInput = textInput(button?.label);
  body.appendChild(field('buttonLabel', labelInput));

  const idInput = textInput(button?.id);
  idInput.disabled = isEdit;
  body.appendChild(field('buttonId', idInput, 'appIdHint'));

  const commandInput = textArea(button?.command);
  body.appendChild(field('buttonCommand', commandInput));

  const cwdInput = textInput(button?.cwd ?? '');
  cwdInput.placeholder = app.dir ?? '';
  body.appendChild(field('buttonCwd', cwdInput, 'buttonCwdHint'));

  const saveBtn = document.createElement('button');
  saveBtn.className = 'primary-btn';
  saveBtn.textContent = t('save');
  saveBtn.addEventListener('click', async () => {
    const id = isEdit ? button.id : (idInput.value.trim() || `btn-${Math.random().toString(36).slice(2, 8)}`);
    const payload = {
      label: labelInput.value.trim(),
      command: commandInput.value.trim() || null,
      cwd: cwdInput.value.trim() || null,
    };
    if (!payload.label) {
      return toast(t('fieldsRequired'), { error: true });
    }
    const method = isEdit ? 'PATCH' : 'PUT';
    try {
      await api(`/api/apps/${encodeURIComponent(app.id)}/buttons/${encodeURIComponent(id)}`, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...payload, type: 'exec' }),
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

/* ---------- run / cancel ---------- */

async function runButton(app, button) {
  try {
    await api(`/api/apps/${encodeURIComponent(app.id)}/buttons/${encodeURIComponent(button.id)}/run`, { method: 'POST' });
    toast(t('started'));
    button.state = 'running';
    render();
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
  } catch (err) {
    toast(t('requestFailed') + err.message, { error: true });
  }
}

/* ---------- logs ---------- */

/* ---------- system switches ---------- */

async function waitForServer(maxSeconds = 15) {
  for (let i = 0; i < maxSeconds; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    try {
      const response = await fetch('/api/health');
      if (response.ok) return true;
    } catch {
      // 服务未恢复，继续等待
    }
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
      showManual(res.manual, enabled);
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

function showManual(command, enabled) {
  const body = document.createElement('div');
  const text = document.createElement('p');
  text.textContent = t(enabled ? 'manualStartup' : 'manualUnstartup');
  text.style.marginBottom = '10px';
  const pre = document.createElement('pre');
  pre.className = 'log-body';
  pre.style.display = 'block';
  pre.textContent = command;
  const copyBtn = document.createElement('button');
  copyBtn.className = 'ghost-btn';
  copyBtn.textContent = t('copy');
  copyBtn.addEventListener('click', async () => {
    await navigator.clipboard.writeText(command);
    copyBtn.textContent = t('copied');
  });
  body.append(text, pre, copyBtn);
  openDrawer({ title: t('startup'), body });
}

/* ---------- lang ---------- */

$('#langBtn').addEventListener('click', () => {
  const next = currentLang === 'zh' ? 'en' : 'zh';
  setLang(next);
  $('#langBtn').textContent = t('langName');
  render();
});

$('#langBtn').textContent = t('langName');

/* ---------- copy AIUsage ---------- */

$('#copyAiUsageBtn').addEventListener('click', async () => {
  try {
    const res = await api('/api/aiusage');
    await navigator.clipboard.writeText(res.content);
    toast(t('aiUsageCopied'));
  } catch (err) {
    toast(t('requestFailed') + err.message, { error: true });
  }
});

/* ---------- polling ---------- */

function refreshPolling() {
  clearInterval(state.pollTimer);
  state.pollTimer = setInterval(refreshRuns, 2000);
}

$('#addAppBtn').addEventListener('click', () => openAppForm());
document.querySelector('[data-action="add-app"]').addEventListener('click', () => openAppForm());

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeDrawer();
});

loadApps().catch((err) => toast(t('requestFailed') + err.message, { error: true }));
loadSystem();
refreshPolling();
