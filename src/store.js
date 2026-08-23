import { readFile, writeFile, mkdir, rename, copyFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';

const HISTORY_LIMIT = 50;

async function atomicWrite(file, data) {
  const tmp = `${file}.tmp`;
  await writeFile(tmp, data);
  try {
    await rename(tmp, file);
  } catch (e) {
    if (e.code !== 'EXDEV') throw e;
    await copyFile(tmp, file);
    await unlink(tmp);
  }
}

export class Store {
  constructor({ dataDir }) {
    this.dataDir = dataDir;
    this.file = join(dataDir, 'apps.json');
    this.historyFile = join(dataDir, 'history.json');
    this.apps = [];
    this.history = {};
  }

  async init() {
    await mkdir(this.dataDir, { recursive: true });
    try {
      this.apps = JSON.parse(await readFile(this.file, 'utf8')).apps;
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
      this.apps = [];
      await this.save();
    }
    try {
      this.history = JSON.parse(await readFile(this.historyFile, 'utf8'));
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
      this.history = {};
      await this.saveHistory();
    }
    return this;
  }

  async save() {
    await atomicWrite(this.file, JSON.stringify({ apps: this.apps }, null, 2));
  }

  async saveHistory() {
    await atomicWrite(this.historyFile, JSON.stringify(this.history));
  }

  listApps() {
    return structuredClone(this.apps);
  }

  getApp(appId) {
    return structuredClone(this.apps.find((a) => a.id === appId) ?? null);
  }

  upsertApp(app) {
    const idx = this.apps.findIndex((a) => a.id === app.id);
    if (idx === -1) this.apps.push(app);
    else this.apps[idx] = app;
  }

  deleteApp(appId) {
    this.apps = this.apps.filter((a) => a.id !== appId);
  }

  getButton(appId, buttonId) {
    const app = this.apps.find((a) => a.id === appId);
    if (!app) return null;
    return structuredClone(app.buttons.find((b) => b.id === buttonId) ?? null);
  }

  upsertButton(appId, button) {
    const app = this.apps.find((a) => a.id === appId);
    if (!app) throw new Error('app not found');
    const idx = app.buttons.findIndex((b) => b.id === button.id);
    if (idx === -1) app.buttons.push(button);
    else app.buttons[idx] = button;
  }

  deleteButton(appId, buttonId) {
    const app = this.apps.find((a) => a.id === appId);
    if (!app) throw new Error('app not found');
    app.buttons = app.buttons.filter((b) => b.id !== buttonId);
  }

  addHistory(appId, buttonId, entry) {
    const key = `${appId}/${buttonId}`;
    if (!this.history[key]) this.history[key] = [];
    this.history[key].push(entry);
    if (this.history[key].length > HISTORY_LIMIT) {
      this.history[key] = this.history[key].slice(-HISTORY_LIMIT);
    }
  }

  listHistory(appId, buttonId) {
    return structuredClone((this.history[`${appId}/${buttonId}`] ?? []).slice().reverse());
  }

  deleteHistory(appId, buttonId) {
    delete this.history[`${appId}/${buttonId}`];
  }

  deleteAppHistory(appId) {
    for (const k of Object.keys(this.history)) {
      if (k.startsWith(`${appId}/`)) {
        delete this.history[k];
      }
    }
  }

  deleteHistoryEntry(appId, buttonId, entryId) {
    const key = `${appId}/${buttonId}`;
    if (!this.history[key]) return false;
    const initialLen = this.history[key].length;
    this.history[key] = this.history[key].filter((e) => e.id !== entryId);
    return this.history[key].length < initialLen;
  }
}

export { HISTORY_LIMIT };
