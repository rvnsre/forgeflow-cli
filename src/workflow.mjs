import { createHash } from 'node:crypto';
import { normalizeError } from './errors.mjs';

const PHASES = Object.freeze(['created', 'planning', 'planned', 'coding', 'reviewing', 'paused', 'completed', 'failed']);
const TRANSITIONS = Object.freeze({
  created: new Set(['planning', 'failed']),
  planning: new Set(['planned', 'coding', 'paused', 'failed']),
  planned: new Set(['coding', 'paused', 'failed']),
  coding: new Set(['reviewing', 'paused', 'completed', 'failed']),
  reviewing: new Set(['coding', 'completed', 'paused', 'failed']),
  paused: new Set(['planning', 'planned', 'coding', 'reviewing', 'failed']),
  failed: new Set(['planning', 'coding']),
  completed: new Set(),
});

export class WorkflowTracker {
  #phase = 'created';
  #events = [];
  #tasks = new Map();
  #startedAt = Date.now();
  #phaseStartedAt = Date.now();
  #sequence = 0;

  constructor({ runId, onEvent = async () => {}, maxEvents = 2_000 } = {}) {
    this.runId = runId;
    this.onEvent = onEvent;
    this.maxEvents = Math.max(50, maxEvents);
  }

  get phase() { return this.#phase; }
  get elapsedMs() { return Date.now() - this.#startedAt; }
  get taskCount() { return this.#tasks.size; }

  async transition(nextPhase, metadata = {}) {
    if (!PHASES.includes(nextPhase)) throw new Error(`Unknown workflow phase: ${nextPhase}`);
    if (nextPhase === this.#phase) return this.snapshot();
    if (!TRANSITIONS[this.#phase].has(nextPhase)) throw new Error(`Invalid workflow transition: ${this.#phase} -> ${nextPhase}`);
    const now = Date.now();
    const event = this.#event('phase', {
      from: this.#phase,
      to: nextPhase,
      phaseDurationMs: now - this.#phaseStartedAt,
      ...metadata,
    });
    this.#phase = nextPhase;
    this.#phaseStartedAt = now;
    await this.#emit(event);
    return this.snapshot();
  }

  async seedTasks(tasks) {
    this.#tasks.clear();
    for (const task of tasks) {
      this.#tasks.set(task.id, {
        id: task.id,
        title: task.title,
        status: task.status ?? 'pending',
        attempts: task.attempts ?? 0,
        steps: task.steps ?? 0,
        startedAt: null,
        completedAt: null,
        errorCode: null,
      });
    }
    await this.#emit(this.#event('tasks_seeded', { total: this.#tasks.size }));
  }

  async taskStatus(taskId, status, details = {}) {
    const task = this.#tasks.get(taskId);
    if (!task) throw new Error(`Workflow does not contain task ${taskId}.`);
    const previous = task.status;
    task.status = status;
    if (details.attempt) task.attempts = Math.max(task.attempts, details.attempt);
    if (details.steps) task.steps = Math.max(task.steps, details.steps);
    if (status === 'running' && !task.startedAt) task.startedAt = new Date().toISOString();
    if (['completed', 'failed', 'blocked', 'cancelled'].includes(status)) task.completedAt = new Date().toISOString();
    if (details.code) task.errorCode = details.code;
    if (previous !== status) await this.#emit(this.#event('task_status', {
      taskId,
      from: previous,
      to: status,
      ...(details.attempt ? { attempt: details.attempt } : {}),
      ...(details.worker ? { worker: details.worker } : {}),
      ...(details.code ? { code: details.code } : {}),
    }));
    return { ...task };
  }

  async recordTool(taskId, toolName, durationMs, outcome = 'ok') {
    await this.#emit(this.#event('tool', {
      taskId,
      tool: toolName,
      outcome,
      durationMs: Math.max(0, Math.floor(durationMs)),
    }));
  }

  async recordModelTurn(taskId, { step, inputTokens, outputTokens, durationMs }) {
    const task = this.#tasks.get(taskId);
    if (task) task.steps = Math.max(task.steps, step ?? 0);
    await this.#emit(this.#event('model_turn', {
      taskId,
      step,
      inputTokens: Math.max(0, Math.floor(inputTokens ?? 0)),
      outputTokens: Math.max(0, Math.floor(outputTokens ?? 0)),
      durationMs: Math.max(0, Math.floor(durationMs ?? 0)),
    }));
  }

  async recordError(error, context = {}) {
    const normalized = normalizeError(error);
    await this.#emit(this.#event('error', {
      code: normalized.code ?? normalized.name,
      message: normalized.message.slice(0, 700),
      ...context,
    }));
  }

  snapshot() {
    const counts = { pending: 0, running: 0, retrying: 0, completed: 0, failed: 0, blocked: 0, cancelled: 0 };
    let attempts = 0;
    let steps = 0;
    for (const task of this.#tasks.values()) {
      counts[task.status] = (counts[task.status] ?? 0) + 1;
      attempts += task.attempts;
      steps += task.steps;
    }
    return {
      runId: this.runId,
      phase: this.#phase,
      elapsedMs: this.elapsedMs,
      taskCount: this.#tasks.size,
      counts,
      attempts,
      steps,
      progress: this.#tasks.size ? counts.completed / this.#tasks.size : 0,
      tasks: [...this.#tasks.values()].map((task) => ({ ...task })),
      recentEvents: this.#events.slice(-25),
    };
  }

  recentEvents(limit = 100) {
    return this.#events.slice(-Math.max(0, Math.floor(limit)));
  }

  async #emit(event) {
    this.#events.push(event);
    if (this.#events.length > this.maxEvents) this.#events.splice(0, this.#events.length - this.maxEvents);
    await this.onEvent(event);
  }

  #event(type, details) {
    return {
      sequence: ++this.#sequence,
      runId: this.runId,
      type,
      phase: this.#phase,
      at: new Date().toISOString(),
      ...details,
    };
  }
}

export class AutomationCheckpoint {
  constructor({ runId, phase, planHash, taskStates, cursor, timestamp = new Date().toISOString() }) {
    this.version = 1;
    this.runId = runId;
    this.phase = phase;
    this.planHash = planHash ?? null;
    this.taskStates = taskStates ?? {};
    this.cursor = cursor ?? null;
    this.timestamp = timestamp;
    this.checksum = checkpointChecksum(this);
  }

  validate({ runId, planHash } = {}) {
    if (this.version !== 1) throw new Error(`Unsupported checkpoint version ${this.version}.`);
    if (runId && this.runId !== runId) throw new Error('Checkpoint run ID does not match.');
    if (planHash && this.planHash && this.planHash !== planHash) throw new Error('Checkpoint plan has changed. Create a new run instead of resuming this one.');
    if (this.checksum !== checkpointChecksum(this)) throw new Error('Checkpoint checksum is invalid.');
    return true;
  }

  toJSON() {
    return {
      version: this.version,
      runId: this.runId,
      phase: this.phase,
      planHash: this.planHash,
      taskStates: this.taskStates,
      cursor: this.cursor,
      timestamp: this.timestamp,
      checksum: this.checksum,
    };
  }

  static from(value) {
    if (!value || typeof value !== 'object') throw new Error('Checkpoint must be an object.');
    const checkpoint = Object.assign(Object.create(AutomationCheckpoint.prototype), value);
    checkpoint.validate();
    return checkpoint;
  }
}

export function checkpointChecksum(value) {
  const stable = {
    version: value.version,
    runId: value.runId,
    phase: value.phase,
    planHash: value.planHash ?? null,
    taskStates: value.taskStates ?? {},
    cursor: value.cursor ?? null,
    timestamp: value.timestamp,
  };
  return createHash('sha256').update(stableStringify(stable)).digest('hex');
}

export function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (!value || typeof value !== 'object') return JSON.stringify(value);
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

export function transitionAllowed(from, to) {
  return Boolean(TRANSITIONS[from]?.has(to));
}

export function listWorkflowPhases() { return [...PHASES]; }
