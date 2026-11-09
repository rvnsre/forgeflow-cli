import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Provider } from './provider.mjs';
import { executeTool, toolDefinitions } from './tools.mjs';
import { RunStore, createRunId, makeInitialRunState } from './run-store.mjs';
import { createRunLogger } from './logger.mjs';
import { clipToolResult, estimateTokens, truncateMessages, truncateText } from './text-budget.mjs';
import { throwIfAborted, withTimeout } from './async.mjs';
import { InterruptedError, normalizeError } from './errors.mjs';
import { buildPlannerMessages, parsePlan, validatePlan } from './planner.mjs';
import { ProjectWorkspace } from './workspace.mjs';
import { TaskQueue } from './task-queue.mjs';
import { buildOperatingRules } from './policy.mjs';
import { taskPlanHash } from './planner.mjs';
import { WorkflowTracker } from './workflow.mjs';
import { allowedToolsForProfile, filterToolDefinitions, getAgentProfile, profileBudget, profileInstructions, selectAgentProfile } from './agent-profiles.mjs';
import { assertSupportedRuntime } from './runtime.mjs';

export class Orchestrator {
  constructor({ config, root, prompt, opts, logger, browser, resume = false }) {
    this.config = config;
    this.root = resolve(root);
    this.workspace = new ProjectWorkspace(this.root);
    this.prompt = prompt;
    this.opts = opts;
    this.logger = logger;
    this.browser = browser;
    this.resume = resume;
    this.abortController = new AbortController();
    this.provider = new Provider(config, {
      maxCalls: config.maxCalls,
      timeoutMs: config.requestTimeoutMs,
      maxOutputTokens: config.maxOutputTokens,
      maxTotalTokens: config.maxTotalTokens,
      requestsPerMinute: config.requestsPerMinute,
    });
    this.store = null;
    this.workflow = null;
    this.runId = opts.runId ?? createRunId();
  }

  async execute() {
    assertSupportedRuntime();
    await mkdir(this.root, { recursive: true });
    await this.workspace.initialize();
    this.store = new RunStore(this.root, this.runId);
    this.workflow = new WorkflowTracker({
      runId: this.runId,
      onEvent: (event) => this.store.appendJournal(event),
    });
    const diskLogger = createRunLogger(this.root, this.runId, { level: 'debug', quiet: true });
    this.logger = combineLoggers(this.logger, diskLogger);
    const onInterrupt = () => {
      this.logger.warn('Interrupt received; stopping at a checkpoint.');
      this.abortController.abort(new InterruptedError());
    };
    process.once('SIGINT', onInterrupt);

    try {
      let state = this.resume ? await this.store.readState() : null;
      if (this.resume && !this.prompt) this.prompt = state.prompt;
      if (!this.prompt) throw new Error('A prompt is required for a new run.');
      state ??= await this.store.initialize(makeInitialRunState({
        prompt: this.prompt,
        model: this.config.model,
        maxWorkers: this.config.agents,
        maxSteps: this.config.maxSteps,
        maxCalls: this.config.maxCalls,
      }));
      await this.workflow.transition('planning', { resume: this.resume });
      this.logger.info(this.resume ? 'Resuming saved run.' : 'Starting run.', { runId: this.runId, root: this.root, workers: this.config.agents });

      if (!state.tasks?.length) {
        const plan = await this.#makePlan();
        state = await this.store.updateState((current) => ({
          ...current,
          status: this.opts.planOnly ? 'planned' : 'running',
          summary: plan.summary,
          planHash: plan.hash,
          tasks: plan.tasks.map((task) => ({ ...task, status: 'pending', attempts: 0, steps: 0, result: null, error: null })),
        }));
      }
      await this.workflow.seedTasks(state.tasks);
      await this.workflow.transition('planned', { taskCount: state.tasks.length });
      this.#printPlan(state);
      if (this.opts.planOnly) {
        await this.store.updateState((current) => ({ ...current, status: 'planned' }));
        return { runId: this.runId, status: 'planned', tasks: state.tasks.length };
      }

      await this.workflow.transition('coding');
      await this.store.updateState((current) => ({ ...current, status: 'running' }));
      const queueSummary = await this.#runQueue(state.tasks);
      const latest = await this.store.readState();
      const unfinished = latest.tasks.filter((task) => task.status !== 'completed');
      const status = this.abortController.signal.aborted ? 'interrupted' : unfinished.length ? 'failed' : 'completed';
      await this.workflow.transition(status === 'completed' ? 'completed' : status === 'interrupted' ? 'paused' : 'failed', { unfinished: unfinished.length });
      await this.#persistMetrics(status);
      const completed = await this.store.readState();
      this.logger.info('Run finished.', {
        runId: this.runId, status, tasks: completed.tasks.length,
        taskFailures: queueSummary.failed + queueSummary.blocked,
        ...this.provider.metrics,
      });
      if (unfinished.length && !this.abortController.signal.aborted) {
        throw new Error(`${unfinished.length} task(s) remain incomplete. Resume with: forgeflow resume --run-id ${this.runId} --dir "${this.root}"`);
      }
      return { runId: this.runId, status, tasks: completed.tasks.length };
    } catch (error) {
      const normalized = normalizeError(error);
      const status = normalized.code === 'INTERRUPTED' || this.abortController.signal.aborted ? 'interrupted' : 'failed';
      if (this.workflow && !['completed', 'failed', 'paused'].includes(this.workflow.phase)) {
        await this.workflow.transition(status === 'interrupted' ? 'paused' : 'failed', { message: normalized.message.slice(0, 300) }).catch(() => {});
      }
      await this.#persistMetrics(status).catch(() => {});
      if (status === 'interrupted') {
        this.logger.warn('Run paused; completed tasks are checkpointed.', { runId: this.runId });
        return { runId: this.runId, status };
      }
      this.logger.error('Run failed.', { runId: this.runId, code: normalized.code, message: normalized.message });
      throw normalized;
    } finally {
      process.removeListener('SIGINT', onInterrupt);
    }
  }

  async #makePlan() {
    const inventory = await this.workspace.inventory({ maxFiles: 500, maxDepth: 6 });
    const messages = buildPlannerMessages({ prompt: this.prompt, inventory, maxTasks: this.config.maxTasks });
    const response = await withTimeout(
      (signal) => this.provider.chat(messages, [], signal, {
        maxOutputTokens: Math.min(this.config.maxOutputTokens, 8_000),
        responseFormat: { type: 'json_object' },
      }),
      this.config.planTimeoutMs,
      this.abortController.signal,
      'Planning',
    );
    const rawPlan = parsePlan(response.choices[0].message.content);
    const tasks = validatePlan(rawPlan.tasks, this.config.maxTasks);
    const summary = truncateText(rawPlan.summary || 'Implementation plan', 600);
    await this.store.appendJournal({ type: 'plan', summary, taskCount: tasks.length });
    return { summary, tasks, hash: taskPlanHash(tasks) };
  }

  #printPlan(state) {
    this.logger.info('Plan ready.', { runId: this.runId, summary: state.summary });
    for (const [index, task] of state.tasks.entries()) {
      this.logger.info(`${index + 1}. ${task.title}`, {
        status: task.status,
        files: task.files.join(', '),
        dependencies: task.dependsOn?.join(', ') || undefined,
      });
    }
    if (this.opts.browser) this.logger.info('Browser tools enabled.', { headed: Boolean(this.opts.browserHeaded) });
    if (this.opts.allowShell) this.logger.warn('Shell tools are enabled with current-user permissions.');
  }

  async #runQueue(tasks) {
    const queue = new TaskQueue({
      concurrency: this.config.agents,
      logger: this.logger,
      onStatus: async (task, status, detail) => {
        const patch = {};
        if (detail.attempt) patch.attempts = detail.attempt;
        if (status === 'failed' || status === 'blocked') patch.error = { code: 'TASK_FAILED', message: truncateText(detail.message ?? detail.reason ?? status, 800) };
        if (status === 'completed') patch.error = null;
        await this.#setTaskStatus(task.id, status, patch);
        await this.workflow?.taskStatus(task.id, status, detail);
      },
    });
    this.logger.info('Worker pool started.', { workers: this.config.agents, queued: tasks.filter((task) => task.status !== 'completed').length });
    return queue.run(tasks, async (task, context) => {
      const taskId = String(task.id).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
      const taskLogger = this.logger.child({ taskId, worker: context.workerIndex });
      try {
        const result = await withTimeout(
          (signal) => this.#runTask(task, taskId, signal),
          this.config.taskTimeoutMs,
          this.abortController.signal,
          `Task ${taskId}`,
        );
        await this.#setTaskStatus(taskId, 'completed', { result: truncateText(result, 2_000), error: null });
        await this.store.appendJournal({ type: 'task_completed', taskId, title: task.title, summary: truncateText(result, 1_000) });
        await this.#persistMetrics('running');
        return result;
      } catch (error) {
        const normalized = normalizeError(error);
        taskLogger.warn('Task attempt failed.', { attempt: context.attempt + 1, code: normalized.code ?? normalized.name, message: normalized.message });
        await this.store.appendJournal({ type: 'task_failed', taskId, attempt: context.attempt + 1, code: normalized.code ?? 'ERROR', message: truncateText(normalized.message, 500) });
        throw normalized;
      }
    }, {
      signal: this.abortController.signal,
      maxRetries: this.config.taskRetries,
      shouldRetry: (error) => !this.abortController.signal.aborted && error?.code !== 'BUDGET_EXCEEDED',
      retryDelayMs: 1_000,
      maxRetryDelayMs: 10_000,
    });
  }

  async #runTask(task, taskId, signal) {
    throwIfAborted(signal);
    const profileId = selectAgentProfile(task);
    const profile = getAgentProfile(profileId);
    const budgets = profileBudget(profileId, this.config);
    const browserSession = `ff_${this.runId.slice(-12)}_${taskId.slice(0, 32)}`.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
    const system = this.#taskSystemPrompt(task, browserSession);
    let messages = [
      { role: 'system', content: system },
      { role: 'user', content: `Start by inspecting only relevant files, then implement: ${task.instructions}` },
    ];
    const toolset = filterToolDefinitions(
      toolDefinitions({ allowShell: this.opts.allowShell, browser: this.opts.browser }),
      allowedToolsForProfile(profileId, { allowShell: this.opts.allowShell, browser: this.opts.browser }),
    );
    for (let step = 1; step <= this.config.maxSteps; step += 1) {
      throwIfAborted(signal);
      const compact = truncateMessages(messages, { maxTokens: budgets.contextTokens, keepRecent: 8 });
      const response = await this.provider.chat(compact, toolset, signal, { maxOutputTokens: budgets.maxOutputTokens });
      const message = response.choices[0].message;
      messages.push(message);
      await this.#setTaskStatus(taskId, 'running', { steps: step });
      if (!Array.isArray(message.tool_calls) || message.tool_calls.length === 0) {
        const nudge = message.content?.trim()
          ? 'Continue implementation with tools. Inspect, edit, and verify the relevant changes. Finish only by calling finish_task.'
          : 'Your last response was empty. Continue with the task or call finish_task if it is already complete.';
        messages.push({ role: 'user', content: nudge });
        messages = truncateMessages(messages, { maxTokens: budgets.contextTokens, keepRecent: 8 });
        continue;
      }

      let completion = null;
      let turnToolCalls = 0;
      for (const call of message.tool_calls) {
        throwIfAborted(signal);
        turnToolCalls += 1;
        let result;
        try {
          const args = parseToolArguments(call.function.arguments);
          result = await executeTool({
            name: call.function.name,
            args,
            root: this.root,
            workspace: this.workspace,
            scope: task.files,
            allowShell: this.opts.allowShell,
            browser: this.browser,
            signal,
            commandTimeoutMs: this.config.commandTimeoutMs,
            logger: this.logger.child({ taskId, tool: call.function.name }),
          });
          if (call.function.name === 'finish_task') completion = String(result.summary ?? 'Task complete.');
          await this.store.appendJournal({ type: 'tool', taskId, tool: call.function.name, result: compactToolJournal(result) });
        } catch (error) {
          const normalized = normalizeError(error);
          result = { error: truncateText(normalized.message, 700), code: normalized.code ?? 'TOOL_ERROR' };
          await this.store.appendJournal({ type: 'tool_error', taskId, tool: call.function.name, ...result });
        }
        messages.push({ role: 'tool', tool_call_id: call.id, content: clipToolResult(result, this.config.toolOutputChars) });
      }
      await this.#persistMetrics('running', turnToolCalls);
      if (completion !== null) return completion;
      messages = truncateMessages(messages, { maxTokens: budgets.contextTokens, keepRecent: 8 });
    }
    throw new Error(`Task exceeded ${this.config.maxSteps} model turns.`);
  }

  #taskSystemPrompt(task, browserSession) {
    return [
      'You are a precise software engineer working on one bounded task.',
      `Project root: ${this.root}`,
      `Owned paths: ${task.files.join(', ')}`,
      `User request: ${truncateText(this.prompt, 14_000)}`,
      `Task: ${task.title}\n${task.instructions}`,
      profileInstructions(selectAgentProfile(task)),
      task.acceptance?.length ? `Acceptance checks:\n- ${task.acceptance.join('\n- ')}` : '',
      'Read relevant code before editing. Use search_files and line ranges to keep context small. Prefer replace_text for localized changes and write_file only when creating or intentionally replacing a complete file.',
      buildOperatingRules({ allowShell: this.opts.allowShell, browser: this.opts.browser }),
      this.opts.allowShell ? 'Shell is enabled. Run only task-relevant commands and inspect outputs.' : 'Shell is unavailable; do not claim that tests or commands were executed.',
      this.opts.browser ? `Browser is enabled for public web pages. Your isolated session id is ${browserSession}. Prefer compact browser_snapshot output; take screenshots only when visual detail is needed. Do not enter passwords or automate private account access.` : 'Browser is disabled for this run.',
      'When implementation is complete, call finish_task with an accurate summary. Do not claim unperformed verification.',
    ].filter(Boolean).join('\n\n');
  }

  async #setTaskStatus(taskId, status, patch = {}) {
    await this.store.updateState((state) => ({
      ...state,
      tasks: state.tasks.map((task) => task.id === taskId ? { ...task, ...patch, status, updatedAt: new Date().toISOString() } : task),
    }));
  }

  async #persistMetrics(status, toolCallsDelta = 0) {
    const metrics = this.provider.metrics;
    await this.store.updateState((state) => ({
      ...state,
      status,
      metrics: {
        ...state.metrics,
        apiCalls: metrics.calls,
        promptTokens: metrics.promptTokens,
        completionTokens: metrics.completionTokens,
        tokenBudget: metrics.tokenBudget,
        toolCalls: (state.metrics?.toolCalls ?? 0) + toolCallsDelta,
      },
    }));
  }
}

function combineLoggers(primary, disk) {
  const combined = {};
  for (const level of ['debug', 'info', 'warn', 'error']) {
    combined[level] = (message, meta) => {
      primary?.[level]?.(message, meta);
      disk?.[level]?.(message, meta);
    };
  }
  combined.child = (bindings) => combineLoggers(primary?.child?.(bindings), disk?.child?.(bindings));
  return combined;
}

function parseToolArguments(raw) {
  try {
    const parsed = JSON.parse(raw || '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Tool arguments must be an object.');
    return parsed;
  } catch (error) {
    throw new Error(`Tool arguments are invalid JSON: ${error.message}`);
  }
}

function compactToolJournal(result) {
  if (result === null || result === undefined) return result;
  if (typeof result !== 'object') return truncateText(String(result), 500);
  const clone = { ...result };
  if (typeof clone.content === 'string') clone.content = `[${clone.content.length} chars]`;
  if (typeof clone.snapshot === 'string') clone.snapshot = `[snapshot ${estimateTokens(clone.snapshot)} tokens]`;
  if (Array.isArray(clone.files)) clone.files = { count: clone.files.length, sample: clone.files.slice(0, 20) };
  return clone;
}
