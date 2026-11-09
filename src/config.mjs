import { ConfigurationError } from './errors.mjs';

const DEFAULTS = Object.freeze({
  model: 'gpt-6.1-sol',
  baseUrl: 'https://api.openai.com/v1',
  agents: 4,
  maxSteps: 80,
  maxCalls: 1_000,
  maxOutputTokens: 4_000,
  tokenLimitParameter: 'max_completion_tokens',
  contextTokens: 8_000,
  toolOutputChars: 4_000,
  maxTotalTokens: 1_000_000,
  maxRetries: 2,
  requestsPerMinute: 60,
  requestTimeoutMs: 90_000,
  taskTimeoutMs: 30 * 60_000,
  planTimeoutMs: 120_000,
  browserTimeoutMs: 15_000,
  commandTimeoutMs: 120_000,
  maxTasks: 256,
  taskRetries: 1,
});

export function getConfig(opts = {}, env = process.env) {
  const keys = [
    ...(env.FORGEFLOW_API_KEYS ?? '').split(/[;,\s]+/),
    env.OPENAI_API_KEY ?? '',
  ].map((key) => key.trim()).filter(Boolean);
  const uniqueKeys = [...new Set(keys)];
  const baseUrl = String(opts.baseUrl ?? env.FORGEFLOW_BASE_URL ?? DEFAULTS.baseUrl).replace(/\/+$/, '');
  let parsed;
  try { parsed = new URL(baseUrl); }
  catch { throw new ConfigurationError('API base URL is invalid.'); }
  if (!['https:', 'http:'].includes(parsed.protocol)) throw new ConfigurationError('API base URL must use HTTP or HTTPS.');
  if (parsed.username || parsed.password) throw new ConfigurationError('API base URL cannot contain embedded credentials.');
  const model = String(opts.model ?? env.FORGEFLOW_MODEL ?? DEFAULTS.model).trim();
  if (!model || model.length > 120) throw new ConfigurationError('Model name must contain 1 to 120 characters.');
  const tokenLimitParameter = String(opts.tokenLimitParameter ?? env.FORGEFLOW_TOKEN_LIMIT_PARAMETER ?? DEFAULTS.tokenLimitParameter);
  if (!['max_completion_tokens', 'max_tokens'].includes(tokenLimitParameter)) throw new ConfigurationError('Token parameter must be max_completion_tokens or max_tokens.');
  if (!opts.allowMissingKeys && !uniqueKeys.length) {
    throw new ConfigurationError('Set OPENAI_API_KEY or FORGEFLOW_API_KEYS with keys you own.');
  }

  const resolved = {
    ...DEFAULTS,
    ...opts,
    keys: uniqueKeys,
    baseUrl,
    model,
    tokenLimitParameter,
    organization: env.OPENAI_ORGANIZATION?.trim() || undefined,
    project: env.OPENAI_PROJECT?.trim() || undefined,
  };
  validateLimits(resolved);
  return resolved;
}

function validateLimits(config) {
  const rules = {
    agents: [1, 256],
    maxSteps: [1, 2_000],
    maxCalls: [1, 100_000],
    maxOutputTokens: [64, 64_000],
    contextTokens: [1_000, 200_000],
    toolOutputChars: [500, 100_000],
    maxTotalTokens: [1_000, 100_000_000],
    requestsPerMinute: [1, 100_000],
    requestTimeoutMs: [1_000, 600_000],
    taskTimeoutMs: [1_000, 24 * 60 * 60_000],
    planTimeoutMs: [1_000, 600_000],
    browserTimeoutMs: [1_000, 120_000],
    commandTimeoutMs: [1_000, 600_000],
    maxTasks: [1, 256],
    taskRetries: [0, 10],
  };
  for (const [key, [min, max]] of Object.entries(rules)) {
    const value = Number(config[key]);
    if (!Number.isInteger(value) || value < min || value > max) {
      throw new ConfigurationError(`${key} must be an integer from ${min} to ${max}.`);
    }
    config[key] = value;
  }
}

export function defaults() { return { ...DEFAULTS }; }
