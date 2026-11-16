import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { createFrontendToolGeneration } from '@agentui/sdk/tools';

const defaults = { namespace: 'fixture', generation: 'one', platform: 'desktop', activate: () => ({ dispose() {} }), accept: value => value };
const tool = { definition: { name: 'echo', description: 'Echo' }, decodeInput: value => value, async execute() { return 'ok'; } };
const outcome = promise => promise.then(value => ({ value }), error => ({ error }));

test('successful creation never reads the failure observer', async () => {
  const active = await createFrontendToolGeneration({ ...defaults, get onFailure() { throw new Error('Unexpected observer lookup'); } });
  await active.generation.retire();
});

for (const [field, value] of [['namespace', 'bad.name'], ['generation', ''], ['platform', 'server'], ['activate', null], ['accept', null]]) {
  test(`invalid ${field} notifies once with the final primary failure`, async () => {
    const failures = [];
    const result = await outcome(createFrontendToolGeneration({ ...defaults, [field]: value, onFailure: error => { failures.push(error); } }));
    assert.ok(result.error instanceof Error); assert.deepEqual(failures, [result.error]);
  });
}

for (const field of ['namespace', 'generation', 'platform', 'activate', 'accept']) {
  test(`throwing ${field} option getter preserves identity and notifies once`, async () => {
    const primary = new Error(`Bad ${field}`), failures = []; let reads = 0;
    const options = Object.defineProperty({ ...defaults, onFailure: error => { failures.push(error); } }, field, { get() { reads++; throw primary; } });
    assert.deepEqual(await outcome(createFrontendToolGeneration(options)), { error: primary });
    assert.deepEqual(failures, [primary]); assert.equal(reads, 1);
  });
}

for (const stage of ['activation', 'lifetime', 'acceptance']) test(`${stage} failure notifies with original identity and only acquired disposal`, async () => {
  const primary = new AggregateError(['nested cause'], 'Original aggregate'), failures = []; let disposals = 0;
  const options = { ...defaults, activate() {
    assert.equal(this, options);
    if (stage === 'activation') return Promise.reject(primary);
    if (stage === 'lifetime') return { get dispose() { throw primary; } };
    return { dispose() { disposals++; } };
  }, accept() { return Promise.reject(primary); }, onFailure(error) { failures.push(error); assert.equal(disposals, 0); } };
  assert.deepEqual(await outcome(createFrontendToolGeneration(options)), { error: primary });
  assert.deepEqual(failures, [primary]); assert.equal(disposals, stage === 'acceptance' ? 1 : 0);
});

for (const lifetime of [undefined, null, {}, { dispose: false }]) test(`invalid lifetime ${JSON.stringify(lifetime)} notifies without acceptance`, async () => {
  const failures = []; let accepted = 0;
  const result = await outcome(createFrontendToolGeneration({ ...defaults, activate: () => lifetime,
    accept() { accepted++; }, onFailure: error => { failures.push(error); } }));
  assert.ok(result.error instanceof Error); assert.deepEqual(failures, [result.error]); assert.equal(accepted, 0);
});

for (const primary of [undefined, null, 0, 'rejected']) test(`non-Error failure ${String(primary)} is rethrown unchanged`, async () => {
  const failures = [];
  assert.deepEqual(await outcome(createFrontendToolGeneration({ ...defaults, activate() { throw primary; }, onFailure: error => { failures.push(error); } })), { error: primary });
  assert.deepEqual(failures, [primary]);
});

for (const precedence of ['activation', 'lifetime', 'registration']) test(`sticky registration preserves ${precedence} precedence and closes registration`, async () => {
  const activation = Promise.withResolvers(), failures = []; let registration, sink, disposed = 0, accepted = 0;
  const primary = new Error(precedence);
  const completion = outcome(createFrontendToolGeneration({ ...defaults, async activate({ frontendTools }) {
    sink = frontendTools;
    try { frontendTools.add({ ...tool, definition: { name: 'bad.name', description: '' } }); } catch (error) { registration = error; }
    await activation.promise;
    if (precedence === 'activation') throw primary;
    if (precedence === 'lifetime') return { get dispose() { throw primary; } };
    return { dispose() { disposed++; } };
  }, accept() { accepted++; throw new Error('Acceptance must not run'); }, onFailure(error) {
    failures.push(error); assert.throws(() => sink.add(tool), /registration is closed/);
  } }));
  await setImmediate(); assert.deepEqual(failures, []); assert.equal(disposed, 0);
  activation.resolve();
  const expected = precedence === 'registration' ? registration : primary;
  assert.deepEqual(await completion, { error: expected }); assert.deepEqual(failures, [expected]);
  assert.equal(accepted, 0); assert.equal(disposed, precedence === 'registration' ? 1 : 0);
});

for (const observer of ['absent', 'success', 'throw', 'reject', 'getter']) for (const cleanupFails of [false, true]) {
  test(`${observer} observer with ${cleanupFails ? 'rejected' : 'resolved'} cleanup retains every cause`, async () => {
    const primary = new AggregateError(['nested'], 'Primary'), observerError = new Error('Observer'), disposeError = new Error('Disposal');
    const cleanup = Promise.withResolvers(), events = [], unhandled = []; let reads = 0;
    const observe = error => unhandled.push(error); process.on('unhandledRejection', observe);
    try {
      const options = { ...defaults, activate: () => ({ dispose() { events.push('dispose'); return cleanup.promise; } }), accept() { throw primary; } };
      if (observer !== 'absent') Object.defineProperty(options, 'onFailure', { get() {
        reads++; if (observer === 'getter') throw observerError;
        return error => { assert.equal(error, primary); events.push('notify');
          if (observer === 'throw') throw observerError;
          if (observer === 'reject') return Promise.reject(observerError);
        };
      } });
      let settled = false;
      const completion = outcome(createFrontendToolGeneration(options)).then(result => { settled = true; return result; });
      await setImmediate();
      assert.deepEqual(events, observer === 'absent' || observer === 'getter' ? ['dispose'] : ['notify', 'dispose']);
      assert.equal(settled, false); assert.equal(reads, observer === 'absent' ? 0 : 1);
      if (cleanupFails) cleanup.reject(disposeError); else cleanup.resolve();
      const { error } = await completion;
      const observerFails = ['throw', 'reject', 'getter'].includes(observer);
      if (!observerFails && !cleanupFails) assert.equal(error, primary);
      else {
        assert.ok(error instanceof AggregateError);
        assert.deepEqual(error.errors, [primary, ...(observerFails ? [observerError] : []), ...(cleanupFails ? [disposeError] : [])]);
        if (!observerFails) assert.equal(error.message, 'Tool activation failed and its disposal also failed');
      }
      await setImmediate(); assert.deepEqual(unhandled, []);
    } finally { process.off('unhandledRejection', observe); }
  });
}

for (const observerFails of [false, true]) test(`pending observer starts cleanup immediately and final completion awaits its ${observerFails ? 'rejection' : 'resolution'}`, async () => {
  const notification = Promise.withResolvers(), primary = new Error('Primary'), secondary = new Error('Observer'), events = [];
  let settled = false;
  const completion = outcome(createFrontendToolGeneration({ ...defaults,
    activate: () => ({ dispose() { events.push('dispose'); } }), accept() { throw primary; },
    onFailure(error) { assert.equal(error, primary); events.push('notify'); return notification.promise; },
  })).then(result => { settled = true; return result; });
  await setImmediate(); assert.deepEqual(events, ['notify', 'dispose']); assert.equal(settled, false);
  if (observerFails) notification.reject(secondary); else notification.resolve();
  const { error } = await completion;
  if (observerFails) { assert.ok(error instanceof AggregateError); assert.deepEqual(error.errors, [primary, secondary]); }
  else assert.equal(error, primary);
});
