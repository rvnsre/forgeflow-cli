export class ForgeFlowError extends Error {
  constructor(message, options = {}) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = new.target.name;
    this.code = options.code ?? 'FORGEFLOW_ERROR';
    this.retryable = Boolean(options.retryable);
    this.details = options.details;
  }
}

export class ConfigurationError extends ForgeFlowError {
  constructor(message, details) {
    super(message, { code: 'CONFIGURATION_ERROR', details });
  }
}

export class ProviderError extends ForgeFlowError {
  constructor(message, options = {}) {
    super(message, {
      code: options.code ?? 'PROVIDER_ERROR',
      retryable: options.retryable,
      details: options.details,
      cause: options.cause,
    });
    this.status = options.status ?? null;
    this.requestId = options.requestId ?? null;
    this.retryAfterMs = options.retryAfterMs ?? null;
  }
}

export class BudgetExceededError extends ForgeFlowError {
  constructor(kind, limit) {
    super(`${kind} limit reached (${limit}).`, {
      code: 'BUDGET_EXCEEDED',
      details: { kind, limit },
    });
  }
}

export class ToolError extends ForgeFlowError {
  constructor(message, options = {}) {
    super(message, { code: options.code ?? 'TOOL_ERROR', details: options.details });
    this.toolName = options.toolName ?? null;
  }
}

export class BrowserError extends ToolError {
  constructor(message, options = {}) {
    super(message, { ...options, code: options.code ?? 'BROWSER_ERROR' });
    this.name = 'BrowserError';
  }
}

export class InterruptedError extends ForgeFlowError {
  constructor(message = 'Run interrupted by user.') {
    super(message, { code: 'INTERRUPTED' });
  }
}

export function normalizeError(error, fallback = 'Unexpected error.') {
  if (error instanceof Error) return error;
  return new ForgeFlowError(typeof error === 'string' ? error : fallback, {
    details: { thrownType: typeof error },
  });
}

export function publicError(error) {
  const normalized = normalizeError(error);
  return {
    name: normalized.name,
    code: normalized.code ?? 'ERROR',
    message: normalized.message,
    retryable: Boolean(normalized.retryable),
  };
}
