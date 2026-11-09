import { ProviderError, BudgetExceededError } from './errors.mjs';
import { RateLimiter, sleep, throwIfAborted, withTimeout } from './async.mjs';
import { redactSecrets } from './text-budget.mjs';
import { UsageBudget } from './usage-budget.mjs';

const MAX_RETRIES = 5;
const MAX_ERROR_CHARS = 1_200;

export class Provider {
  #nextKey = 0;
  #cooldowns = new Map();
  #calls = 0;
  #promptTokens = 0;
  #completionTokens = 0;
  #rateLimiter;
  #usageBudget;

  constructor(config, limits = {}) {
    this.config = config;
    this.maxCalls = Number(typeof limits === 'number' ? limits : limits.maxCalls ?? 1_000);
    this.timeoutMs = Number(limits.timeoutMs ?? 90_000);
    this.maxOutputTokens = Number(limits.maxOutputTokens ?? 4_000);
    this.#usageBudget = new UsageBudget({ maxTotalTokens: Number(limits.maxTotalTokens ?? 2_000_000) });
    this.#rateLimiter = new RateLimiter({
      requestsPerMinute: Number(limits.requestsPerMinute ?? 60),
      burst: Number(limits.burst ?? 2),
    });
  }

  get calls() { return this.#calls; }
  get promptTokens() { return this.#promptTokens; }
  get completionTokens() { return this.#completionTokens; }
  get metrics() {
    return { calls: this.#calls, promptTokens: this.#promptTokens, completionTokens: this.#completionTokens, tokenBudget: this.#usageBudget.snapshot() };
  }

  async chat(messages, tools, signal, options = {}) {
    throwIfAborted(signal);
    const maxOutputTokens = Number(options.maxOutputTokens ?? this.maxOutputTokens);
    const reservation = this.#usageBudget.reserve({ messages: { messages, tools }, maxOutputTokens });
    let settled = false;
    try {
      let key = await this.#selectKey(signal);
      let delay = 1_000;
      const rejectedKeys = new Set();
      let lastError;

      for (let attempt = 0; attempt < MAX_RETRIES; attempt += 1) {
      throwIfAborted(signal);
      await this.#rateLimiter.wait(signal);
      if (this.#calls >= this.maxCalls) throw new BudgetExceededError('API calls', this.maxCalls);
      this.#calls += 1;
      const body = this.#makeBody(messages, tools, { ...options, maxOutputTokens: reservation.maxOutputTokens });
      let response;
      try {
        response = await withTimeout(
          (requestSignal) => fetch(`${this.config.baseUrl}/chat/completions`, {
            method: 'POST',
            signal: requestSignal,
            headers: {
              'content-type': 'application/json',
              authorization: `Bearer ${key}`,
              ...(this.config.organization ? { 'OpenAI-Organization': this.config.organization } : {}),
              ...(this.config.project ? { 'OpenAI-Project': this.config.project } : {}),
            },
            body: JSON.stringify(body),
          }),
          this.timeoutMs,
          signal,
          'Provider request',
        );
      } catch (error) {
        if (signal?.aborted) throw signal.reason ?? error;
        const retryable = error.code === 'TIMEOUT' || error.cause?.code === 'ECONNRESET' || error.cause?.code === 'ETIMEDOUT';
        lastError = new ProviderError(`API request failed: ${redactSecrets(error.message)}`, { retryable, cause: error });
        if (!retryable || attempt === MAX_RETRIES - 1) throw lastError;
        await sleep(delay, signal);
        delay = Math.min(delay * 2, 30_000);
        continue;
      }

      if (response.ok) {
        let payload;
        try { payload = await response.json(); }
        catch (error) { throw new ProviderError('API returned malformed JSON.', { cause: error }); }
        this.#recordUsage(payload?.usage);
        const promptTokens = payload?.usage?.prompt_tokens ?? payload?.usage?.input_tokens ?? reservation.inputEstimate;
        const completionTokens = payload?.usage?.completion_tokens ?? payload?.usage?.output_tokens ?? reservation.maxOutputTokens;
        reservation.commit({ promptTokens, completionTokens });
        settled = true;
        if (!payload?.choices?.[0]?.message) throw new ProviderError('API response did not include a choice message.');
        return payload;
      }

      const requestId = response.headers.get('x-request-id') ?? response.headers.get('request-id');
      const detail = redactSecrets((await response.text().catch(() => '')).slice(0, MAX_ERROR_CHARS));
      const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'));
      if (response.status === 401 || response.status === 403) {
        this.#cooldowns.set(key, Date.now() + 60_000);
        rejectedKeys.add(key);
        this.#nextKey = (this.config.keys.indexOf(key) + 1) % this.config.keys.length;
        if (attempt < MAX_RETRIES - 1) {
          try { key = await this.#selectKey(signal, rejectedKeys); continue; }
          catch (error) { lastError = error; break; }
        }
      }

      const retryable = response.status === 429 || response.status >= 500;
      lastError = new ProviderError(`API returned ${response.status}${detail ? `: ${detail}` : ''}`, {
        status: response.status,
        requestId,
        retryable,
        retryAfterMs,
      });
      if (response.status === 429 && retryAfterMs !== null && retryAfterMs > 120_000) {
        throw new ProviderError(`Provider requested a ${Math.ceil(retryAfterMs / 1_000)} second retry delay. Stop and resume later to honor that limit.`, {
          status: response.status,
          requestId,
          retryable: true,
          retryAfterMs,
        });
      }
      if (!retryable || attempt === MAX_RETRIES - 1) throw lastError;

      // Retry the same key after a 429. Do not use a key pool to evade provider limits.
      const waitMs = response.status === 429 && retryAfterMs !== null
        ? retryAfterMs
        : delay;
      this.#cooldowns.set(key, Date.now() + waitMs);
      await sleep(waitMs, signal);
      delay = Math.min(delay * 2, 30_000);
      }
      throw lastError ?? new ProviderError('Provider retry limit reached.');
    } finally {
      if (!settled) reservation.release();
    }
  }

  #makeBody(messages, tools, options) {
    const body = {
      model: this.config.model,
      messages,
      ...(tools?.length ? { tools, tool_choice: 'auto' } : {}),
      ...(this.config.temperature !== undefined ? { temperature: this.config.temperature } : {}),
      ...(options.maxOutputTokens ?? this.maxOutputTokens
        ? { [this.config.tokenLimitParameter ?? 'max_completion_tokens']: options.maxOutputTokens ?? this.maxOutputTokens }
        : {}),
      ...(options.responseFormat ? { response_format: options.responseFormat } : {}),
    };
    if (options.seed !== undefined) body.seed = options.seed;
    return body;
  }

  #recordUsage(usage) {
    if (!usage || typeof usage !== 'object') return;
    const prompt = Number(usage.prompt_tokens ?? usage.input_tokens ?? 0);
    const completion = Number(usage.completion_tokens ?? usage.output_tokens ?? 0);
    if (Number.isFinite(prompt) && prompt > 0) this.#promptTokens += prompt;
    if (Number.isFinite(completion) && completion > 0) this.#completionTokens += completion;
  }

  async #selectKey(signal, rejected = new Set()) {
    while (true) {
      throwIfAborted(signal);
      const now = Date.now();
      const candidates = this.config.keys.filter((candidate) => !rejected.has(candidate));
      if (!candidates.length) throw new ProviderError('All configured API keys failed authentication.', { status: 401 });
      for (let offset = 0; offset < this.config.keys.length; offset += 1) {
        const index = (this.#nextKey + offset) % this.config.keys.length;
        const key = this.config.keys[index];
        if (!rejected.has(key) && (this.#cooldowns.get(key) ?? 0) <= now) return key;
      }
      const earliest = Math.min(...candidates.map((candidate) => this.#cooldowns.get(candidate) ?? now));
      await sleep(Math.max(100, Math.min(earliest - now, 30_000)), signal);
    }
  }
}

function parseRetryAfter(value) {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1_000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : null;
}
