import { readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const files = await collectJavaScript(join(root, 'src'));
files.push(join(root, 'bin', 'forgeflow.mjs'));
let failures = 0;

for (const file of files.sort()) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8', windowsHide: true });
  if (result.status === 0) {
    process.stdout.write(`✓ ${file.slice(root.length + 1)}\n`);
    continue;
  }
  failures += 1;
  process.stderr.write(`✗ ${file.slice(root.length + 1)}\n${result.stderr || result.error?.message || 'Syntax check failed.'}\n`);
}

process.stdout.write(`\nChecked ${files.length} JavaScript module(s); ${failures} failure(s).\n`);
if (failures) process.exitCode = 1;

async function collectJavaScript(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.forgeflow') continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await collectJavaScript(path));
    else if (entry.isFile() && entry.name.endsWith('.mjs')) result.push(path);
  }
  return result;
}
