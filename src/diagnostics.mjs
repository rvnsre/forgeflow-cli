import { access, constants, readFile } from 'node:fs/promises';
import { platform, arch, versions } from 'node:process';
import { getConfig } from './config.mjs';

export async function runDiagnostics({ env = process.env, cwd = process.cwd() } = {}) {
  const report = {
    generatedAt: new Date().toISOString(),
    platform: `${platform}/${arch}`,
    node: versions.node,
    checks: [],
    ok: true,
  };
  const add = (name, status, message, details = {}) => {
    const check = { name, status, message, ...details };
    report.checks.push(check);
    if (status === 'error') report.ok = false;
  };

  const major = Number(versions.node.split('.')[0]);
  add('node-version', major >= 20 ? 'ok' : 'error', major >= 20 ? 'Node.js 20 or newer is available.' : 'Node.js 20 or newer is required.');
  add('fetch-api', typeof fetch === 'function' ? 'ok' : 'error', typeof fetch === 'function' ? 'Native Fetch API is available.' : 'Native Fetch API is missing.');
  add('working-directory', await canRead(cwd) ? 'ok' : 'error', await canRead(cwd) ? 'Current directory can be read.' : 'Current directory cannot be read.');
  add('api-key', hasKey(env) ? 'ok' : 'warning', hasKey(env) ? 'At least one API key is configured.' : 'No API key is configured; `run` and `resume` require one.');

  try {
    const config = getConfig({ allowMissingKeys: true }, env);
    add('api-endpoint', 'ok', 'API endpoint configuration is valid.', { baseUrl: config.baseUrl, model: config.model });
  } catch (error) {
    add('api-endpoint', 'error', error.message);
  }

  try {
    const packageUrl = new URL('../package.json', import.meta.url);
    const metadata = JSON.parse(await readFile(packageUrl, 'utf8'));
    add('package-metadata', 'ok', `${metadata.name} ${metadata.version}`, { packageName: metadata.name, packageVersion: metadata.version });
  } catch (error) {
    add('package-metadata', 'error', `Package metadata cannot be read: ${error.message}`);
  }

  try {
    const playwright = await import('playwright');
    const executable = playwright.chromium.executablePath();
    const installed = await access(executable, constants.F_OK).then(() => true, () => false);
    add('playwright-package', 'ok', 'Playwright package is installed.');
    add('chromium-binary', installed ? 'ok' : 'warning', installed ? 'Chromium binary is installed.' : 'Chromium binary is missing; run `npx playwright install chromium`.', { executable });
  } catch {
    add('playwright-package', 'warning', 'Browser features are optional. Install with `npm install playwright`.');
  }

  const warnings = report.checks.filter((check) => check.status === 'warning').length;
  report.summary = report.ok ? `${report.checks.length - warnings} checks passed; ${warnings} warning(s).` : `${report.checks.filter((check) => check.status === 'error').length} check(s) failed.`;
  return report;
}

export function formatDiagnostics(report) {
  const rows = report.checks.map((check) => `${statusGlyph(check.status)} ${check.name.padEnd(20)} ${check.message}`);
  rows.push('', report.summary);
  return rows.join('\n');
}

function hasKey(env) {
  return Boolean(env.OPENAI_API_KEY?.trim() || env.FORGEFLOW_API_KEYS?.trim());
}

async function canRead(path) {
  return access(path, constants.R_OK).then(() => true, () => false);
}

function statusGlyph(status) {
  return ({ ok: '✓', warning: '!', error: '✗' })[status] ?? '?';
}
