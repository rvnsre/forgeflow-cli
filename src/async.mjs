import { InterruptedError } from './errors.mjs';

export function abortReason(signal) {
  if (!signal?.aborted) return null;
  return signal.reason instanceof Error ? signal.reason : new InterruptedError();
}

export function throwIfAborted(signal) {
  const reason = abortReason(signal);
  if (reason) throw reason;
}

export function sleep(ms, signal) {
  const duration = Math.max(0, ms);
  if (!signal) return new Promise((resolve) => setTimeout(resolve, duration));
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, duration);
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      reject(abortReason(signal));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export function withTimeout(operation, timeoutMs, signal, label = 'Operation') {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return operation(signal);
  const controller = new AbortController();
  const relayAbort = () => controller.abort(abortReason(signal));
  if (signal?.aborted) relayAbort();
  else signal?.addEventListener('abort', relayAbort, { once: true });

  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`${label} timed out after ${timeoutMs} ms.`);
      error.code = 'TIMEOUT';
      controller.abort(error);
      reject(error);
    }, timeoutMs);
  });

  return Promise.race([operation(controller.signal), timeout])
    .finally(() => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', relayAbort);
    });
}

export class Semaphore {
  #active = 0;
  #queue = [];

  constructor(limit) {
    if (!Number.isInteger(limit) || limit < 1) throw new RangeError('Semaphore limit must be a positive integer.');
    this.limit = limit;
  }

  get active() { return this.#active; }
  get pending() { return this.#queue.length; }

  async acquire(signal) {
    throwIfAborted(signal);
    if (this.#active < this.limit) {
      this.#active += 1;
      return this.#releaseOnce();
    }
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, signal, onAbort: null, settled: false };
      waiter.onAbort = () => {
        if (waiter.settled) return;
        waiter.settled = true;
        this.#queue = this.#queue.filter((entry) => entry !== waiter);
        reject(signal.reason instanceof Error ? signal.reason : new Error('Aborted while waiting for a slot.'));
      };
      signal?.addEventListener('abort', waiter.onAbort, { once: true });
      this.#queue.push(waiter);
    });
  }

  async run(operation, signal) {
    const release = await this.acquire(signal);
    try { return await operation(); }
    finally { release(); }
  }

  #releaseOnce() {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#active -= 1;
      this.#drain();
    };
  }

  #drain() {
    while (this.#active < this.limit && this.#queue.length) {
      const waiter = this.#queue.shift();
      if (waiter.settled) continue;
      waiter.settled = true;
      waiter.signal?.removeEventListener('abort', waiter.onAbort);
      this.#active += 1;
      waiter.resolve(this.#releaseOnce());
    }
  }
}

export class RateLimiter {
  #nextAt = 0;
  #mutex = new Semaphore(1);

  constructor({ requestsPerMinute = 60, burst = 1 } = {}) {
    this.intervalMs = requestsPerMinute > 0 ? 60_000 / requestsPerMinute : 0;
    this.burst = Math.max(1, burst);
    this.#nextAt = Date.now() - (this.burst - 1) * this.intervalMs;
  }

  async wait(signal) {
    await this.#mutex.run(async () => {
      const now = Date.now();
      const slot = Math.max(now, this.#nextAt);
      this.#nextAt = slot + this.intervalMs;
      if (slot > now) await sleep(slot - now, signal);
    }, signal);
  }
}

export async function mapLimit(items, limit, mapper, signal) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      throwIfAborted(signal);
      const index = nextIndex++;
      if (index >= items.length) return;
      results[index] = await mapper(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}
