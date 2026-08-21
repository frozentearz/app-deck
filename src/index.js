import http from 'node:http';
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
  if (!input.command || typeof input.command !== 'string') throw new Error('command is required');
  return {
    id: buttonId,
    label: input.label,
    type: input.type,
    command: input.command,
    cwd: input.cwd ?? null,
    shell: input.shell ?? true,
  };
}

function buttonView(button, run) {
  const v = { ...button, state: 'idle' };
  if (run) {
    v.state = run.state;
    if (run.startedAt) v.startedAt = run.startedAt;
  }
  return v;
}

function appView(app, runs) {
  return { ...app, buttons: app.buttons.map((b) => buttonView(b, runs[`${app.id}/${b.id}`])) };
}

function handleRunManaged(runs, runKey, { command, cwd, shell }) {
  if (runs[runKey]) {
    return { conflict: true };
  }
  const ex = new Executor({ command, cwd, shell });
  runs[runKey] = { state: 'running', executor: ex, startedAt: null };
  ex.on('running', ({ startedAt }) => {
    const run = runs[runKey];
    if (run) run.startedAt = startedAt;
  });
  ex.on('finished', (result) => {
    runs[runKey] = { state: 'idle', lastResult: result };
  });
  ex.start();
  return { conflict: false };
}

export function createServer({ store, pm2Path, publicDir = join(__dirname, '..', 'public'), port = DEFAULT_PORT, selfExit = () => process.exit(0) } = {}) {
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
    if (a2 !== 'apps') return notFound(res);
    if (a3 === undefined) return handleApps(req, res);
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
    if (a6 === 'logs') return handleLogs(res, a3, a5);
    return notFound(res);
  }

  function handleHealth(res) {
    send(res, 200, { status: 'ok' });
  }

  async function handleSystem(action, req, res) {
    if (action === 'status') {
      const [daemon, installed] = await Promise.all([
        pm2.status('app-deck').catch(() => ({ online: false })),
        pm2.isInstalled().catch(() => false),
      ]);
      send(res, 200, { daemon: daemon.online ?? false, startup: pm2.startupStatus(), pm2Installed: installed });
    } else if (action === 'daemon') {
      const body = await readBody(req);
      const enabled = body.enabled === true;
      if (daemonPending) return send(res, 409, { error: 'daemon operation in progress' });
      daemonPending = true;
      try {
        if (enabled) {
          await pm2.start({ name: 'app-deck', script: 'src/index.js', cwd: projectRoot });
          await pm2.save();
          send(res, 200, { enabled: true, manual: null });
          setTimeout(() => selfExit(), 500);
        } else {
          send(res, 200, { enabled: false, manual: null });
          setTimeout(() => {
            pm2.stop('app-deck').then(() => pm2.save()).catch(() => {});
          }, 500);
        }
      } catch (err) {
        send(res, 500, { error: err.message });
      } finally {
        daemonPending = false;
      }
    } else if (action === 'startup') {
      const body = await readBody(req);
      const enabled = body.enabled === true;
      if (startupPending) return send(res, 409, { error: 'startup operation in progress' });
      startupPending = true;
      try {
        let manual = null;
        if (enabled) {
          const result = await pm2.startup();
          manual = result.manual;
          if (!manual) await pm2.save();
        } else {
          const result = await pm2.unstartup();
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
      send(res, 200, store.listApps().map((a) => appView(a, runs)));
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
      send(res, 200, appView(app, runs));
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
          if (b.type === 'managed') stopManaged(appId, b.id);
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
      store.upsertApp(merged);
      await store.save();
      send(res, 200, merged);
    } else if (req.method === 'DELETE') {
      const app = store.getApp(appId);
      if (app) {
        for (const b of app.buttons) {
          if (b.type === 'managed') stopManaged(appId, b.id);
          const key = `${appId}/${b.id}`;
          if (runs[key]) delete runs[key];
        }
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
      if (button.type === 'managed') stopManaged(appId, buttonId);
      store.upsertButton(appId, button);
      await store.save();
      send(res, 200, button);
    } else if (req.method === 'DELETE') {
      const existing = store.getButton(appId, buttonId);
      if (!existing) return notFound(res);
      if (existing.type === 'managed') stopManaged(appId, buttonId);
      const key = `${appId}/${buttonId}`;
      if (runs[key]) delete runs[key];
      store.deleteButton(appId, buttonId);
      await store.save();
      send(res, 200, { ok: true });
    } else {
      notFound(res);
    }
  }

  function handleRun(req, res, appId, buttonId) {
    if (req.method !== 'POST') return notFound(res);
    const app = store.getApp(appId);
    if (!app) return notFound(res);
    const button = store.getButton(appId, buttonId);
    if (!button) return notFound(res);
    const key = `${appId}/${buttonId}`;
    if (runs[key]?.state === 'running') {
      return send(res, 409, { error: 'already running' });
    }
    const cwd = button.cwd ?? app.dir;
    if (button.type === 'exec') {
      const runId = `r${Date.now().toString(36)}${randomBytes(2).toString('hex')}`;
      const run = { state: 'running', executor: null, startedAt: null, runId };
      runs[key] = run;
      const executor = new Executor({ command: button.command, cwd, shell: button.shell });
      run.executor = executor;
      executor.on('running', ({ startedAt }) => {
        run.startedAt = startedAt;
      });
      executor.on('finished', (result) => {
        const entry = {
          id: `r${runId}`,
          startedAt: result.startedAt,
          finishedAt: result.finishedAt,
          exitCode: result.exitCode,
          success: result.success,
          killed: result.killed,
          summary: result.summary,
          output: result.output,
        };
        persistHistory(appId, buttonId, entry).catch(() => {});
        runs[key] = { state: 'idle', lastResult: result };
      });
      executor.start();
      send(res, 202, { state: 'running', runId });
    } else {
      const managed = handleRunManaged(runs, key, { command: button.command, cwd, shell: button.shell });
      if (managed.conflict) return send(res, 409, { error: 'already running' });
      send(res, 202, { state: 'running' });
    }
  }

  function handleCancel(res, appId, buttonId) {
    const app = store.getApp(appId);
    if (!app) return notFound(res);
    const button = store.getButton(appId, buttonId);
    if (!button) return notFound(res);
    const run = runs[`${appId}/${buttonId}`];
    if (!run || !run.executor) return send(res, 409, { error: 'not running' });
    run.executor.cancel();
    send(res, 200, { ok: true });
  }

  function handleStatus(res, appId, buttonId) {
    const app = store.getApp(appId);
    if (!app) return notFound(res);
    const button = store.getButton(appId, buttonId);
    if (!button) return notFound(res);
    const run = runs[`${appId}/${buttonId}`];
    send(res, 200, {
      state: run?.state ?? 'idle',
      startedAt: run?.startedAt ?? null,
      lastResult: run?.lastResult
        ? { exitCode: run.lastResult.exitCode, success: run.lastResult.success, killed: run.lastResult.killed, finishedAt: run.lastResult.finishedAt }
        : null,
    });
  }

  function handleLogs(res, appId, buttonId) {
    const app = store.getApp(appId);
    if (!app) return notFound(res);
    const button = store.getButton(appId, buttonId);
    if (!button) return notFound(res);
    send(res, 200, store.listHistory(appId, buttonId));
  }

  async function serveStatic(url, res) {
    let pathname = url.pathname;
    if (pathname === '/') pathname = '/index.html';
    if (!publicDir) return notFound(res);
    const filePath = normalize(join(publicDir, pathname));
    if (!filePath.startsWith(normalize(publicDir))) return notFound(res);
    try {
      const content = await readFile(filePath);
      res.writeHead(200, { 'Content-Type': MIME[extname(filePath)] ?? 'application/octet-stream' });
      res.end(content);
    } catch {
      notFound(res);
    }
  }

  function stopManaged(appId, buttonId) {
    const key = `${appId}/${buttonId}`;
    const run = runs[key];
    if (run?.executor) {
      run.executor.cancel();
      delete runs[key];
    }
  }

  return server;
}

const isMain = process.argv[1] && fileURLToPath(`file://${process.argv[1]}`) === fileURLToPath(import.meta.url);

if (isMain) {
  const dataDir = process.env.APP_DECK_DATA_DIR ?? DEFAULT_DATA_DIR;
  const store = await new Store({ dataDir }).init();
  const server = createServer({ store });
  server.listen(DEFAULT_PORT, () => {
    console.log(`[app-deck] listening on http://localhost:${DEFAULT_PORT}`);
  });
}
