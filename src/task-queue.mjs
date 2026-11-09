import { throwIfAborted, sleep } from './async.mjs';

export class TaskQueue {
  constructor({ concurrency = 4, logger = console, onStatus = async () => {} } = {}) {
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 256) throw new RangeError('Concurrency must be between 1 and 256.');
    this.concurrency = concurrency;
    this.logger = logger;
    this.onStatus = onStatus;
    this.results = new Map();
    this.#cancelled = false;
  }

  #cancelled;
  #running = new Set();

  get activeCount() { return this.#running.size; }
  get isCancelled() { return this.#cancelled; }

  cancel(reason = 'cancelled') {
    this.#cancelled = true;
    this.cancelReason = reason;
  }

  async run(rawTasks, worker, options = {}) {
    const tasks = rawTasks.map((task) => ({ ...task }));
    const taskById = new Map(tasks.map((task) => [task.id, task]));
    if (taskById.size !== tasks.length) throw new Error('Task queue requires unique task IDs.');
    const status = new Map(tasks.map((task) => [task.id, task.status === 'completed' ? 'completed' : 'pending']));
    for (const task of tasks) {
      for (const dependency of task.dependsOn ?? []) {
        if (!taskById.has(dependency)) throw new Error(`Unknown task dependency: ${dependency}`);
      }
    }
    const maxRetries = Math.max(0, Number(options.maxRetries ?? 0));
    let completedCount = [...status.values()].filter((value) => value === 'completed').length;
    const setStatus = async (task, nextStatus, detail = {}) => {
      status.set(task.id, nextStatus);
      await this.onStatus(task, nextStatus, detail);
      this.logger.info?.(`Task ${nextStatus}.`, { taskId: task.id, title: task.title, ...detail });
    };

    const pickReady = () => {
      const ready = tasks.filter((task) => status.get(task.id) === 'pending' && (task.dependsOn ?? []).every((dependency) => status.get(dependency) === 'completed'));
      ready.sort((a, b) => (a.priority ?? 5) - (b.priority ?? 5) || a.id.localeCompare(b.id));
      return ready[0] ?? null;
    };

    const propagateBlocked = async () => {
      let changed = true;
      while (changed) {
        changed = false;
        for (const task of tasks) {
          if (status.get(task.id) !== 'pending') continue;
          const failedDependency = (task.dependsOn ?? []).find((dependency) => ['failed', 'blocked', 'cancelled'].includes(status.get(dependency)));
          if (failedDependency) {
            await setStatus(task, 'blocked', { reason: `Dependency ${failedDependency} did not complete.` });
            changed = true;
          }
        }
      }
    };

    const runOne = async (task, workerIndex) => {
      this.#running.add(task.id);
      let lastError;
      try {
        for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
          if (this.#cancelled) { await setStatus(task, 'cancelled', { reason: this.cancelReason }); return; }
          await setStatus(task, 'running', { attempt: attempt + 1, worker: workerIndex });
          try {
            const result = await worker(task, { attempt, workerIndex, queue: this });
            this.results.set(task.id, { status: 'completed', result, attempts: attempt + 1 });
            await setStatus(task, 'completed', { attempt: attempt + 1 });
            completedCount += 1;
            return;
          } catch (error) {
            lastError = error;
            const canRetry = attempt < maxRetries && (options.shouldRetry ? options.shouldRetry(error, task, attempt) : true);
            if (canRetry) {
              const backoff = Math.min((options.retryDelayMs ?? 800) * (2 ** attempt), options.maxRetryDelayMs ?? 15_000);
              await setStatus(task, 'retrying', { attempt: attempt + 1, nextDelayMs: backoff, message: error.message });
              await sleep(backoff, options.signal);
              continue;
            }
            this.results.set(task.id, { status: 'failed', error: serializeError(error), attempts: attempt + 1 });
            await setStatus(task, 'failed', { attempt: attempt + 1, message: error.message });
            return;
          }
        }
      } finally {
        this.#running.delete(task.id);
      }
      if (lastError) this.logger.error?.('Task worker exited with an error.', { taskId: task.id, message: lastError.message });
    };

    const workers = Array.from({ length: Math.min(this.concurrency, tasks.length) }, async (_, workerIndex) => {
      while (!this.#cancelled) {
        throwIfAborted(options.signal);
        await propagateBlocked();
        const task = pickReady();
        if (task) {
          await runOne(task, workerIndex + 1);
          continue;
        }
        const pending = [...status.values()].some((value) => value === 'pending' || value === 'running' || value === 'retrying');
        if (!pending) return;
        if (this.#running.size > 0) { await sleep(20, options.signal); continue; }
        const unresolved = tasks.filter((item) => status.get(item.id) === 'pending');
        if (unresolved.length) {
          for (const item of unresolved) await setStatus(item, 'blocked', { reason: 'No dependency-ready task remains.' });
        }
        return;
      }
    });

    await Promise.all(workers);
    if (this.#cancelled) {
      for (const task of tasks) if (status.get(task.id) === 'pending') await setStatus(task, 'cancelled', { reason: this.cancelReason });
    }
    const summary = summarizeQueue(status, completedCount, tasks.length, this.results);
    await options.onComplete?.(summary);
    return summary;
  }
}

export function summarizeQueue(statusMap, completedCount, totalCount, results = new Map()) {
  const counts = { completed: 0, failed: 0, blocked: 0, cancelled: 0, pending: 0, running: 0, retrying: 0 };
  for (const state of statusMap.values()) counts[state] = (counts[state] ?? 0) + 1;
  return {
    total: totalCount,
    completed: counts.completed || completedCount,
    failed: counts.failed,
    blocked: counts.blocked,
    cancelled: counts.cancelled,
    unfinished: counts.pending + counts.running + counts.retrying,
    results: Object.fromEntries(results),
  };
}

function serializeError(error) {
  return { name: error?.name ?? 'Error', code: error?.code ?? 'ERROR', message: String(error?.message ?? error).slice(0, 1_000) };
}
