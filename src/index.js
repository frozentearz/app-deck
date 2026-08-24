import http from 'node:http';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, normalize, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Executor } from './executor.js';
import { Pm2 } from './pm2.js';
import { Store } from './store.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const DEFAULT_PORT = 6969;
const DEFAULT_DATA_DIR = join(homedir(), '.app-deck');
const APP_ID_RE = /^[a-z0-9-]+$/;
const BUTTON_TYPES = ['managed', 'exec'];
const BUTTON_OUTPUT_FORMATS = ['text', 'json', 'markdown'];

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.ico': 'image/x-icon',
};

function send(res, status, body) {
  const data = typeof body === 'string' ? body : JSON.stringify(body);
  const type = typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json';
  res.writeHead(status, { 'Content-Type': type });
  res.end(data);
}

function badRequest(res, msg) {
  send(res, 400, { error: msg });
}

function notFound(res) {
  send(res, 404, { error: 'not found' });
}

async function readBody(req) {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error('invalid JSON body');
  }
}

function normalizeApp(input, { id } = {}) {
  const appId = id ?? input.id;
  if (!appId || typeof appId !== 'string' || !APP_ID_RE.test(appId)) {
    throw new Error(`app id "${appId}" invalid (a-z0-9-)`);
  }
  if (!input.name || typeof input.name !== 'string') throw new Error('name is required');
  const app = {
    id: appId,
    name: input.name,
    description: input.description ?? '',
    dir: input.dir ?? null,
    url: input.url ?? null,
    port: input.port ?? null,
    pinned: input.pinned ?? false,
    pinnedAt: input.pinnedAt ?? null,
    buttons: [],
  };
  for (const b of input.buttons ?? []) {
    app.buttons.push(normalizeButton(b));
  }
  return app;
}

function normalizeButton(input, { appId, id } = {}) {
  const buttonId = id ?? input.id;
  if (!buttonId || typeof buttonId !== 'string' || !APP_ID_RE.test(buttonId)) {
    throw new Error(`button id "${buttonId}" invalid (a-z0-9-)`);
  }
  if (!input.label || typeof input.label !== 'string') throw new Error('label is required');
  if (!BUTTON_TYPES.includes(input.type)) throw new Error(`type must be one of ${BUTTON_TYPES.join(',')}`);
  const outputFormat = input.outputFormat ?? 'text';
  if (!BUTTON_OUTPUT_FORMATS.includes(outputFormat)) {
    throw new Error(`outputFormat must be one of ${BUTTON_OUTPUT_FORMATS.join(',')}`);
  }
  return {
    id: buttonId,
    label: input.label,
    type: input.type,
    command: input.command ?? null,
    cwd: input.cwd ?? null,
    shell: input.shell ?? true,
    outputFormat,
  };
}

function pm2Name(appId, buttonId) {
  return `${appId}-${buttonId}`;
}

function buttonChanged(a, b) {
  return a.type !== b.type || a.command !== b.command || a.cwd !== b.cwd || a.shell !== b.shell || a.outputFormat !== b.outputFormat;
}

async function teardownButton(pm2, store, runs, appId, button) {
  const key = `${appId}/${button.id}`;
  const run = runs[key];
  if (run?.executor) {
    run.executor.cancel();
    delete runs[key];
  }
  if (button.type === 'managed') {
    try {
      await pm2.delete(pm2Name(appId, button.id));
    } catch {}
  }
}

export function createServer({ store, pm2Path, publicDir = join(__dirname, '..', 'public'), port = DEFAULT_PORT, selfExit = () => process.exit(0), elevate = true, startupHome = homedir(), openTerminal = openNativeTerminal } = {}) {
  const pm2 = new Pm2({ pm2Path });
  const runs = {};
  const historyQueues = new Map();
  let daemonPending = null;
  let startupPending = null;

  async function persistHistory(appId, buttonId, entry) {
    store.addHistory(appId, buttonId, entry);
    const key = `${appId}/${buttonId}`;
    if (historyQueues.has(key)) return;
    historyQueues.set(
      key,
      store.saveHistory().finally(() => historyQueues.delete(key))
    );
  }

  async function appView(app) {
    const buttons = [];
    for (const b of app.buttons) {
      const key = `${app.id}/${b.id}`;
      const v = { ...b, state: 'idle' };
      if (b.type === 'managed') {
        try {
          const status = await pm2.status(pm2Name(app.id, b.id));
          v.state = status.online ? 'running' : 'idle';
          if (status.online && status.uptime) {
            v.startedAt = status.uptime;
          }
        } catch {}
      } else if (runs[key]) {
        v.state = runs[key].state;
        if (runs[key].startedAt) v.startedAt = runs[key].startedAt;
      }
      buttons.push(v);
    }
    return { ...app, buttons };
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
    const { pathname } = url;
    const parts = pathname.split('/').filter(Boolean);
    try {
      if (pathname.startsWith('/api/')) {
        await route(parts, req, res);
      } else {
        await serveStatic(url, res);
      }
    } catch (err) {
      if (err.code === 'ERR_STREAM_PREMATURE_CLOSE') return;
      if (err.message === 'invalid JSON body') return badRequest(res, 'invalid JSON body');
      console.error('[app-deck] request error:', err);
      send(res, 500, { error: err.message });
    }
  });

  async function route(parts, req, res) {
    const [a1, a2, a3, a4, a5, a6] = parts;
    if (a1 !== 'api') return notFound(res);
    if (a2 === 'health' && parts.length === 2) return handleHealth(res);
    if (a2 === 'system' && parts.length === 3) return handleSystem(a3, req, res);
    if (a2 === 'export' && parts.length === 2) return send(res, 200, { apps: store.listApps() });
    if (a2 === 'import' && parts.length === 2) return handleImport(req, res);
    if ((a2 === 'agent-guide' || a2 === 'agent_guide' || a2 === 'aiusage' || a2 === 'ai-usage') && parts.length === 2) return handleAgentGuide(res);
    if (a2 !== 'apps') return notFound(res);

    if (a3 === undefined) return handleApps(req, res);
    if (a4 === 'logs' && parts.length === 4) return handleAppLogs(req, res, a3);
    if (a4 === 'logs' && parts.length === 5) return handleAppLogEntry(req, res, a3, parts[4]);
    if (a4 === 'status' && parts.length === 4) return handleAppStatus(res, a3);
    if (a4 === 'open-terminal' && parts.length === 4) return handleOpenTerminal(req, res, a3);
    if (a4 === undefined) return handleApp(req, res, a3);
    if (a4 !== 'buttons') return notFound(res);
    if (a5 === undefined) {
      const app = store.getApp(a3);
      if (!app) return notFound(res);
      return send(res, 200, app.buttons);
    }
    if (a6 === undefined) return handleButton(req, res, a3, a5);
    if (a6 === 'run') return handleRun(req, res, a3, a5);
    if (a6 === 'cancel') return handleCancel(res, a3, a5);
    if (a6 === 'status') return handleStatus(res, a3, a5);
    if (a6 === 'logs' && parts.length === 6) return handleLogs(req, res, a3, a5);
    if (a6 === 'logs' && parts.length === 7) return handleButtonLogEntry(req, res, a3, a5, parts[6]);
    if (a6 === 'stream') return handleStream(req, res, a3, a5);
    return notFound(res);
  }

  function handleHealth(res) {
    send(res, 200, { status: 'ok' });
  }

  async function handleAgentGuide(res) {
    try {
      let content;
      try {
        content = await readFile(join(projectRoot, 'docs', 'AGENT_GUIDE.md'), 'utf8');
      } catch {
        content = await readFile(join(projectRoot, 'docs', 'AIUsage.md'), 'utf8');
      }
      send(res, 200, { content });
    } catch {
      send(res, 404, { error: 'AGENT_GUIDE.md not found' });
    }
  }

  async function handleSystem(action, req, res) {
    if (action === 'status') {
      const [daemon, installed] = await Promise.all([
        pm2.status('app-deck').catch(() => ({ online: false })),
        pm2.isInstalled().catch(() => false),
      ]);
      send(res, 200, { daemon: daemon.online ?? false, startup: pm2.startupStatus({ home: startupHome }), pm2Installed: installed });
    } else if (action === 'daemon') {
      const body = await readBody(req);
      const enabled = body.enabled === true;
      if (!(await pm2.isInstalled().catch(() => false))) return send(res, 503, { error: 'pm2 not installed' });
      if (daemonPending) return send(res, 409, { error: 'daemon operation in progress' });
      daemonPending = true;
      try {
        if (enabled) {
          // --no-autorestart：进程退出后 pm2 不自动重启（pm2 7 官方参数）
          await pm2.start({ name: 'app-deck', script: 'src/index.js', cwd: projectRoot });
          await pm2.save();
          send(res, 200, { enabled: true, manual: null });
          setTimeout(() => selfExit(), 500);
        } else {
          send(res, 200, { enabled: false, manual: null });
          if (process.env.NODE_APP_INSTANCE !== undefined) {
            // 当前进程由 pm2 托管：先 spawn 独立子进程接棒端口，再显式 stop（不会自动重启）
            const childEnv = { ...process.env };
            delete childEnv.NODE_APP_INSTANCE;
            const child = spawn(process.execPath, [join(projectRoot, 'src/index.js')], {
              cwd: projectRoot,
              detached: true,
              stdio: 'ignore',
              env: childEnv,
            });
            child.unref();
            setTimeout(() => {
              pm2.stop('app-deck').then(() => pm2.save()).catch(() => {});
            }, 1500);
          } else {
            await pm2.stop('app-deck');
            await pm2.save();
          }
        }
      } catch (err) {
        send(res, 500, { error: err.message });
      } finally {
        daemonPending = false;
      }
    } else if (action === 'startup') {
      const body = await readBody(req);
      const enabled = body.enabled === true;
      if (!(await pm2.isInstalled().catch(() => false))) return send(res, 503, { error: 'pm2 not installed' });
      if (startupPending) return send(res, 409, { error: 'startup operation in progress' });
      startupPending = true;
      try {
        let manual = null;
        if (enabled) {
          const result = elevate ? await pm2.startupElevated() : await pm2.startup();
          manual = result.manual;
          if (!manual) await pm2.save();
        } else {
          const result = elevate ? await pm2.unstartupElevated() : await pm2.unstartup();
          manual = result.manual;
          if (!manual) await pm2.save();
        }
        send(res, 200, { enabled, manual });
      } catch (err) {
        send(res, 500, { error: err.message });
      } finally {
        startupPending = false;
      }
    } else {
      notFound(res);
    }
  }

  async function handleImport(req, res) {
    const body = await readBody(req);
    if (!Array.isArray(body.apps)) return badRequest(res, 'apps must be an array');
    const apps = [];
    for (const a of body.apps) {
      apps.push(normalizeApp(a, { id: a.id }));
    }
    store.apps = apps;
    await store.save();
    send(res, 200, { apps: apps.length });
  }

  async function handleApps(req, res) {
    if (req.method === 'GET') {
      let apps = store.listApps();
      // 置顶排序：pinned 在前（按 pinnedAt 倒序，最新置顶最前），非 pinned 保持原序
      const pinned = apps.filter((a) => a.pinned).sort((a, b) => (b.pinnedAt ?? 0) - (a.pinnedAt ?? 0));
      const unpinned = apps.filter((a) => !a.pinned);
      apps = [...pinned, ...unpinned];
      const views = [];
      for (const a of apps) views.push(await appView(a));
      send(res, 200, views);
    } else if (req.method === 'POST') {
      const body = await readBody(req);
      let app;
      try {
        app = normalizeApp(body, { id: `app-${randomBytes(3).toString('hex')}` });
      } catch (err) {
        return badRequest(res, err.message);
      }
      if (store.getApp(app.id)) return send(res, 409, { error: 'app already exists' });
      store.upsertApp(app);
      await store.save();
      send(res, 201, app);
    } else {
      notFound(res);
    }
  }

  async function handleApp(req, res, appId) {
    if (req.method === 'GET') {
      const app = store.getApp(appId);
      if (!app) return notFound(res);
      send(res, 200, await appView(app));
    } else if (req.method === 'PUT') {
      const body = await readBody(req);
      let app;
      try {
        app = normalizeApp(body, { id: appId });
      } catch (err) {
        return badRequest(res, err.message);
      }
      const existing = store.getApp(appId);
      if (existing) {
        for (const b of existing.buttons) {
          const newButton = app.buttons.find((nb) => nb.id === b.id);
          if (!newButton || buttonChanged(b, newButton)) {
            await teardownButton(pm2, store, runs, appId, b);
          }
        }
      }
      store.upsertApp(app);
      await store.save();
      send(res, 200, app);
    } else if (req.method === 'PATCH') {
      const app = store.getApp(appId);
      if (!app) return notFound(res);
      const body = await readBody(req);
      const merged = normalizeApp({ ...app, ...body, id: appId }, { id: appId });
      // 置顶/取消置顶：置顶时刷新 pinnedAt，取消置顶清空
      if ('pinned' in body) {
        merged.pinned = body.pinned === true;
        merged.pinnedAt = merged.pinned ? Date.now() : null;
      }
      store.upsertApp(merged);
      await store.save();
      send(res, 200, merged);
    } else if (req.method === 'DELETE') {
      const app = store.getApp(appId);
      if (app) {
        for (const b of app.buttons) {
          await teardownButton(pm2, store, runs, appId, b);
          store.deleteHistory(appId, b.id);
        }
        await store.saveHistory();
      }
      store.deleteApp(appId);
      await store.save();
      send(res, 200, { ok: true });
    } else {
      notFound(res);
    }
  }

  async function handleButton(req, res, appId, buttonId) {
    const app = store.getApp(appId);
    if (!app) return notFound(res);
    if (req.method === 'PUT' || req.method === 'PATCH') {
      const body = await readBody(req);
      let button;
      try {
        if (req.method === 'PUT') {
          button = normalizeButton(body, { appId, id: buttonId });
        } else {
          const existing = store.getButton(appId, buttonId);
          if (!existing) return notFound(res);
          button = normalizeButton({ ...existing, ...body }, { appId, id: buttonId });
        }
      } catch (err) {
        return badRequest(res, err.message);
      }
      const existingButton = store.getButton(appId, buttonId);
      if (existingButton && buttonChanged(existingButton, button)) {
        await teardownButton(pm2, store, runs, appId, existingButton);
      }
      store.upsertButton(appId, button);
      await store.save();
      send(res, 200, button);
    } else if (req.method === 'DELETE') {
      const existing = store.getButton(appId, buttonId);
      if (!existing) return notFound(res);
      await teardownButton(pm2, store, runs, appId, existing);
      store.deleteHistory(appId, buttonId);
      store.deleteButton(appId, buttonId);
      await store.save();
      await store.saveHistory();
      send(res, 200, { ok: true });
    } else {
      notFound(res);
    }
  }

  async function handleRun(req, res, appId, buttonId) {
    if (req.method !== 'POST') return notFound(res);
    const app = store.getApp(appId);
    if (!app) return notFound(res);
    const button = store.getButton(appId, buttonId);
    if (!button) return notFound(res);
    if (!button.command) {
      return send(res, 400, { error: '请先配置项目路径与项目按钮的脚本' });
    }
    const cwd = button.cwd ?? app.dir;
    if (!cwd) {
      return send(res, 400, { error: '请先配置项目路径与项目按钮的脚本' });
    }
    const key = `${appId}/${buttonId}`;
    const name = pm2Name(appId, buttonId);
    const runId = `r${Date.now().toString(36)}${randomBytes(2).toString('hex')}`;

    if (button.type === 'exec') {
      if (runs[key]?.state === 'running') {
        return send(res, 409, { error: 'already running' });
      }
      const run = { state: 'running', executor: null, startedAt: null, runId };
      runs[key] = run;
      const executor = new Executor({ command: button.command, cwd, shell: button.shell });
      run.executor = executor;
      executor.on('running', ({ startedAt }) => {
        run.startedAt = startedAt;
      });
      executor.on('finished', (result) => {
        const entry = {
          id: runId,
          startedAt: result.startedAt,
          finishedAt: result.finishedAt,
          exitCode: result.exitCode,
          success: result.success,
          killed: result.killed,
          summary: result.summary,
          output: result.output,
          outputFormat: button.outputFormat ?? 'text',
        };
        persistHistory(appId, buttonId, entry).catch(() => {});
        runs[key] = { state: 'idle', lastResult: result };
      });
      executor.start();
      send(res, 202, { state: 'running', runId });
    } else {
      try {
        const status = await pm2.status(name);
        if (status.online) return send(res, 409, { error: 'already running' });
        const shell = process.platform === 'win32' ? 'cmd' : 'bash';
        const flag = process.platform === 'win32' ? '/c' : '-c';
        await pm2.start({ name, script: shell, cwd, args: [flag, button.command] });
        const now = Date.now();
        persistHistory(appId, buttonId, {
          id: runId, startedAt: now, finishedAt: now,
          exitCode: 0, success: true, killed: false,
          summary: `pm2 start ${name}`, output: '',
          outputFormat: button.outputFormat ?? 'text',
        }).catch(() => {});
        send(res, 202, { state: 'running', runId });
      } catch (err) {
        send(res, 500, { error: err.message });
      }
    }
  }

  async function handleCancel(res, appId, buttonId) {
    const app = store.getApp(appId);
    if (!app) return notFound(res);
    const button = store.getButton(appId, buttonId);
    if (!button) return notFound(res);
    const key = `${appId}/${buttonId}`;
    const name = pm2Name(appId, buttonId);

    if (button.type === 'managed') {
      try {
        await pm2.stop(name);
        const now = Date.now();
        persistHistory(appId, buttonId, {
          id: `r${Date.now().toString(36)}${randomBytes(2).toString('hex')}`,
          startedAt: now, finishedAt: now,
          exitCode: null, success: false, killed: true,
          summary: `pm2 stop ${name}`, output: '',
        }).catch(() => {});
        send(res, 200, { ok: true });
      } catch (err) {
        send(res, 500, { error: err.message });
      }
    } else {
      const run = runs[key];
      if (!run || !run.executor) return send(res, 409, { error: 'not running' });
      run.executor.cancel();
      send(res, 200, { ok: true });
    }
  }

  async function handleStatus(res, appId, buttonId) {
    const app = store.getApp(appId);
    if (!app) return notFound(res);
    const button = store.getButton(appId, buttonId);
    if (!button) return notFound(res);
    const key = `${appId}/${buttonId}`;

    if (button.type === 'managed') {
      try {
        const status = await pm2.status(pm2Name(appId, buttonId));
        const history = store.listHistory(appId, buttonId);
        const last = history[0] ?? null;
        send(res, 200, {
          state: status.online ? 'running' : 'idle',
          startedAt: (status.online && status.uptime) ? status.uptime : (last?.startedAt ?? null),
          lastResult: last ? { exitCode: last.exitCode, success: last.success, killed: last.killed, finishedAt: last.finishedAt } : null,
        });
      } catch {
        send(res, 200, { state: 'idle', startedAt: null, lastResult: null });
      }
    } else {
      const run = runs[key];
      send(res, 200, {
        state: run?.state ?? 'idle',
        startedAt: run?.startedAt ?? null,
        lastResult: run?.lastResult
          ? { exitCode: run.lastResult.exitCode, success: run.lastResult.success, killed: run.lastResult.killed, finishedAt: run.lastResult.finishedAt }
          : null,
      });
    }
  }

  async function handleLogs(req, res, appId, buttonId) {
    const app = store.getApp(appId);
    if (!app) return notFound(res);
    const button = store.getButton(appId, buttonId);
    if (!button) return notFound(res);
    if (req.method === 'GET') {
      send(res, 200, store.listHistory(appId, buttonId));
    } else if (req.method === 'DELETE') {
      store.deleteHistory(appId, buttonId);
      await store.saveHistory();
      send(res, 200, { ok: true });
    } else {
      notFound(res);
    }
  }

  async function handleButtonLogEntry(req, res, appId, buttonId, runId) {
    const app = store.getApp(appId);
    if (!app) return notFound(res);
    const button = store.getButton(appId, buttonId);
    if (!button) return notFound(res);
    if (req.method === 'DELETE') {
      const ok = store.deleteHistoryEntry(appId, buttonId, runId);
      await store.saveHistory();
      send(res, 200, { ok });
    } else {
      notFound(res);
    }
  }

  async function handleStream(req, res, appId, buttonId) {
    if (req.method !== 'GET') return send(res, 405, { error: 'Method not allowed' });
    const app = store.getApp(appId);
    if (!app) return notFound(res);
    const button = store.getButton(appId, buttonId);
    if (!button) return notFound(res);

    const key = `${appId}/${buttonId}`;
    const run = runs[key];

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
    });

    if (run && run.state === 'running' && run.executor) {
      const executor = run.executor;
      res.write(`event: init\ndata: ${JSON.stringify({ running: true, output: executor.output, startedAt: run.startedAt, runId: run.runId })}\n\n`);

      const onData = ({ chunk, fullOutput }) => {
        res.write(`event: data\ndata: ${JSON.stringify({ chunk, fullOutput })}\n\n`);
      };

      const onFinished = (result) => {
        res.write(`event: end\ndata: ${JSON.stringify(result)}\n\n`);
        res.end();
      };

      executor.on('data', onData);
      executor.on('finished', onFinished);

      req.on('close', () => {
        executor.off('data', onData);
        executor.off('finished', onFinished);
      });
    } else {
      const history = store.listHistory(appId, buttonId);
      const latest = history[0] || null;
      res.write(`event: end\ndata: ${JSON.stringify({ running: false, lastResult: latest })}\n\n`);
      res.end();
    }
  }

  async function handleAppLogs(req, res, appId) {
    const app = store.getApp(appId);
    if (!app) return notFound(res);
    if (req.method === 'GET') {
      const entries = [];
      for (const b of app.buttons) {
        for (const e of store.listHistory(appId, b.id)) {
          entries.push({ ...e, buttonId: b.id, label: b.label, outputFormat: b.outputFormat || e.outputFormat || 'text' });
        }
      }
      entries.sort((a, b) => b.startedAt - a.startedAt);
      send(res, 200, { entries });
    } else if (req.method === 'DELETE') {
      store.deleteAppHistory(appId);
      await store.saveHistory();
      send(res, 200, { ok: true });
    } else {
      notFound(res);
    }
  }

  async function handleAppLogEntry(req, res, appId, runId) {
    const app = store.getApp(appId);
    if (!app) return notFound(res);
    if (req.method === 'DELETE') {
      let ok = false;
      for (const b of app.buttons) {
        if (store.deleteHistoryEntry(appId, b.id, runId)) {
          ok = true;
        }
      }
      await store.saveHistory();
      send(res, 200, { ok });
    } else {
      notFound(res);
    }
  }

  /** 端口探活：每次调用真实 TCP 连接（无缓存） */
  async function probeApp(appId, port) {
    if (!port) return null;
    return new Promise((resolve) => {
      const socket = new net.Socket();
      socket.setTimeout(2000);
      socket.once('connect', () => { socket.destroy(); resolve(true); });
      socket.once('timeout', () => { socket.destroy(); resolve(false); });
      socket.once('error', () => resolve(false));
      socket.connect(port, '127.0.0.1');
    });
  }

  async function handleAppStatus(res, appId) {
    const app = store.getApp(appId);
    if (!app) return notFound(res);
    const online = await probeApp(appId, app.port);
    send(res, 200, { online });
  }

  async function handleOpenTerminal(req, res, appId) {
    if (req.method !== 'POST') return send(res, 405, { error: 'Method not allowed' });
    const app = store.getApp(appId);
    if (!app) return notFound(res);
    if (!app.dir) return send(res, 400, { error: '项目未配置工作目录' });
    try {
      openTerminal(app.dir);
      send(res, 200, { ok: true, dir: app.dir });
    } catch (err) {
      send(res, 500, { error: err.message });
    }
  }

  async function serveStatic(url, res) {
    let pathname = url.pathname;
    if (pathname === '/') pathname = '/index.html';
    if (!publicDir) return notFound(res);
    const filePath = normalize(join(publicDir, pathname));
    if (!filePath.startsWith(normalize(publicDir))) return notFound(res);
    try {
      const content = await readFile(filePath);
      const type = MIME[extname(filePath)] ?? 'application/octet-stream';
      res.writeHead(200, {
        'Content-Type': type,
        'Cache-Control': 'no-cache, no-store, must-revalidate',
      });
      res.end(content);
    } catch {
      notFound(res);
    }
  }

  return server;
}

export function openNativeTerminal(dir) {
  if (!dir) return false;
  if (process.env.NODE_ENV === 'test') return true;
  const cleanDir = normalize(dir);
  if (process.platform === 'darwin') {
    const escaped = cleanDir.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const script = `tell application "Terminal" to do script "cd \\"${escaped}\\""\ntell application "Terminal" to activate`;
    const child = spawn('osascript', ['-e', script], { detached: true, stdio: 'ignore' });
    child.unref();
    return true;
  }
  if (process.platform === 'win32') {
    const child = spawn('cmd.exe', ['/c', 'start', 'wt.exe', '-d', `"${cleanDir}"`], { detached: true, stdio: 'ignore' });
    child.on('error', () => {
      spawn('cmd.exe', ['/c', 'start', 'cmd.exe', '/k', `cd /d "${cleanDir}"`], { detached: true, stdio: 'ignore' });
    });
    child.unref();
    return true;
  }
  // Linux
  const terminals = ['x-terminal-emulator', 'gnome-terminal', 'konsole', 'xfce4-terminal', 'xterm'];
  for (const term of terminals) {
    try {
      const child = spawn(term, term === 'gnome-terminal' ? [`--working-directory=${cleanDir}`] : [], {
        cwd: cleanDir,
        detached: true,
        stdio: 'ignore',
      });
      child.on('error', () => {});
      child.unref();
      return true;
    } catch {}
  }
  return false;
}

const isMain = process.env.NODE_APP_INSTANCE !== undefined || (process.argv[1] && fileURLToPath(`file://${process.argv[1]}`) === fileURLToPath(import.meta.url));

if (isMain) {
  const dataDir = process.env.APP_DECK_DATA_DIR ?? DEFAULT_DATA_DIR;
  const store = await new Store({ dataDir }).init();
  const server = createServer({ store });
  const listenWithRetry = (triesLeft) => {
    server.once('error', (err) => {
      if (err.code === 'EADDRINUSE' && triesLeft > 0) {
        console.log(`[app-deck] port ${DEFAULT_PORT} busy, retrying in 500ms (${triesLeft} left)`);
        setTimeout(() => listenWithRetry(triesLeft - 1), 500);
      } else {
        console.error(`[app-deck] cannot listen on ${DEFAULT_PORT}:`, err.message);
        process.exit(1);
      }
    });
    server.listen(DEFAULT_PORT, () => {
      console.log(`[app-deck] listening on http://localhost:${DEFAULT_PORT}`);
    });
  };
  listenWithRetry(10);
}
