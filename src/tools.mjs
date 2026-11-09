import { readdir, readFile, writeFile, mkdir, stat, realpath } from 'node:fs/promises';
import { resolve, relative, dirname, sep, extname } from 'node:path';
import { browserToolDefinitions, executeBrowserTool } from './browser.mjs';
import { ToolError } from './errors.mjs';
import { truncateText } from './text-budget.mjs';
import { hashText } from './workspace.mjs';
import { ToolPolicy } from './policy.mjs';
import { runProjectCommand, summarizeCommandResult } from './command-runner.mjs';

export const toolDefinitions = ({ allowShell = false, browser = false } = {}) => [
  { type: 'function', function: { name: 'list_files', description: 'List project files up to a depth of 4. Ignores common generated and secret directories.', parameters: { type: 'object', properties: { path: { type: 'string', description: 'Project-relative directory, default .' } }, additionalProperties: false } } },
  { type: 'function', function: { name: 'read_file', description: 'Read a UTF-8 text file within the project. Optional startLine/endLine let you inspect only a small relevant range.', parameters: { type: 'object', properties: { path: { type: 'string' }, startLine: { type: 'integer' }, endLine: { type: 'integer' } }, required: ['path'], additionalProperties: false } } },
  { type: 'function', function: { name: 'search_files', description: 'Search project text files for a literal string or regular expression. Returns only matching lines and file paths.', parameters: { type: 'object', properties: { query: { type: 'string' }, path: { type: 'string' }, regex: { type: 'boolean' }, caseSensitive: { type: 'boolean' }, limit: { type: 'integer' } }, required: ['query'], additionalProperties: false } } },
  { type: 'function', function: { name: 'write_file', description: 'Create or replace a UTF-8 text file within your assigned file scope. Supply the complete file contents.', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'], additionalProperties: false } } },
  { type: 'function', function: { name: 'replace_text', description: 'Replace one exact text block in a scoped UTF-8 file. Match must occur exactly once; read the file first.', parameters: { type: 'object', properties: { path: { type: 'string' }, oldText: { type: 'string' }, newText: { type: 'string' } }, required: ['path', 'oldText', 'newText'], additionalProperties: false } } },
  ...(allowShell ? [{ type: 'function', function: { name: 'run_command', description: 'Run a shell command in the project directory. Commands have the current user permissions.', parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'], additionalProperties: false } } }] : []),
  ...(browser ? browserToolDefinitions() : []),
  { type: 'function', function: { name: 'finish_task', description: 'Signal that your assigned task is complete. Include a concise summary.', parameters: { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'], additionalProperties: false } } },
];

const ignored = new Set(['.git', 'node_modules', '.next', 'dist', 'build', '.venv', 'vendor', '.forgeflow']);
const textExtensions = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.json', '.md', '.mdx', '.txt', '.yaml', '.yml', '.toml', '.html', '.css', '.scss', '.py', '.go', '.rs', '.java', '.kt', '.sh', '.ps1', '.sql', '.xml', '.svg', '.env.example']);

async function safePath(root, input, { mustExist = false } = {}) {
  const full = resolve(root, input || '.');
  const rel = relative(root, full);
  if (rel === '..' || rel.startsWith(`..${sep}`) || resolve(full) !== full) throw new Error('Path must stay inside the project directory.');
  const rootActual = await realpath(root);
  if (mustExist) {
    const actual = await realpath(full);
    const actualRel = relative(rootActual, actual);
    if (actualRel === '..' || actualRel.startsWith(`..${sep}`)) throw new Error('Symbolic links that point outside the project are not readable.');
    return actual;
  }
  let ancestor = dirname(full);
  while (ancestor !== dirname(ancestor)) {
    try {
      const actualAncestor = await realpath(ancestor);
      const actualRel = relative(rootActual, actualAncestor);
      if (actualRel === '..' || actualRel.startsWith(`..${sep}`)) throw new Error('Symbolic links that point outside the project are not writable.');
      break;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      ancestor = dirname(ancestor);
    }
  }
  return full;
}

function inScope(path, scope) {
  if (!scope || scope.length === 0) return false;
  const normalized = path.replaceAll('\\', '/');
  return scope.some((entry) => {
    const item = entry.replaceAll('\\', '/').replace(/\/$/, '');
    if (item.endsWith('/**')) {
      const base = item.slice(0, -3);
      return normalized.startsWith(`${base}/`);
    }
    return normalized === item;
  });
}

async function list(root, start = '.', depth = 0, prefix = '') {
  if (depth > 4) return [];
  const out = [];
  for (const item of await readdir(await safePath(root, start), { withFileTypes: true })) {
    if (ignored.has(item.name) || item.name.startsWith('.env')) continue;
    const name = prefix ? `${prefix}/${item.name}` : item.name;
    if (item.isDirectory()) out.push(...await list(root, resolve(start, item.name), depth + 1, name));
    else out.push(name);
    if (out.length >= 300) return out.slice(0, 300);
  }
  return out;
}

async function search(root, { query, path = '.', regex = false, caseSensitive = false, limit = 80 }) {
  const needle = String(query ?? '');
  if (!needle || needle.length > 500) throw new ToolError('Search query must contain 1 to 500 characters.');
  let matcher;
  try { matcher = regex ? new RegExp(needle, caseSensitive ? '' : 'i') : null; }
  catch (error) { throw new ToolError(`Invalid search expression: ${error.message}`); }
  const files = await list(root, path);
  const results = [];
  const cap = Math.min(200, Math.max(1, Number(limit) || 80));
  const literal = caseSensitive ? needle : needle.toLocaleLowerCase();
  for (const file of files) {
    if (results.length >= cap || !textExtensions.has(extname(file).toLowerCase())) continue;
    const full = await safePath(root, file, { mustExist: true }).catch(() => null);
    if (!full) continue;
    const info = await stat(full).catch(() => null);
    if (!info?.isFile() || info.size > 500_000) continue;
    const text = await readFile(full, 'utf8').catch(() => '');
    if (text.includes('\u0000')) continue;
    const lines = text.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      const found = matcher ? matcher.test(line) : (caseSensitive ? line : line.toLocaleLowerCase()).includes(literal);
      if (matcher) matcher.lastIndex = 0;
      if (found) results.push({ path: file, line: index + 1, text: truncateText(line.trim(), 400) });
      if (results.length >= cap) break;
    }
  }
  return { matches: results, truncated: results.length >= cap };
}

export async function executeTool({ name, args, root, workspace, scope, allowShell, browser, signal, commandTimeoutMs, logger }) {
  const policy = new ToolPolicy({ allowShell, browser: Boolean(browser) });
  policy.authorize(name);
  if (name === 'finish_task') return { finished: true, summary: String(args.summary ?? '') };
  if (name === 'list_files') {
    if (workspace) {
      const result = await workspace.listFiles({ path: args.path ?? '.', maxFiles: 300, maxDepth: 4 });
      return { files: result.files.map((item) => item.path), truncated: result.truncated };
    }
    return { files: await list(root, args.path ?? '.') };
  }
  if (name === 'search_files') return workspace ? workspace.search(args.query, args) : search(root, args);
  if (name === 'read_file') {
    if (workspace) {
      const file = await workspace.readText(args.path);
      const lines = file.text.split(/\r?\n/);
      const start = Math.max(1, Math.min(lines.length, Number(args.startLine) || 1));
      const end = Math.max(start, Math.min(lines.length, Number(args.endLine) || Math.min(lines.length, start + 240)));
      return { path: file.path, startLine: start, endLine: end, totalLines: lines.length, content: lines.slice(start - 1, end).map((line, index) => `${start + index}: ${line}`).join('\n') };
    }
    const full = await safePath(root, args.path, { mustExist: true });
    const info = await stat(full);
    if (info.size > 2_000_000) throw new ToolError('File exceeds 2 MB read limit.');
    const raw = await readFile(full, 'utf8');
    if (raw.includes('\u0000')) throw new ToolError('Binary files cannot be read as text.');
    const lines = raw.split(/\r?\n/);
    const start = Math.max(1, Math.min(lines.length, Number(args.startLine) || 1));
    const end = Math.max(start, Math.min(lines.length, Number(args.endLine) || Math.min(lines.length, start + 240)));
    return { path: args.path, startLine: start, endLine: end, totalLines: lines.length, content: lines.slice(start - 1, end).map((line, index) => `${start + index}: ${line}`).join('\n') };
  }
  if (name === 'write_file') {
    if (workspace) {
      const rel = String(args.path).replaceAll('\\', '/');
      if (!inScope(rel, scope)) throw new ToolError(`Write rejected: ${rel} is outside this agent's assigned files.`);
      return workspace.writeText(args.path, args.content);
    }
    const full = await safePath(root, args.path);
    const rel = relative(root, full).replaceAll('\\', '/');
    if (!inScope(rel, scope)) throw new Error(`Write rejected: ${rel} is outside this agent's assigned files.`);
    if (rel.startsWith('.env') || rel.startsWith('.git/')) throw new Error('Writing secret or Git metadata files is blocked.');
    if (Buffer.byteLength(String(args.content)) > 1_000_000) throw new ToolError('File content exceeds 1 MB write limit.');
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, String(args.content), { encoding: 'utf8', flag: 'w' });
    return { written: rel, bytes: Buffer.byteLength(String(args.content)) };
  }
  if (name === 'replace_text') {
    if (workspace) {
      const rel = String(args.path).replaceAll('\\', '/');
      if (!inScope(rel, scope)) throw new ToolError(`Write rejected: ${rel} is outside this agent's assigned files.`);
      const file = await workspace.readText(args.path);
      const oldText = String(args.oldText ?? '');
      if (!oldText) throw new ToolError('oldText cannot be empty.');
      const first = file.text.indexOf(oldText);
      if (first < 0) throw new ToolError('Exact oldText was not found; reread the file and retry.');
      if (file.text.indexOf(oldText, first + oldText.length) >= 0) throw new ToolError('oldText appears more than once. Use a more specific exact block.');
      const updated = `${file.text.slice(0, first)}${String(args.newText ?? '')}${file.text.slice(first + oldText.length)}`;
      return workspace.writeText(args.path, updated, { expectedHash: hashText(file.text) });
    }
    const full = await safePath(root, args.path, { mustExist: true });
    const rel = relative(root, full).replaceAll('\\', '/');
    if (!inScope(rel, scope)) throw new Error(`Write rejected: ${rel} is outside this agent's assigned files.`);
    if (rel.startsWith('.env') || rel.startsWith('.git/')) throw new Error('Editing secret or Git metadata files is blocked.');
    const info = await stat(full);
    if (info.size > 1_000_000) throw new ToolError('File exceeds 1 MB edit limit.');
    const content = await readFile(full, 'utf8');
    const oldText = String(args.oldText ?? '');
    if (!oldText) throw new ToolError('oldText cannot be empty.');
    const first = content.indexOf(oldText);
    if (first < 0) throw new ToolError('Exact oldText was not found; reread the file and retry.');
    if (content.indexOf(oldText, first + oldText.length) >= 0) throw new ToolError('oldText appears more than once. Use a more specific exact block.');
    const updated = `${content.slice(0, first)}${String(args.newText ?? '')}${content.slice(first + oldText.length)}`;
    await writeFile(full, updated, 'utf8');
    return { updated: rel, bytes: Buffer.byteLength(updated) };
  }
  if (name === 'run_command' && allowShell) {
    policy.checkCommand(args.command);
    const result = await runProjectCommand({ command: args.command, cwd: root, signal, timeoutMs: commandTimeoutMs, logger });
    return summarizeCommandResult(result, 7_000);
  }
  if (name.startsWith('browser_')) return executeBrowserTool(browser, name, args);
  throw new Error(`Tool not available: ${name}`);
}
