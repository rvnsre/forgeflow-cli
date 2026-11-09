import { resolve } from 'node:path';
import { stdin, stdout } from 'node:process';
import { getConfig } from './config.mjs';
import { Orchestrator } from './orchestrator.mjs';
import { RunStore } from './run-store.mjs';
import { BrowserManager } from './browser.mjs';
import { Logger } from './logger.mjs';
import { ConfigurationError } from './errors.mjs';
import { formatDiagnostics, runDiagnostics } from './diagnostics.mjs';

const HELP = `ForgeFlow — resilient terminal coding agents

Usage:
  forgeflow run [options] [prompt]
  forgeflow resume --run-id <id> [options]
  forgeflow status [--dir <project>]
  forgeflow doctor

Run options:
  --dir <path>             Project directory (default: current directory)
  --agents <1..256>        Max parallel workers (default: 4)
  --max-tasks <1..256>     Max plan tasks (default: 256)
  --max-steps <n>          Max model turns per task (default: 80)
  --max-calls <n>          Max provider calls per run (default: 1000)
  --token-parameter <name> Token cap field (default: max_completion_tokens)
  --context-tokens <n>     Approximate retained context budget (default: 8000)
  --tool-output-chars <n>  Max chars retained per tool result (default: 4000)
  --max-total-tokens <n>   Approximate total run token ceiling (default: 1000000)
  --command-timeout-ms <n> Max command runtime (default: 120000)
  --task-retries <0..10>   Retry a failed task (default: 1)
  --model <name>           API model (default: gpt-6.1-sol)
  --base-url <url>         OpenAI-compatible API root
  --allow-shell            Enable shell execution in project root
  --browser                Enable isolated Chromium browser tools
  --browser-headed         Show Chromium UI (requires --browser)
  --plan-only              Save and print a plan, without coding workers
  --quiet                  Reduce console logs; detailed run log stays on disk
  --help                   Show this help

Environment:
  OPENAI_API_KEY           One API key you own
  FORGEFLOW_API_KEYS       Optional additional keys, comma/semicolon separated
  FORGEFLOW_MODEL          Default model override
  FORGEFLOW_BASE_URL       Default API URL override

Pass - as prompt to read from stdin. Ctrl+C requests a checkpointed stop.
`;

const VALUE_OPTIONS = new Map([
  ['--dir', 'dir'], ['--agents', 'agents'], ['--max-tasks', 'maxTasks'],
  ['--max-steps', 'maxSteps'], ['--max-calls', 'maxCalls'],
  ['--max-output-tokens', 'maxOutputTokens'], ['--context-tokens', 'contextTokens'],
  ['--token-parameter', 'tokenLimitParameter'],
  ['--tool-output-chars', 'toolOutputChars'], ['--task-retries', 'taskRetries'],
  ['--max-total-tokens', 'maxTotalTokens'], ['--command-timeout-ms', 'commandTimeoutMs'],
  ['--requests-per-minute', 'requestsPerMinute'], ['--timeout-ms', 'requestTimeoutMs'],
  ['--task-timeout-ms', 'taskTimeoutMs'], ['--plan-timeout-ms', 'planTimeoutMs'],
  ['--model', 'model'], ['--base-url', 'baseUrl'], ['--run-id', 'runId'],
]);

function parse(argv) {
  const options = {
    dir: process.cwd(), agents: 4, maxTasks: 256, maxSteps: 80, maxCalls: 1_000,
    maxOutputTokens: 4_000, contextTokens: 8_000, toolOutputChars: 4_000,
    maxTotalTokens: 1_000_000, commandTimeoutMs: 120_000,
    taskRetries: 1, requestsPerMinute: 60, requestTimeoutMs: 90_000,
    taskTimeoutMs: 30 * 60_000, planTimeoutMs: 120_000,
    allowShell: false, browser: false, browserHeaded: false, planOnly: false,
    quiet: false,
  };
  const positional = [];
  let command = 'run';
  let index = 0;
  if (argv[0] && ['run', 'resume', 'status', 'doctor', 'help'].includes(argv[0])) command = argv[index++];
  for (; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') { options.help = true; continue; }
    if (arg === '--allow-shell') { options.allowShell = true; continue; }
    if (arg === '--browser') { options.browser = true; continue; }
    if (arg === '--browser-headed') { options.browserHeaded = true; options.browser = true; continue; }
    if (arg === '--plan-only') { options.planOnly = true; continue; }
    if (arg === '--quiet' || arg === '-q') { options.quiet = true; continue; }
    if (VALUE_OPTIONS.has(arg)) {
      const raw = argv[++index];
      if (!raw) throw new ConfigurationError(`Missing value after ${arg}.`);
      const key = VALUE_OPTIONS.get(arg);
      options[key] = ['dir', 'model', 'baseUrl', 'runId', 'tokenLimitParameter'].includes(key) ? raw : Number(raw);
      continue;
    }
    if (arg.startsWith('-') && arg !== '-') throw new ConfigurationError(`Unknown option: ${arg}`);
    positional.push(arg);
  }
  if (options.browserHeaded && !options.browser) throw new ConfigurationError('--browser-headed requires --browser.');
  options.promptArgument = positional.join(' ');
  options.dir = resolve(options.dir);
  return { command, options };
}

async function readPrompt(argument) {
  if (argument === '-') {
    const chunks = [];
    for await (const chunk of stdin) chunks.push(chunk);
    return Buffer.concat(chunks).toString('utf8').trim();
  }
  return String(argument ?? '').trim();
}

export async function run(argv) {
  let parsed;
  try { parsed = parse(argv); }
  catch (error) { console.error(`ForgeFlow: ${error.message}`); stdout.write(`\n${HELP}`); process.exitCode = 2; return; }
  const { command, options } = parsed;
  if (options.help || command === 'help') { stdout.write(HELP); return; }
  if (command === 'status') return showStatus(options.dir);
  if (command === 'doctor') return doctor();
  if (!['run', 'resume'].includes(command)) throw new ConfigurationError(`Unknown command: ${command}`);

  const isResume = command === 'resume';
  if (isResume && !options.runId) throw new ConfigurationError('resume requires --run-id.');
  const config = getConfig(options);
  const prompt = await readPrompt(options.promptArgument);
  if (!isResume && !prompt) throw new ConfigurationError('Provide a prompt or pass - to read one from stdin.');
  if (prompt.length > 100_000) throw new ConfigurationError('Prompt exceeds the 100,000 character limit.');

  const logger = new Logger({ level: options.quiet ? 'warn' : 'info', quiet: options.quiet });
  const browser = options.browser
    ? new BrowserManager({ artifactRoot: resolve(options.dir, '.forgeflow', 'browser'), headed: options.browserHeaded, timeoutMs: config.browserTimeoutMs })
    : null;
  const orchestrator = new Orchestrator({ config, root: options.dir, prompt, opts: options, logger, browser, resume: isResume });
  try { await orchestrator.execute(); }
  finally { await browser?.close(); }
}

async function showStatus(projectRoot) {
  const runs = await RunStore.list(projectRoot);
  if (!runs.length) { stdout.write(`No ForgeFlow runs found under ${projectRoot}\.forgeflow\runs.\n`); return; }
  for (const run of runs.slice(0, 30)) {
    stdout.write(`${run.runId}  ${run.status.padEnd(11)}  ${run.updatedAt}  ${run.summary ?? ''}\n`);
  }
}

async function doctor() {
  const report = await runDiagnostics();
  stdout.write(`${formatDiagnostics(report)}\n`);
  if (!report.ok) process.exitCode = 1;
}
