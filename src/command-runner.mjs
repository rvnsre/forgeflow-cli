import { spawn } from 'node:child_process';
import { ToolError } from './errors.mjs';
import { truncateText } from './text-budget.mjs';
import { analyzeShellCommand, redactCommandForLog } from './policy.mjs';

const MAX_COMMAND_MS = 10 * 60_000;
const DEFAULT_COMMAND_MS = 120_000;

export async function runProjectCommand({ command, cwd, signal, timeoutMs = DEFAULT_COMMAND_MS, maxOutputBytes = 24_000, logger }) {
  const analysis = analyzeShellCommand(command);
  const boundedTimeout = Math.max(1_000, Math.min(Number(timeoutMs) || DEFAULT_COMMAND_MS, MAX_COMMAND_MS));
  const start = Date.now();
  const child = spawn(analysis.command, {
    cwd,
    shell: true,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: getSanitizedEnvironment(process.env),
    signal,
  });
  logger?.info?.('Executing project command.', { command: redactCommandForLog(analysis.command), risk: analysis.risk });

  const buffers = { stdout: [], stderr: [] };
  const sizes = { stdout: 0, stderr: 0 };
  let totalBytes = 0;
  let truncated = false;
  const collect = (stream) => (chunk) => {
    const buffer = Buffer.from(chunk);
    totalBytes += buffer.length;
    if (totalBytes > maxOutputBytes) truncated = true;
    const allowed = Math.max(0, Math.min(buffer.length, maxOutputBytes - (sizes.stdout + sizes.stderr)));
    if (allowed > 0) {
      buffers[stream].push(buffer.subarray(0, allowed));
      sizes[stream] += allowed;
    }
    if (totalBytes > maxOutputBytes * 4) {
      terminateProcess(child);
    }
  };
  child.stdout.on('data', collect('stdout'));
  child.stderr.on('data', collect('stderr'));

  let timeoutId;
  let timedOut = false;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      timedOut = true;
      terminateProcess(child);
      reject(new ToolError(`Command timed out after ${boundedTimeout} ms.`, { code: 'COMMAND_TIMEOUT', toolName: 'run_command' }));
    }, boundedTimeout);
  });
  const completion = new Promise((resolve, reject) => {
    child.once('error', (error) => reject(new ToolError(`Could not start command: ${error.message}`, { code: 'COMMAND_START_FAILED', toolName: 'run_command' })));
    child.once('close', (code, processSignal) => resolve({ code, processSignal }));
  });

  try {
    const { code, processSignal } = await Promise.race([completion, timeout]);
    if (signal?.aborted) throw signal.reason ?? new ToolError('Command was interrupted.', { code: 'INTERRUPTED', toolName: 'run_command' });
    const stdoutText = Buffer.concat(buffers.stdout).toString('utf8');
    const stderrText = Buffer.concat(buffers.stderr).toString('utf8');
    return {
      exitCode: code,
      signal: processSignal,
      durationMs: Date.now() - start,
      stdout: stdoutText,
      stderr: stderrText,
      outputTruncated: truncated,
      outputBytes: totalBytes,
      command: redactCommandForLog(analysis.command),
      ...(analysis.requiresReview ? { riskNote: analysis.note } : {}),
    };
  } catch (error) {
    if (timedOut) throw error;
    if (signal?.aborted) throw signal.reason ?? error;
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

export function getSanitizedEnvironment(environment) {
  const clean = {};
  for (const [key, value] of Object.entries(environment ?? {})) {
    if (isSensitiveEnvironmentName(key)) continue;
    clean[key] = value;
  }
  return clean;
}

export function isSensitiveEnvironmentName(name) {
  return /(?:API[_-]?KEY|ACCESS[_-]?TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTHORIZATION|COOKIE|PRIVATE[_-]?KEY|CLIENT[_-]?SECRET)/i.test(name);
}

export function summarizeCommandResult(result, maxChars = 8_000) {
  const output = [
    result.stdout ? `stdout:\n${result.stdout}` : '',
    result.stderr ? `stderr:\n${result.stderr}` : '',
  ].filter(Boolean).join('\n\n');
  return {
    exitCode: result.exitCode,
    signal: result.signal,
    durationMs: result.durationMs,
    outputTruncated: result.outputTruncated,
    outputBytes: result.outputBytes,
    output: truncateText(output, maxChars),
    ...(result.riskNote ? { riskNote: result.riskNote } : {}),
  };
}

function terminateProcess(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32' && child.pid) {
    try {
      const killer = spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' });
      killer.unref?.();
      return;
    } catch { /* Fall back to killing the direct process. */ }
  }
  try { child.kill('SIGTERM'); } catch { /* process already exited */ }
  const force = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) {
      try { child.kill('SIGKILL'); } catch { /* process already exited */ }
    }
  }, 1_500);
  force.unref?.();
}
