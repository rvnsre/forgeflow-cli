import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { redactDeep } from './text-budget.mjs';

const LEVELS = Object.freeze({ debug: 10, info: 20, warn: 30, error: 40, silent: Infinity });

export class Logger {
  constructor({ level = 'info', file = null, quiet = false } = {}) {
    this.level = LEVELS[level] ?? LEVELS.info;
    this.file = file;
    this.quiet = quiet;
    this.tail = [];
  }

  debug(message, meta) { this.#write('debug', message, meta); }
  info(message, meta) { this.#write('info', message, meta); }
  warn(message, meta) { this.#write('warn', message, meta); }
  error(message, meta) { this.#write('error', message, meta); }

  child(bindings = {}) {
    const parent = this;
    const child = {};
    for (const level of ['debug', 'info', 'warn', 'error']) {
      child[level] = (message, meta = {}) => parent[level](message, { ...bindings, ...meta });
    }
    child.child = (more) => parent.child({ ...bindings, ...more });
    return child;
  }

  recent(limit = 50) { return this.tail.slice(-limit); }

  #write(level, message, meta) {
    if ((LEVELS[level] ?? LEVELS.info) < this.level) return;
    const event = {
      time: new Date().toISOString(),
      level,
      message: String(message),
      ...(meta && Object.keys(meta).length ? { meta: redactDeep(meta) } : {}),
    };
    this.tail.push(event);
    if (this.tail.length > 500) this.tail.splice(0, this.tail.length - 500);
    const line = `${event.time} ${level.toUpperCase()} ${event.message}${event.meta ? ` ${JSON.stringify(event.meta)}` : ''}`;
    if (!this.quiet) {
      const stream = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
      stream.write(`${line}\n`);
    }
    if (this.file) this.#append(event).catch((error) => {
      process.stderr.write(`ForgeFlow: could not append log file: ${error.message}\n`);
    });
  }

  async #append(event) {
    await mkdir(dirname(this.file), { recursive: true });
    await appendFile(this.file, `${JSON.stringify(event)}\n`, { encoding: 'utf8', mode: 0o600 });
  }
}

export function createRunLogger(root, runId, options = {}) {
  return new Logger({ ...options, file: `${root}/.forgeflow/runs/${runId}/events.jsonl` });
}
