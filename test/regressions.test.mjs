import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProjectWorkspace } from '../src/workspace.mjs';
import { RunStore, createRunId } from '../src/run-store.mjs';
import { Provider } from '../src/provider.mjs';

async function workspace(t) {
  const root = await mkdtemp(join(process.env.FORGEFLOW_TEST_TMP ?? tmpdir(), 'forgeflow-regression-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, project: await new ProjectWorkspace(root, { includeHidden: true }).initialize() };
}

test('search excludes credential content but still finds ordinary source and env examples', async (t) => {
  const { root, project } = await workspace(t);
  await mkdir(join(root, '.ssh'));
  for (const name of ['credentials.json', 'secrets.yml', '.ssh/config.json', '.env', 'main.mjs', '.env.example']) {
    await writeFile(join(root, name), 'regression-marker');
  }
  const result = await project.search('regression-marker');
  assert.deepEqual(result.matches.map(x => x.path).sort(), ['.env.example', 'main.mjs']);
  const scoped = await project.search('regression-marker', { path: '.ssh' });
  assert.deepEqual(scoped.matches, []);
});

test('file metadata follows the same sensitive-file boundary as readText', async (t) => {
  const { root, project } = await workspace(t);
  await writeFile(join(root, 'secrets.json'), 'private fixture');
  await assert.rejects(project.fileMetadata('secrets.json'), /blocked/);
});

test('search checks resolved aliases as well as listed names', async (t) => {
  const { root, project } = await workspace(t);
  await writeFile(join(root, 'secrets.json'), 'regression-marker');
  try { await symlink(join(root, 'secrets.json'), join(root, 'alias.json')); }
  catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) return t.skip('Symlink creation unavailable on this runner');
    throw error;
  }
  await assert.rejects(project.readText('alias.json'), /blocked/);
  assert.deepEqual((await project.search('regression-marker')).matches, []);
});

test('run IDs cannot escape or select filesystem paths', () => {
  for (const value of ['../outside', '..', '.', '/tmp/run', 'C:\\run', 'a/b', 'a\\b', '', 'a'.repeat(129), null]) {
    assert.throws(() => new RunStore('.', value), /Run ID/);
  }
  assert.doesNotThrow(() => new RunStore('.', createRunId()));
  assert.doesNotThrow(() => new RunStore('.', 'run_test-42'));
});

test('initialize preserves a corrupt checkpoint rather than overwriting it', async (t) => {
  const { root } = await workspace(t);
  const store = new RunStore(root, 'corrupt');
  await mkdir(store.root, { recursive: true });
  await writeFile(store.statePath, '{truncated');
  await assert.rejects(store.initialize({ prompt: 'replacement' }), SyntaxError);
  assert.equal(await readFile(store.statePath, 'utf8'), '{truncated');
});

test('new checkpoints can still be initialized and resumed', async (t) => {
  const { root } = await workspace(t);
  const store = new RunStore(root, 'new-run');
  await store.initialize({ prompt: 'original' });
  assert.equal((await store.initialize({ prompt: 'replacement' })).prompt, 'original');
});

test('provider cancellation remains connected while reading a stalled response body', { timeout: 1000 }, async (t) => {
  const original = globalThis.fetch;
  const controller = new AbortController();
  t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async (_url, { signal }) => {
    const stalled = () => new Promise((_resolve, reject) => {
      if (signal.aborted) reject(signal.reason);
      else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
    return { ok: true, text: stalled, json: stalled };
  };
  const provider = new Provider({ keys: ['fixture-key'], baseUrl: 'http://127.0.0.1', model: 'fixture' }, { timeoutMs: 500, requestsPerMinute: 0 });
  const timer = setTimeout(() => controller.abort(new Error('stop body')), 30);
  try {
    await assert.rejects(provider.chat([{ role: 'user', content: 'hello' }], [], controller.signal), /stop body/);
    assert.equal(provider.metrics.tokenBudget.reservedTokens, 0);
  } finally { clearTimeout(timer); }
});


test('listing ignores stray directories with invalid run IDs', async (t) => {
  const { root } = await workspace(t);
  const store = new RunStore(root, 'valid-run');
  await store.initialize({ prompt: 'original' });
  await mkdir(join(root, '.forgeflow', 'runs', 'invalid.run'));
  assert.equal((await RunStore.list(root)).length, 1);
});

test('provider timeout aborts a stalled response body before retry backoff', { timeout: 1000 }, async (t) => {
  const original = globalThis.fetch;
  const controller = new AbortController();
  let timedOut = false;
  t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async (_url, { signal }) => {
    const stalled = () => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => {
        timedOut = signal.reason?.code === 'TIMEOUT';
        reject(signal.reason);
      }, { once: true });
    });
    return { ok: true, text: stalled, json: stalled };
  };
  const provider = new Provider({ keys: ['fixture-key'], baseUrl: 'http://127.0.0.1', model: 'fixture' }, { timeoutMs: 10, requestsPerMinute: 0 });
  const timer = setTimeout(() => controller.abort(new Error('stop retry')), 80);
  try {
    await assert.rejects(provider.chat([{ role: 'user', content: 'hello' }], [], controller.signal), /stop retry/);
    assert.equal(timedOut, true);
  } finally { clearTimeout(timer); }
});
