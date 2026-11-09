import test from 'node:test';
import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { withTimeout, mapLimit } from '../src/async.mjs';

test('cancellation settles even when an operation ignores its signal', { timeout: 2000 }, async () => {
  for (const timeout of [0, 10_000]) {
    const controller = new AbortController();
    const reason = new Error('Cancelled by caller');
    let requestSignal;
    const result = withTimeout((signal) => {
      requestSignal = signal;
      return new Promise(() => {});
    }, timeout, controller.signal);
    await Promise.resolve();
    controller.abort(reason);
    await assert.rejects(result, (error) => error === reason);
    assert.equal(requestSignal.aborted, true);
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  }
});

test('pre-cancelled operations are never started', async () => {
  const controller = new AbortController();
  controller.abort(new Error('Already cancelled'));
  let calls = 0;
  await assert.rejects(withTimeout(() => { calls++; }, 100, controller.signal), /Already cancelled/);
  assert.equal(calls, 0);
});

test('synchronous failures clean up listeners and preserve their cause', async () => {
  const controller = new AbortController();
  const reason = new Error('Synchronous failure');
  await assert.rejects(withTimeout(() => { throw reason; }, 10_000, controller.signal), (error) => error === reason);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('deadline aborts the child and rejects non-cooperative operations', { timeout: 2000 }, async () => {
  let requestSignal;
  await assert.rejects(withTimeout((signal) => {
    requestSignal = signal;
    return new Promise(() => {});
  }, 10), { code: 'TIMEOUT' });
  assert.equal(requestSignal.aborted, true);
});

test('mapLimit rejects invalid limits instead of returning empty result slots', async () => {
  for (const limit of [0, -1, NaN, Infinity, 1.5, '2']) {
    await assert.rejects(mapLimit([1], limit, (value) => value), RangeError);
  }
});

test('mapLimit preserves input order and bounds active operations', async () => {
  let active = 0;
  let peak = 0;
  const result = await mapLimit([1, 2, 3, 4], 2, async (value) => {
    peak = Math.max(peak, ++active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active--;
    return value * 2;
  });
  assert.deepEqual(result, [2, 4, 6, 8]);
  assert.equal(peak, 2);
});
