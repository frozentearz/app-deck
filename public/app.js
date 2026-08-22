import { t, setLang, initI18n, currentLang } from './i18n.js';

const $ = (sel) => document.querySelector(sel);
const state = {
  apps: [],
  runs: {},
  lang: localStorage.getItem('appdeck-lang') || 'zh',
  pollTimer: null,
  loading: true,
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
  toast.timer = setTimeout(() => el.classList.add('hidden'), error ? 5000 : 2600);
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
  state.apps = await api('/api/apps');
  render();
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
    skeleton.innerHTML = '<div class="skeleton-card"></div><div class="skeleton-card"></div>';
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

    list.appendChild(card);
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
  } else {
    const logs = document.createElement('button');
    logs.className = 'icon-btn';
    logs.textContent = t('logs');
    logs.addEventListener('click', () => openLogs(app, button));
    tile.appendChild(logs);
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
    foot.append(...foot);
    drawer.appendChild(footEl);
  }

  drawer.classList.remove('hidden');
  overlay.classList.remove('hidden');
  drawer.setAttribute('aria-hidden', 'false');

  if (drawerCleanup) drawerCleanup();
  drawerCleanup = () => {
    drawer.classList.add('hidden');
    overlay.classList.add('hidden');
    drawer.setAttribute('aria-hidden', 'true');
    drawerCleanup = null;
  };
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
      command: commandInput.value.trim(),
      cwd: cwdInput.value.trim() || null,
    };
    if (!payload.label || !payload.command) {
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

async function openLogs(app, button) {
  const body = document.createElement('div');
  let history;
  try {
    history = await api(`/api/apps/${encodeURIComponent(app.id)}/buttons/${encodeURIComponent(button.id)}/logs`);
  } catch (err) {
    return toast(t('requestFailed') + err.message, { error: true });
  }

  if (history.length === 0) {
    const empty = document.createElement('p');
    empty.textContent = t('noHistory');
    empty.style.color = 'var(--text-3)';
    body.appendChild(empty);
  }

  for (const entry of history) {
    const block = document.createElement('div');
    block.className = 'log-block';

    const head = document.createElement('div');
    head.className = 'log-head';
    const dot = document.createElement('span');
    dot.className = `dot ${entry.killed ? '' : entry.success ? 'ok' : 'fail'}`;
    const time = document.createElement('span');
    time.className = 'log-time';
    time.textContent = new Date(entry.startedAt).toLocaleString();
    const code = document.createElement('span');
    code.className = `log-code ${entry.success ? 'ok' : 'fail'}`;
    code.textContent = entry.killed ? t('killed') : `${t('exitCode')}: ${entry.exitCode}`;
    const chevron = document.createElement('span');
    chevron.className = 'chevron';
    chevron.textContent = '▶';
    head.append(dot, time, code, chevron);
    head.addEventListener('click', () => block.classList.toggle('open'));

    const logBody = document.createElement('pre');
    logBody.className = 'log-body';
    logBody.textContent = entry.output || '(no output)';
    block.append(head, logBody);
    body.appendChild(block);
  }

  openDrawer({ title: `${button.label} · ${t('logs')}`, body });
}

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
  try {
    const res = await api('/api/system/startup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled }),
    });
    if (res.manual) {
      showManual(res.manual, enabled);
      e.target.checked = false;
    } else {
      toast(t('saveOk'));
    }
    setTimeout(loadSystem, 1500);
  } catch (err) {
    e.target.checked = !enabled;
    toast(t('requestFailed') + err.message, { error: true });
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
