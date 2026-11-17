import assert from 'node:assert/strict';
import test from 'node:test';
import { createUiExtensionGeneration } from '@agentui/sdk/react-tools';
import { pinFrontendTools } from '@agentui/sdk/tools';

const options = { namespace: 'fixture', generation: 'one', platform: 'desktop' };
const tool = { definition: { name: 'echo', description: 'Echo' }, decodeInput: value => value, async execute() { return 'captured'; } };
const run = { conversation: { hostId: 'host', conversationId: 'conversation' }, runId: 'run',
  authority: { kind: 'remote-provider', binding: { namespace: 'provider', installationId: 'i', opaqueSessionId: 's' } } };
function onceFields(fields, reads) {
  return Object.defineProperties({}, Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, {
    get() { reads[key] = (reads[key] ?? 0) + 1; if (reads[key] > 1) throw new Error(`Reread ${key}`); return value; },
  }])));
}

test('UI generation captures producer fields once and returns only nested presentation', async () => {
  const reads = {}, nested = {}, actionReads = {}; let disposals = 0;
  const action = onceFields({ id: 'send', label: 'Send', run: async () => ({ kind: 'rejected', reason: 'disabled' }) }, actionReads);
  const child = onceFields({ id: 'child', label: 'Child', component: () => null, actions: [action], children: undefined }, nested);
  const modules = [{ id: 'parent', label: 'Parent', component: () => null, children: [child] }];
  const source = onceFields({ modules, overrides: undefined, contentLayout: () => null, dispose() { assert.equal(this, source); disposals++; } }, reads);
  const active = await createUiExtensionGeneration({ ...options, activate({ frontendTools }) { frontendTools.add(tool); return source; } });
  assert.deepEqual(reads, { dispose: 1, modules: 1, overrides: 1, contentLayout: 1 });
  assert.deepEqual(nested, { id: 1, label: 1, component: 1, actions: 1, children: 1 });
  assert.deepEqual(actionReads, { id: 1, label: 1, run: 1 });
  assert.deepEqual(Object.keys(active.presentation).sort(), ['activity', 'contentLayout', 'modules', 'transcript']);
  modules.length = 0;
  assert.equal(active.presentation.modules[0].children[0].label, 'Child');
  assert.deepEqual(await active.presentation.modules[0].children[0].actions[0].run({}), { kind: 'rejected', reason: 'disabled' });
  const pin = pinFrontendTools({ generations: [active.generation], platform: 'desktop', run, capabilities: { tools: { clientProvided: true } } });
  assert.deepEqual(await pin.invoke('fixture__echo', {}, pin.bindings[0].activationId), { kind: 'completed', output: 'captured' });
  pin.release(); await active.generation.retire(); await active.generation.retire(); assert.equal(disposals, 1);
});

for (const kind of ['malformed', 'duplicate']) test(`sticky ${kind} registration rejects and disposes even when author swallows add failure`, async () => {
  let disposals = 0;
  await assert.rejects(createUiExtensionGeneration({ ...options, activate({ frontendTools }) {
    try {
      if (kind === 'duplicate') frontendTools.add(tool);
      frontendTools.add(kind === 'duplicate' ? tool : { ...tool, definition: { name: 'bad.name', description: '' } });
    } catch {}
    return { modules: [], dispose() { disposals++; } };
  } }), kind === 'duplicate' ? /Duplicate tool name/ : /Invalid tool name/);
  assert.equal(disposals, 1);
});

for (const field of ['modules', 'overrides', 'contentLayout', 'dispose']) test(`throwing ${field} getter is read once with only acquired cleanup`, async () => {
  let reads = 0, disposals = 0;
  const failure = new Error(`Bad ${field}`);
  const source = Object.defineProperty({ modules: [], dispose() { disposals++; } }, field, { get() { reads++; throw failure; } });
  await assert.rejects(createUiExtensionGeneration({ ...options, activate: () => source }), error => error === failure);
  assert.equal(reads, 1); assert.equal(disposals, field === 'dispose' ? 0 : 1);
});

test('malformed changing presentation keeps captured cleanup and preserves both rejection causes', async () => {
  let reads = 0, disposals = 0;
  const cleanup = new Error('Cleanup rejected');
  await assert.rejects(createUiExtensionGeneration({ ...options, activate() {
    return { get modules() { reads++; return reads === 1 ? null : []; }, dispose() { disposals++; return Promise.reject(cleanup); } };
  } }), error => error instanceof AggregateError && /Expected module array/.test(error.errors[0].message) && error.errors[1] === cleanup);
  assert.equal(reads, 1); assert.equal(disposals, 1);
});


test('invalid lifetime never invents cleanup or reads presentation', async () => {
  for (const value of [undefined, null, {}, { dispose: false }, { dispose: 1 }]) {
    let presentationReads = 0;
    const source = value && Object.defineProperty(value, 'modules', { get() { presentationReads++; throw new Error('Unexpected presentation read'); } });
    await assert.rejects(createUiExtensionGeneration({ ...options, activate: () => source }));
    assert.equal(presentationReads, 0);
  }
});

for (const kind of ['presentation', 'malformed', 'duplicate']) for (const rejects of [false, true]) {
  test(`UI ${kind} failure notifies before pending cleanup ${rejects ? 'rejects' : 'resolves'} without rereading producer fields`, async () => {
    const cleanup = Promise.withResolvers(), notified = Promise.withResolvers(), reads = {}, failures = [];
    const secondary = new Error('Cleanup rejected'); let disposals = 0, settled = false, registration;
    const source = onceFields({ modules: kind === 'presentation' ? null : [{ id: 'rejected', label: 'Rejected', component: () => null }], overrides: undefined,
      dispose() { assert.equal(this, source); disposals++; return cleanup.promise; } }, reads);
    const completion = createUiExtensionGeneration({ ...options, activate({ frontendTools }) {
      if (kind !== 'presentation') try {
        if (kind === 'duplicate') frontendTools.add(tool);
        frontendTools.add(kind === 'duplicate' ? tool : { ...tool, definition: { name: 'bad.name', description: '' } });
      } catch (error) { registration = error; }
      return source;
    }, onFailure(error) { failures.push(error); assert.equal(disposals, 0); notified.resolve(error); } }).then(
      value => { settled = true; return { value }; }, error => { settled = true; return { error }; });
    const primary = await notified.promise;
    await new Promise(resolve => setImmediate(resolve));
    if (kind === 'presentation') assert.match(primary.message, /Expected module array/); else assert.equal(primary, registration);
    assert.equal(settled, false); assert.equal(disposals, 1);
    assert.deepEqual(reads, kind === 'presentation' ? { dispose: 1, modules: 1, overrides: 1 } : { dispose: 1 });
    if (rejects) cleanup.reject(secondary); else cleanup.resolve();
    const result = await completion;
    assert.equal('value' in result, false);
    if (rejects) { assert.ok(result.error instanceof AggregateError); assert.deepEqual(result.error.errors, [primary, secondary]); }
    else assert.equal(result.error, primary);
    assert.deepEqual(failures, [primary]); assert.equal(disposals, 1);
    assert.deepEqual(reads, kind === 'presentation' ? { dispose: 1, modules: 1, overrides: 1 } : { dispose: 1 });
  });
}

for (const field of ['namespace', 'generation', 'platform', 'onFailure']) test(`UI pre-factory ${field} getter failure rejects without retry or activation`, async () => {
  const primary = new Error(field); let reads = 0, activated = 0, notified = 0;
  const config = Object.defineProperty({ ...options, activate() { activated++; }, onFailure() { notified++; } }, field, { get() { reads++; throw primary; } });
  await assert.rejects(createUiExtensionGeneration(config), error => error === primary);
  assert.equal(reads, 1); assert.equal(activated, 0); assert.equal(notified, 0);
});

for (const lifetime of ['missing', 'noncallable', 'throw']) test(`invalid ${lifetime} lifetime wins over sticky registration without reading presentation`, async () => {
  let registration, disposalReads = 0, presentationReads = 0;
  const failure = new Error('Lifetime getter failed'), failures = [];
  const source = { get dispose() { disposalReads++; if (lifetime === 'throw') throw failure; return lifetime === 'missing' ? undefined : false; },
    get modules() { presentationReads++; throw new Error('Unexpected presentation read'); },
    get overrides() { presentationReads++; throw new Error('Unexpected presentation read'); } };
  const result = await createUiExtensionGeneration({ ...options, activate({ frontendTools }) {
    try { frontendTools.add({ ...tool, definition: { name: 'bad.name', description: '' } }); } catch (error) { registration = error; }
    return source;
  }, onFailure(error) { failures.push(error); } }).then(() => undefined, error => error);
  assert.notEqual(result, registration);
  if (lifetime === 'throw') assert.equal(result, failure); else assert.match(result.message, /Expected extension disposal/);
  assert.deepEqual(failures, [result]); assert.equal(disposalReads, 1); assert.equal(presentationReads, 0);
});

for (const field of ['modules', 'overrides', 'contentLayout']) test(`sticky registration skips poisonous ${field} presentation and releases the acquired lifetime`, async () => {
  let registration, reads = 0, disposals = 0;
  const source = Object.defineProperty({ modules: [], dispose() { assert.equal(this, source); disposals++; } }, field, {
    get() { reads++; throw new Error('Presentation must be skipped'); },
  });
  const failures = [];
  await assert.rejects(createUiExtensionGeneration({ ...options, activate({ frontendTools }) {
    try { frontendTools.add({ ...tool, definition: { name: 'bad.name', description: '' } }); } catch (error) { registration = error; }
    return source;
  }, onFailure(error) { failures.push(error); assert.equal(disposals, 0); } }), error => error === registration);
  assert.deepEqual(failures, [registration]); assert.equal(reads, 0); assert.equal(disposals, 1);
});

for (const field of ['modules', 'overrides', 'contentLayout']) for (const caught of [false, true]) {
  test(`${field} getter sees closed registration and ${caught ? 'cannot register even when it catches the error' : 'fails creation with acquired cleanup'}`, async () => {
    let sink, registration, disposals = 0, reads = 0;
    const failures = [];
    const source = Object.defineProperty({ modules: [], dispose() { assert.equal(this, source); disposals++; } }, field, { get() {
      reads++;
      try { sink.add(tool); } catch (error) { registration = error; if (!caught) throw error; }
      return field === 'modules' ? [] : undefined;
    } });
    const creating = createUiExtensionGeneration({ ...options, activate({ frontendTools }) { sink = frontendTools; return source; },
      onFailure(error) { failures.push(error); assert.equal(disposals, 0); } });
    if (caught) {
      const active = await creating;
      const pin = pinFrontendTools({ generations: [active.generation], platform: 'desktop', run, capabilities: { tools: { clientProvided: true } } });
      try { assert.deepEqual(pin.definitions, []); assert.deepEqual(failures, []); }
      finally { pin.release(); await active.generation.retire(); }
    } else {
      await assert.rejects(creating, error => error === registration);
      assert.deepEqual(failures, [registration]);
    }
    assert.match(registration.message, /registration is closed/); assert.equal(reads, 1); assert.equal(disposals, 1);
  });
}

test('UI forwarding preserves the original options activation getter and receiver', async () => {
  let reads = 0, calls = 0, disposals = 0;
  const config = { ...options, get activate() {
    assert.equal(this, config); reads++;
    return function (context) { assert.equal(this, config); assert.equal(context.namespace, options.namespace); calls++;
      return { modules: [], dispose() { disposals++; } };
    };
  } };
  const active = await createUiExtensionGeneration(config);
  assert.equal(reads, 1); assert.equal(calls, 1); await active.generation.retire(); assert.equal(disposals, 1);
});

test('UI activation getter failure reaches core notification once without a lifetime', async () => {
  const primary = new Error('Activation getter failed'), failures = []; let reads = 0;
  const config = { ...options, get activate() { assert.equal(this, config); reads++; throw primary; }, onFailure(error) { failures.push(error); } };
  await assert.rejects(createUiExtensionGeneration(config), error => error === primary);
  assert.equal(reads, 1); assert.deepEqual(failures, [primary]);
});

for (const observer of ['sync', 'async']) for (const observerRejects of [false, true]) for (const cleanupRejects of [false, true]) {
  test(`UI class ${observer} observer keeps its receiver when observer ${observerRejects ? 'rejects' : 'completes'} and cleanup ${cleanupRejects ? 'rejects' : 'completes'}`, async () => {
    const primary = new Error('Presentation failed'), observerError = new Error('Observer failed'), cleanupError = new Error('Cleanup failed');
    const cleanup = Promise.withResolvers(), observation = Promise.withResolvers();
    let disposals = 0, settled = false;
    class Owner {
      namespace = options.namespace;
      generation = options.generation;
      platform = options.platform;
      #failures = [];
      #reads = 0;
      #completions = 0;
      get failures() { return this.#failures; }
      get reads() { return this.#reads; }
      get completions() { return this.#completions; }
      get onFailure() {
        this.#reads++;
        assert.equal(this.#reads, 1);
        return observer === 'sync' ? this.#observe : this.#observeAsync;
      }
      #record(error) { this.#failures.push(error); assert.equal(disposals, 0); }
      #complete() { this.#completions++; if (observerRejects) throw observerError; }
      #observe(error) { this.#record(error); this.#complete(); }
      async #observeAsync(error) { this.#record(error); await observation.promise; this.#complete(); }
      activate() {
        return { get modules() { throw primary; }, dispose() { disposals++; return cleanup.promise; } };
      }
    }
    const owner = new Owner();
    const completion = createUiExtensionGeneration(owner).then(
      value => { settled = true; return { value }; }, error => { settled = true; return { error }; });
    try {
      assert.equal(owner.reads, 1);
      await new Promise(resolve => setImmediate(resolve));
      assert.deepEqual(owner.failures, [primary]);
      assert.equal(owner.failures[0], primary);
      assert.equal(disposals, 1); assert.equal(settled, false);
      assert.equal(owner.completions, observer === 'sync' ? 1 : 0);
      observation.resolve();
      if (cleanupRejects) cleanup.reject(cleanupError); else cleanup.resolve();
      const result = await completion;
      assert.equal('value' in result, false);
      if (observerRejects || cleanupRejects) {
        assert.ok(result.error instanceof AggregateError);
        const causes = [primary, ...(observerRejects ? [observerError] : []), ...(cleanupRejects ? [cleanupError] : [])];
        assert.deepEqual(result.error.errors, causes);
        causes.forEach((cause, index) => assert.equal(result.error.errors[index], cause));
      } else assert.equal(result.error, primary);
      assert.deepEqual(owner.failures, [primary]);
      assert.equal(owner.reads, 1); assert.equal(owner.completions, 1); assert.equal(disposals, 1);
    } finally {
      observation.resolve(); cleanup.resolve(); await completion;
    }
  });
}
