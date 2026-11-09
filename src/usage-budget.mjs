import { BudgetExceededError } from './errors.mjs';
import { estimateTokens } from './text-budget.mjs';

export class UsageBudget {
  #committedInput = 0;
  #committedOutput = 0;
  #reserved = new Map();
  #sequence = 0;

  constructor({ maxTotalTokens = 2_000_000, safetyFactor = 1.25 } = {}) {
    if (!Number.isInteger(maxTotalTokens) || maxTotalTokens < 1) throw new RangeError('maxTotalTokens must be a positive integer.');
    this.maxTotalTokens = maxTotalTokens;
    this.safetyFactor = Math.max(1, Number(safetyFactor) || 1.25);
  }

  get reservedTokens() {
    let total = 0;
    for (const reservation of this.#reserved.values()) total += reservation.input + reservation.output;
    return total;
  }

  get spentTokens() { return this.#committedInput + this.#committedOutput; }
  get remainingTokens() { return Math.max(0, this.maxTotalTokens - this.spentTokens - this.reservedTokens); }

  reserve({ messages, maxOutputTokens, requestId = null }) {
    const inputEstimate = Math.ceil(estimateTokens(messages) * this.safetyFactor);
    const requestedOutput = Math.max(1, Math.floor(maxOutputTokens));
    const available = this.remainingTokens;
    const outputLimit = Math.min(requestedOutput, available - inputEstimate);
    if (inputEstimate >= available || outputLimit < 64) throw new BudgetExceededError('Approximate total tokens', this.maxTotalTokens);
    const id = `${Date.now()}-${++this.#sequence}`;
    this.#reserved.set(id, { input: inputEstimate, output: outputLimit, requestId });
    return {
      id,
      inputEstimate,
      maxOutputTokens: outputLimit,
      reservedTokens: inputEstimate + outputLimit,
      commit: (usage) => this.commit(id, usage),
      release: () => this.release(id),
    };
  }

  commit(id, usage = {}) {
    const reservation = this.#reserved.get(id);
    if (!reservation) return false;
    this.#reserved.delete(id);
    const input = nonNegativeInt(usage.promptTokens ?? usage.input_tokens ?? reservation.input);
    const output = nonNegativeInt(usage.completionTokens ?? usage.output_tokens ?? reservation.output);
    this.#committedInput += input;
    this.#committedOutput += output;
    return true;
  }

  release(id) {
    return this.#reserved.delete(id);
  }

  snapshot() {
    return {
      maxTotalTokens: this.maxTotalTokens,
      inputTokens: this.#committedInput,
      outputTokens: this.#committedOutput,
      spentTokens: this.spentTokens,
      reservedTokens: this.reservedTokens,
      remainingTokens: this.remainingTokens,
      utilization: this.maxTotalTokens ? Math.min(1, this.spentTokens / this.maxTotalTokens) : 0,
      reachedLimit: this.remainingTokens <= 0,
    };
  }

  static estimate(messages, safetyFactor = 1.25) {
    return Math.ceil(estimateTokens(messages) * Math.max(1, Number(safetyFactor) || 1.25));
  }
}

export class RequestBudget {
  #calls = 0;
  #active = 0;

  constructor(maxCalls) {
    if (!Number.isInteger(maxCalls) || maxCalls < 1) throw new RangeError('maxCalls must be a positive integer.');
    this.maxCalls = maxCalls;
  }

  reserve() {
    if (this.#calls >= this.maxCalls) throw new BudgetExceededError('API calls', this.maxCalls);
    this.#calls += 1;
    this.#active += 1;
    let settled = false;
    return {
      callNumber: this.#calls,
      commit: () => { if (settled) return; settled = true; this.#active -= 1; },
      release: () => { if (settled) return; settled = true; this.#active -= 1; this.#calls -= 1; },
    };
  }

  get calls() { return this.#calls; }
  get activeCalls() { return this.#active; }
}

export function summarizeUsage({ provider, budget, requestBudget }) {
  return {
    calls: requestBudget?.calls ?? provider?.calls ?? 0,
    activeCalls: requestBudget?.activeCalls ?? 0,
    promptTokens: provider?.promptTokens ?? 0,
    completionTokens: provider?.completionTokens ?? 0,
    ...(budget?.snapshot?.() ?? {}),
  };
}

function nonNegativeInt(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return 0;
  return Math.floor(number);
}
