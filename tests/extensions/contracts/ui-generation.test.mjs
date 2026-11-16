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
  const source = onceFields({ modules, overrides: undefined, dispose() { assert.equal(this, source); disposals++; } }, reads);
  const active = await createUiExtensionGeneration({ ...options, activate({ frontendTools }) { frontendTools.add(tool); return source; } });
  assert.deepEqual(reads, { dispose: 1, modules: 1, overrides: 1 });
  assert.deepEqual(nested, { id: 1, label: 1, component: 1, actions: 1, children: 1 });
  assert.deepEqual(actionReads, { id: 1, label: 1, run: 1 });
  assert.deepEqual(Object.keys(active.presentation).sort(), ['modules', 'transcript']);
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

for (const field of ['modules', 'overrides', 'dispose']) test(`throwing ${field} getter is read once with only acquired cleanup`, async () => {
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
