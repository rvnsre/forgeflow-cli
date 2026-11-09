const SECRET_PATTERNS = [
  /["']?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|secret|password|authorization|cookie)["']?\s*:\s*["'][^"']+["']/gi,
  /\bsk-[A-Za-z0-9_-]{16,}\b/g,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi,
  /\b(api[_-]?key|access[_-]?token|secret|password)\s*[:=]\s*["']?[^\s"',}]{8,}/gi,
];

export function redactSecrets(value) {
  let text = String(value ?? '');
  for (const pattern of SECRET_PATTERNS) text = text.replace(pattern, '[REDACTED]');
  return text;
}

export function estimateTokens(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  if (!text) return 0;
  const ascii = (text.match(/[\x00-\x7F]/g) ?? []).length;
  const nonAscii = text.length - ascii;
  return Math.ceil(ascii / 4 + nonAscii / 2.3);
}

export function truncateText(value, maxChars, suffix = '\n…[truncated]') {
  const text = String(value ?? '');
  if (text.length <= maxChars) return text;
  const safeLimit = Math.max(0, maxChars - suffix.length);
  return `${text.slice(0, safeLimit)}${suffix}`;
}

export function compactWhitespace(value) {
  return String(value ?? '')
    .replace(/[\t\f\v ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function compactJson(value, maxChars = 12_000) {
  const redacted = redactDeep(value);
  const json = JSON.stringify(redacted);
  return truncateText(json, maxChars, '…[json truncated]');
}

export function redactDeep(value, seen = new WeakSet()) {
  if (typeof value === 'string') return redactSecrets(value);
  if (Array.isArray(value)) return value.map((item) => redactDeep(item, seen));
  if (!value || typeof value !== 'object') return value;
  if (seen.has(value)) return '[Circular]';
  seen.add(value);
  const output = {};
  for (const [key, item] of Object.entries(value)) {
    if (/key|secret|token|password|authorization|cookie/i.test(key)) output[key] = '[REDACTED]';
    else output[key] = redactDeep(item, seen);
  }
  seen.delete(value);
  return output;
}

export function redactValuesDeep(value, seen = new WeakSet()) {
  if (typeof value === 'string') return redactSecrets(value);
  if (Array.isArray(value)) return value.map((item) => redactValuesDeep(item, seen));
  if (!value || typeof value !== 'object') return value;
  if (seen.has(value)) return '[Circular]';
  seen.add(value);
  const output = {};
  for (const [key, item] of Object.entries(value)) output[key] = redactValuesDeep(item, seen);
  seen.delete(value);
  return output;
}

export function clipToolResult(result, maxChars = 6_000) {
  if (typeof result === 'string') return truncateText(redactSecrets(result), maxChars);
  const redacted = redactDeep(result);
  const serialized = JSON.stringify(redacted);
  if (serialized.length <= maxChars) return serialized;
  if (result && typeof result === 'object' && typeof result.content === 'string') {
    return JSON.stringify({ ...redacted, content: truncateText(result.content, Math.max(500, maxChars - 200)) });
  }
  return JSON.stringify({ truncated: true, preview: truncateText(serialized, maxChars - 120) });
}

export function truncateMessages(messages, { maxTokens = 12_000, keepRecent = 8 } = {}) {
  if (!Array.isArray(messages) || messages.length <= 3) return messages ?? [];
  const budget = Math.max(1_000, maxTokens);
  const system = messages.filter((message) => message.role === 'system').slice(0, 2);
  const rest = messages.filter((message) => message.role !== 'system');
  const selected = [];
  let tokens = system.reduce((sum, item) => sum + estimateTokens(item), 0);
  const recentGroups = groupConversation(rest).slice(-keepRecent);
  for (let i = recentGroups.length - 1; i >= 0; i -= 1) {
    const group = recentGroups[i];
    const size = estimateTokens(group);
    if (selected.length && tokens + size > budget) break;
    selected.unshift(group);
    tokens += size;
  }
  const flattened = selected.flat();
  return [...system, ...flattened];
}

function groupConversation(messages) {
  const groups = [];
  let current = [];
  for (const message of messages) {
    if (message.role === 'user' && current.length) {
      groups.push(current);
      current = [];
    }
    current.push(message);
    if (message.role === 'tool') {
      // Tool replies remain adjacent to the assistant tool-call message.
      // The next user/assistant message starts the next retained segment.
    }
  }
  if (current.length) groups.push(current);
  return groups;
}

export function makeConversationSummary(messages, maxChars = 2_000) {
  const lines = [];
  for (const message of messages ?? []) {
    if (message.role === 'assistant' && message.content) lines.push(`assistant: ${compactWhitespace(message.content)}`);
    if (message.role === 'tool') {
      const content = typeof message.content === 'string' ? message.content : JSON.stringify(message.content);
      lines.push(`tool: ${compactWhitespace(content).slice(0, 280)}`);
    }
  }
  return truncateText(redactSecrets(lines.join('\n')), maxChars);
}
