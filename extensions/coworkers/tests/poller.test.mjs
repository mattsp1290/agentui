import assert from 'node:assert/strict';
import test from 'node:test';
import { createPoller, IDLE_DELAYS_MS, MAX_DELAY_MS } from '../dist/poller.js';

/** A manual clock: `advance(ms)` runs every timer that falls due, in order. */
function fakeClock() {
  let now = 0, next = 0;
  const timers = new Map();
  return {
    setTimeout(callback, ms) { const id = ++next; timers.set(id, { at: now + ms, callback }); return id; },
    clearTimeout(id) { timers.delete(id); },
    async advance(ms) {
      const end = now + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
        if (!due) break;
        timers.delete(due[0]); now = due[1].at; due[1].callback();
        for (let turn = 0; turn < 20; turn++) await Promise.resolve();
      }
      now = end;
      for (let turn = 0; turn < 20; turn++) await Promise.resolve();
    },
  };
}

test('50 idle conversations settle at or below 50 reads per 300 seconds with at most 4 requests in flight', async () => {
  const clock = fakeClock(), poller = createPoller({ clock });
  let reads = 0;
  const handles = Array.from({ length: 50 }, () => poller.schedule(() => poller.limit(async () => { reads++; await Promise.resolve(); return 'idle'; })));
  await clock.advance(IDLE_DELAYS_MS.reduce((sum, ms) => sum + ms, 0) + 1);
  const settled = reads;
  await clock.advance(300_000);
  assert.ok(reads - settled <= 50, `${reads - settled} reads in 300 seconds`);
  assert.ok(poller.stats().maxInFlight <= 4);
  handles.forEach(handle => handle.stop());
  const stopped = reads;
  await clock.advance(MAX_DELAY_MS * 2);
  assert.equal(reads, stopped, 'stop ends polling');
});

test('active conversations poll every second, wake polls at once and failures back off to 300 seconds', async () => {
  const clock = fakeClock(), poller = createPoller({ clock });
  let result = 'active', polls = 0;
  const handle = poller.schedule(async () => { polls++; return result; });
  await clock.advance(0); assert.equal(polls, 1);
  await clock.advance(1000); assert.equal(polls, 2);
  result = 'failed';
  await clock.advance(1000); assert.equal(polls, 3);
  await clock.advance(1999); assert.equal(polls, 3, 'a failed poll doubles the delay');
  await clock.advance(1); assert.equal(polls, 4);
  for (let step = 0; step < 12; step++) await clock.advance(MAX_DELAY_MS);
  const before = polls;
  await clock.advance(MAX_DELAY_MS); assert.equal(polls - before, 1, 'failure backoff caps at 300 seconds');
  handle.wake(); await clock.advance(0); assert.equal(polls, before + 2, 'wake polls at once');
  handle.stop();
});

test('the in-flight limit queues work beyond four requests', async () => {
  const poller = createPoller();
  const gates = [], started = [];
  const tasks = Array.from({ length: 6 }, (_, index) => poller.limit(() => { started.push(index); return new Promise(resolve => gates.push(resolve)); }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(started.length, 4);
  gates.shift()(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(started.length, 5);
  while (gates.length) { gates.shift()(); await new Promise(resolve => setImmediate(resolve)); }
  await Promise.all(tasks);
  assert.equal(poller.stats().maxInFlight, 4);
});
