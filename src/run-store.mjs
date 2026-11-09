import { mkdir, readFile, rename, writeFile, appendFile, readdir, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { redactSecrets, redactValuesDeep } from './text-budget.mjs';

const CURRENT_SCHEMA = 1;

export function createRunId(now = new Date()) {
  const stamp = now.toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  return `${stamp}-${randomUUID().slice(0, 8)}`;
}

export class RunStore {
  constructor(projectRoot, runId) {
    if (typeof runId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(runId)) {
      throw new Error('Run ID must contain only letters, numbers, underscores and hyphens (1-128 characters).');
    }
    this.projectRoot = resolve(projectRoot);
    this.runId = runId;
    this.root = join(this.projectRoot, '.forgeflow', 'runs', runId);
    this.statePath = join(this.root, 'state.json');
    this.mutex = Promise.resolve();
  }

  async initialize(initialState) {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const existing = await this.readState().catch((error) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (existing) return existing;
    const state = {
      schema: CURRENT_SCHEMA,
      runId: this.runId,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      status: 'planned',
      ...initialState,
    };
    await this.writeState(state);
    return state;
  }

  async readState() {
    const data = JSON.parse(await readFile(this.statePath, 'utf8'));
    if (!data || typeof data !== 'object') throw new Error(`Run ${this.runId} state is malformed.`);
    if (data.schema !== CURRENT_SCHEMA) throw new Error(`Unsupported state schema ${data.schema}.`);
    return data;
  }

  async writeState(nextState) {
    return this.#serialize(async () => {
      const state = redactValuesDeep({
        ...nextState,
        schema: CURRENT_SCHEMA,
        runId: this.runId,
        updatedAt: new Date().toISOString(),
      });
      await this.#atomicWrite(this.statePath, `${JSON.stringify(state, null, 2)}\n`);
      return state;
    });
  }

  async updateState(updater) {
    return this.#serialize(async () => {
      const current = await this.readState();
      const updated = await updater(current);
      const state = redactValuesDeep({
        ...updated,
        schema: CURRENT_SCHEMA,
        runId: this.runId,
        updatedAt: new Date().toISOString(),
      });
      await this.#atomicWrite(this.statePath, `${JSON.stringify(state, null, 2)}\n`);
      return state;
    });
  }

  async appendJournal(record) {
    const path = join(this.root, 'journal.jsonl');
    const safe = redactValuesDeep({
      time: new Date().toISOString(),
      ...record,
    });
    await appendFile(path, `${JSON.stringify(safe)}\n`, { encoding: 'utf8', mode: 0o600 });
  }

  async readJournal({ limit = 200, taskId } = {}) {
    const path = join(this.root, 'journal.jsonl');
    const text = await readFile(path, 'utf8').catch(() => '');
    const entries = [];
    for (const line of text.split(/\r?\n/).filter(Boolean).slice(-Math.max(limit * 5, limit))) {
      try {
        const entry = JSON.parse(line);
        if (!taskId || entry.taskId === taskId) entries.push(entry);
      } catch { /* Ignore a truncated final journal line. */ }
    }
    return entries.slice(-limit);
  }

  async listArtifacts() {
    const base = join(this.root, 'artifacts');
    const names = await readdir(base).catch(() => []);
    const output = [];
    for (const name of names) {
      const path = join(base, name);
      const info = await stat(path).catch(() => null);
      if (info?.isFile()) output.push({ name, size: info.size });
    }
    return output;
  }

  async saveArtifact(name, content) {
    const safeName = String(name).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120);
    if (!safeName || safeName === '.' || safeName === '..') throw new Error('Artifact name is invalid.');
    const dir = join(this.root, 'artifacts');
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const path = join(dir, safeName);
    await this.#atomicWrite(path, content);
    return path;
  }

  static async list(projectRoot) {
    const base = join(resolve(projectRoot), '.forgeflow', 'runs');
    const names = await readdir(base).catch(() => []);
    const runs = [];
    for (const runId of names) {
      try {
        const store = new RunStore(projectRoot, runId);
        const state = await store.readState();
        runs.push({ runId, status: state.status, createdAt: state.createdAt, updatedAt: state.updatedAt, summary: state.summary });
      } catch { /* Ignore half-written or outdated run state. */ }
    }
    return runs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async #atomicWrite(path, content) {
    await mkdir(dirname(path), { recursive: true });
    const temp = `${path}.${randomUUID()}.tmp`;
    await writeFile(temp, content, { encoding: typeof content === 'string' ? 'utf8' : undefined, mode: 0o600 });
    await rename(temp, path);
  }

  async #serialize(operation) {
    const previous = this.mutex;
    let release;
    this.mutex = new Promise((resolvePromise) => { release = resolvePromise; });
    await previous;
    try { return await operation(); }
    finally { release(); }
  }
}

export function makeInitialRunState({ prompt, model, maxWorkers, maxSteps, maxCalls }) {
  return {
    prompt: redactSecrets(prompt),
    model,
    status: 'planning',
    summary: '',
    tasks: [],
    metrics: {
      workers: maxWorkers,
      maxSteps,
      maxCalls,
      apiCalls: 0,
      promptTokens: 0,
      completionTokens: 0,
      toolCalls: 0,
    },
    errors: [],
  };
}
