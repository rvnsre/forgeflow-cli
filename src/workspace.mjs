import { realpath as resolveRealPath } from 'node:fs';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { ToolError } from './errors.mjs';
import { truncateText } from './text-budget.mjs';

// The callback resolver follows symlinks without requiring the native final-path
// handle operation that fails in some Windows sandboxed runtimes.
const realpath = promisify(resolveRealPath);

export const DEFAULT_IGNORES = Object.freeze([
  '.git', '.hg', '.svn', '.idea', '.vscode', 'node_modules', 'vendor',
  '.venv', 'venv', '__pycache__', '.next', '.nuxt', '.svelte-kit',
  'dist', 'build', 'coverage', '.turbo', '.cache', '.forgeflow',
  'target', 'Pods', 'DerivedData', '.gradle', '.pytest_cache',
]);

const DEFAULT_TEXT_EXTENSIONS = new Set([
  '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.json', '.md', '.mdx',
  '.txt', '.yaml', '.yml', '.toml', '.html', '.htm', '.css', '.scss',
  '.sass', '.less', '.py', '.pyi', '.go', '.rs', '.java', '.kt', '.kts',
  '.sh', '.bash', '.zsh', '.ps1', '.sql', '.xml', '.svg', '.graphql',
  '.gql', '.php', '.rb', '.swift', '.c', '.h', '.cpp', '.hpp', '.cs',
  '.fs', '.ex', '.exs', '.erl', '.hrl', '.lua', '.r', '.R', '.ipynb',
  '.vue', '.svelte', '.astro', '.tf', '.dockerfile', '.properties',
]);

export class ProjectWorkspace {
  constructor(root, options = {}) {
    this.root = resolve(root);
    this.maxFileBytes = options.maxFileBytes ?? 2_000_000;
    this.maxWriteBytes = options.maxWriteBytes ?? 1_000_000;
    this.maxInventoryFiles = options.maxInventoryFiles ?? 5_000;
    this.maxInventoryDepth = options.maxInventoryDepth ?? 8;
    this.ignored = new Set([...DEFAULT_IGNORES, ...(options.ignored ?? [])]);
    this.includeHidden = Boolean(options.includeHidden);
    this.rootRealPath = null;
  }

  async initialize({ create = false } = {}) {
    if (create) await mkdir(this.root, { recursive: true });
    this.rootRealPath = await realpath(this.root);
    const info = await stat(this.rootRealPath);
    if (!info.isDirectory()) throw new ToolError('Project root must be a directory.');
    this.root = this.rootRealPath;
    return this;
  }

  async resolvePath(input, { mustExist = false, forWrite = false } = {}) {
    const raw = String(input ?? '.');
    if (/^[a-z]:/i.test(raw) && !isAbsolute(raw)) throw new ToolError('Drive-qualified paths must be absolute or project-relative.');
    const full = resolve(this.root, raw);
    const relativePath = relative(this.root, full);
    if (relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
      throw new ToolError('Path must stay inside the project directory.');
    }
    if (mustExist) {
      const actual = await realpath(full);
      this.#assertWithinRoot(actual, 'Symbolic link points outside the project.');
      return actual;
    }
    if (forWrite) await this.#assertWritableAncestors(full);
    return full;
  }

  async readText(input, options = {}) {
    const full = await this.resolvePath(input, { mustExist: true });
    const relativePath = this.relativePath(full);
    if (isSensitiveProjectPath(relativePath)) throw new ToolError('Reading credential or private-key files is blocked.');
    const info = await stat(full);
    if (!info.isFile()) throw new ToolError('Path is not a regular file.');
    if (info.size > (options.maxBytes ?? this.maxFileBytes)) throw new ToolError(`File exceeds ${options.maxBytes ?? this.maxFileBytes} byte read limit.`);
    const text = await readFile(full, 'utf8');
    if (text.includes('\u0000')) throw new ToolError('Binary files cannot be read as text.');
    return { path: relativePath, text, size: info.size, mtimeMs: info.mtimeMs };
  }

  async writeText(input, text, options = {}) {
    const full = await this.resolvePath(input, { forWrite: true });
    const relativePath = this.relativePath(full).replaceAll('\\', '/');
    if (relativePath === '.' || relativePath.startsWith('.git/')) throw new ToolError('Writing project root or Git metadata is blocked.');
    if (isSensitiveProjectPath(relativePath)) throw new ToolError('Writing credential or private-key files is blocked.');
    const content = String(text ?? '');
    const bytes = Buffer.byteLength(content);
    if (bytes > (options.maxBytes ?? this.maxWriteBytes)) throw new ToolError(`File content exceeds ${options.maxBytes ?? this.maxWriteBytes} byte write limit.`);
    if (options.expectedHash) {
      const previous = await readFile(full, 'utf8').catch(() => null);
      if (previous === null || hashText(previous) !== options.expectedHash) throw new ToolError('File changed since it was read. Re-read before writing.');
    }
    await mkdir(dirname(full), { recursive: true });
    const temporary = `${full}.forgeflow-${process.pid}-${Date.now()}.tmp`;
    try {
      await writeFile(temporary, content, { encoding: 'utf8', mode: options.mode ?? 0o600 });
      await rename(temporary, full);
    } catch (error) {
      await import('node:fs/promises').then((fs) => fs.rm(temporary, { force: true })).catch(() => {});
      throw error;
    }
    return { path: relativePath, bytes, hash: hashText(content) };
  }

  async listFiles(options = {}) {
    const start = await this.resolvePath(options.path ?? '.', { mustExist: true });
    const startRelative = this.relativePath(start);
    const maxFiles = Math.min(this.maxInventoryFiles, Math.max(1, options.maxFiles ?? 300));
    const maxDepth = Math.min(this.maxInventoryDepth, Math.max(0, options.maxDepth ?? 4));
    const result = [];
    const queue = [{ absolute: start, relative: startRelative === '.' ? '' : startRelative, depth: 0 }];
    while (queue.length && result.length < maxFiles) {
      const current = queue.shift();
      if (current.depth > maxDepth) continue;
      const entries = await readdir(current.absolute, { withFileTypes: true }).catch(() => []);
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        if (this.#shouldIgnore(entry.name, entry.isDirectory())) continue;
        const path = current.relative ? `${current.relative}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          queue.push({ absolute: join(current.absolute, entry.name), relative: path, depth: current.depth + 1 });
        } else if (entry.isFile()) {
          const absolute = join(current.absolute, entry.name);
          const info = await stat(absolute).catch(() => null);
          if (info) result.push({ path, size: info.size, extension: extname(entry.name).toLowerCase(), mtimeMs: info.mtimeMs });
        }
        if (result.length >= maxFiles) break;
      }
    }
    return { files: result, truncated: queue.length > 0 || result.length >= maxFiles };
  }

  async inventory(options = {}) {
    const listing = await this.listFiles({ maxFiles: options.maxFiles ?? this.maxInventoryFiles, maxDepth: options.maxDepth ?? this.maxInventoryDepth });
    const signals = listing.files.filter((entry) => isProjectSignal(entry.path));
    const totalBytes = listing.files.reduce((sum, entry) => sum + entry.size, 0);
    return {
      root: this.root,
      files: listing.files.map((entry) => entry.path),
      signals: signals.map((entry) => entry.path),
      fileCount: listing.files.length,
      totalBytes,
      truncated: listing.truncated,
    };
  }

  async search(query, options = {}) {
    const needle = String(query ?? '');
    if (!needle || needle.length > 500) throw new ToolError('Search query must contain 1 to 500 characters.');
    let regex;
    if (options.regex) {
      try { regex = new RegExp(needle, options.caseSensitive ? '' : 'i'); }
      catch (error) { throw new ToolError(`Invalid search expression: ${error.message}`); }
    }
    const inventory = await this.listFiles({ path: options.path ?? '.', maxFiles: options.maxFiles ?? 2_000, maxDepth: options.maxDepth ?? 8 });
    const cap = Math.min(500, Math.max(1, Number(options.limit) || 80));
    const results = [];
    const literal = options.caseSensitive ? needle : needle.toLocaleLowerCase();
    for (const file of inventory.files) {
      if (results.length >= cap || !isTextFile(file.path) || isSensitiveProjectPath(file.path)) continue;
      if (file.size > (options.maxFileBytes ?? 500_000)) continue;
      const absolute = await this.resolvePath(file.path, { mustExist: true }).catch(() => null);
      if (!absolute || isSensitiveProjectPath(this.relativePath(absolute))) continue;
      const text = await readFile(absolute, 'utf8').catch(() => '');
      if (text.includes('\u0000')) continue;
      const lines = text.split(/\r?\n/);
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index];
        const matched = regex ? regex.test(line) : (options.caseSensitive ? line : line.toLocaleLowerCase()).includes(literal);
        if (regex) regex.lastIndex = 0;
        if (matched) results.push({ path: file.path, line: index + 1, text: truncateText(line.trim(), options.lineChars ?? 400) });
        if (results.length >= cap) break;
      }
    }
    return { matches: results, truncated: inventory.truncated || results.length >= cap };
  }

  relativePath(absolute) {
    const relativePath = relative(this.root, absolute);
    return relativePath || '.';
  }

  async fileMetadata(input) {
    const full = await this.resolvePath(input, { mustExist: true });
    if (isSensitiveProjectPath(this.relativePath(full))) throw new ToolError('Reading credential or private-key files is blocked.');
    const [info, content] = await Promise.all([stat(full), readFile(full)]);
    return {
      path: this.relativePath(full),
      size: info.size,
      modifiedAt: info.mtime.toISOString(),
      sha256: createHash('sha256').update(content).digest('hex'),
    };
  }

  async diffText(input, before, after) {
    const path = String(input).replaceAll('\\', '/');
    const left = String(before ?? '').split(/\r?\n/);
    const right = String(after ?? '').split(/\r?\n/);
    const ops = computeLineDiff(left, right);
    return [`--- a/${path}`, `+++ b/${path}`, ...ops].join('\n');
  }

  async #assertWritableAncestors(full) {
    let ancestor = dirname(full);
    while (ancestor !== dirname(ancestor)) {
      try {
        const actual = await realpath(ancestor);
        this.#assertWithinRoot(actual, 'Symbolic link points outside the project.');
        return;
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        ancestor = dirname(ancestor);
      }
    }
  }

  #assertWithinRoot(actual, message) {
    const rel = relative(this.rootRealPath ?? this.root, actual);
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new ToolError(message);
  }

  #shouldIgnore(name, isDirectory) {
    if (this.ignored.has(name)) return true;
    if (name.startsWith('.env') && !name.endsWith('.example')) return true;
    if (!this.includeHidden && name.startsWith('.') && name.length > 1 && name !== '.github' && name !== '.claude') {
      if (isDirectory) return false;
      // Keep common project configuration files visible without including arbitrary dotfiles.
      const knownConfig = new Set(['.gitignore', '.gitattributes', '.gitmodules', '.dockerignore', '.npmrc', '.nvmrc', '.editorconfig', '.prettierrc', '.prettierignore', '.eslintignore', '.eslintrc', '.env.example']);
      if (!knownConfig.has(name)) return true;
    }
    if (isDirectory && name.toLowerCase() === 'test-results') return true;
    return false;
  }
}

export function hashText(text) {
  return createHash('sha256').update(String(text)).digest('hex');
}

export function isTextFile(path) {
  const name = basename(path).toLowerCase();
  if (name === 'dockerfile' || name === 'makefile' || name === 'justfile') return true;
  if (name.startsWith('.env') && name.endsWith('.example')) return true;
  return DEFAULT_TEXT_EXTENSIONS.has(extname(name));
}

export function isSensitiveProjectPath(path) {
  const normalized = String(path).replaceAll('\\', '/').toLowerCase();
  const segments = normalized.split('/');
  const base = segments.at(-1) ?? '';
  if (base === '.env.example' || base === '.env.sample') return false;
  if (base.startsWith('.env')) return true;
  if (segments.some((segment) => ['.git', '.forgeflow', '.ssh', '.aws', '.azure', '.gcloud'].includes(segment))) return true;
  if (/^(?:credentials?|secrets?)(?:\.(?:json|ya?ml|toml|xml))?$/i.test(base)) return true;
  if (/^(?:private[-_]?key|client[-_]?secret)(?:\.(?:json|ya?ml|toml))?$/i.test(base)) return true;
  if (['id_rsa', 'id_ed25519', 'id_ecdsa', 'known_hosts'].includes(base)) return true;
  return ['.pem', '.p12', '.pfx', '.key'].includes(extname(base));
}

export function isProjectSignal(path) {
  const name = basename(path).toLowerCase();
  return [
    'package.json', 'pnpm-lock.yaml', 'yarn.lock', 'package-lock.json',
    'pyproject.toml', 'requirements.txt', 'cargo.toml', 'go.mod',
    'pom.xml', 'build.gradle', 'readme.md', 'agents.md', 'claude.md',
    'makefile', 'dockerfile', 'composer.json', 'gemfile', 'mix.exs',
  ].includes(name);
}

export function computeLineDiff(beforeLines, afterLines, options = {}) {
  const left = beforeLines;
  const right = afterLines;
  const maxCells = options.maxCells ?? 1_000_000;
  if (left.length * right.length > maxCells) return coarseLineDiff(left, right);
  const matrix = Array.from({ length: left.length + 1 }, () => new Uint32Array(right.length + 1));
  for (let i = left.length - 1; i >= 0; i -= 1) {
    for (let j = right.length - 1; j >= 0; j -= 1) {
      matrix[i][j] = left[i] === right[j] ? matrix[i + 1][j + 1] + 1 : Math.max(matrix[i + 1][j], matrix[i][j + 1]);
    }
  }
  const output = [];
  let i = 0; let j = 0;
  let oldLine = 1; let newLine = 1;
  while (i < left.length || j < right.length) {
    if (i < left.length && j < right.length && left[i] === right[j]) {
      output.push(` ${left[i]}`); i += 1; j += 1; oldLine += 1; newLine += 1;
    } else if (j < right.length && (i >= left.length || matrix[i][j + 1] >= matrix[i + 1][j])) {
      output.push(`+${right[j]}`); j += 1; newLine += 1;
    } else {
      output.push(`-${left[i]}`); i += 1; oldLine += 1;
    }
  }
  return [`@@ -1,${oldLine - 1} +1,${newLine - 1} @@`, ...output];
}

function coarseLineDiff(left, right) {
  const prefix = [];
  const suffix = [];
  let start = 0;
  while (start < left.length && start < right.length && left[start] === right[start]) {
    prefix.push(` ${left[start]}`); start += 1;
  }
  let i = left.length - 1; let j = right.length - 1;
  while (i >= start && j >= start && left[i] === right[j]) { suffix.unshift(` ${left[i]}`); i -= 1; j -= 1; }
  const body = [...prefix, ...left.slice(start, i + 1).map((line) => `-${line}`), ...right.slice(start, j + 1).map((line) => `+${line}`), ...suffix];
  return [`@@ -1,${left.length} +1,${right.length} @@`, ...body];
}
