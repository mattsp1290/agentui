import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { createFrontendToolGeneration, pinFrontendTools, retainFrontendTools } from '@agentui/sdk/tools';

const run = {
  conversation: { hostId: 'h', conversationId: 'c' }, runId: 'r',
  authority: { kind: 'agentui-host', hostId: 'h', binding: { namespace: 'n', installationId: 'i', opaqueSessionId: 's' } },
};
const retain = generations => retainFrontendTools({ generations, platform: 'desktop' });
async function make({ namespace = 'demo', platform = 'desktop', dispose = () => {}, tools } = {}) {
  return (await createFrontendToolGeneration({ namespace, generation: '1', platform, capture: () => undefined,
    activate({ frontendTools }) {
      for (const tool of tools ?? [{ definition: { name: 'x', description: 'original' }, decodeInput: x => x, async execute() { return 'original'; } }]) frontendTools.add(tool);
      return { dispose };
    },
  })).generation;
}

test('unbound retention survives retirement, preserves snapshots and shares release with its later pin', async () => {
  let disposed = 0;
  const g = await make({ dispose() { disposed++; } });
  const a = retain([g]), b = retain([g]);
  assert.equal('invoke' in a, false);
  const retired = g.retire();
  assert.throws(() => retain([g]), /retired/);
  await setImmediate(); assert.equal(disposed, 0);
  const p = a.bind(run);
  assert.equal(p.definitions, a.definitions); assert.equal(p.bindings, a.bindings);
  assert.ok(Object.isFrozen(a.definitions)); assert.ok(Object.isFrozen(a.definitions[0]));
  assert.ok(Object.isFrozen(a.bindings)); assert.ok(Object.isFrozen(a.bindings[0]));
  assert.deepEqual(await p.invoke('demo__x', {}, g.activationId), { kind: 'completed', output: 'original' });
  a.release(); p.release(); a.release();
  assert.deepEqual(await p.invoke('demo__x', {}, g.activationId), { kind: 'refused', code: 'released' });
  assert.throws(() => a.bind(run), /released/);
  await setImmediate(); assert.equal(disposed, 0);
  b.release(); b.release(); await retired; assert.equal(disposed, 1);
  assert.equal(a.definitions[0].name, 'demo__x');
});

test('complete parsed identity is copied, immutable and idempotent regardless of property order', async () => {
  const g = await make(), retained = retain([g]), input = structuredClone(run);
  try {
    const p = retained.bind(input);
    input.runId = 'mutated'; input.authority.binding.namespace = 'mutated';
    const reordered = { authority: { binding: { opaqueSessionId: 's', installationId: 'i', namespace: 'n' }, hostId: 'h', kind: 'agentui-host' }, runId: 'r', conversation: { conversationId: 'c', hostId: 'h' } };
    assert.equal(retained.bind(reordered), p);
    assert.ok(Object.isFrozen(p.run.authority.binding));
    assert.throws(() => { p.run.runId = 'mutated'; }, TypeError);
    const conflicts = [
      { ...run, runId: 'other' }, { ...run, conversation: { ...run.conversation, conversationId: 'other' } },
      { ...run, conversation: { ...run.conversation, hostId: 'other' }, authority: { ...run.authority, hostId: 'other' } },
      { ...run, authority: { kind: 'remote-provider', binding: run.authority.binding } },
      ...['namespace', 'installationId', 'opaqueSessionId'].map(field => ({ ...run, authority: { ...run.authority, binding: { ...run.authority.binding, [field]: 'other' } } })),
    ];
    for (const conflict of conflicts) assert.throws(() => retained.bind(conflict), /already bound/);
    assert.throws(() => retained.bind({ ...run, authority: { ...run.authority, hostId: 'mismatch' } }));
    assert.equal(retained.bind(run), p);
    assert.equal(p.run.runId, 'r'); assert.equal(p.run.authority.binding.namespace, 'n');
  } finally { retained.release(); await g.retire(); }
});

for (const bindFirst of [false, true]) test(`invalid and oversized binds preserve ${bindFirst ? 'bound' : 'unbound'} ownership`, async () => {
  let disposed = 0;
  const g = await make({ dispose() { disposed++; } }), retained = retain([g]);
  const p = bindFirst ? retained.bind(run) : undefined;
  const retired = g.retire();
  assert.throws(() => retained.bind({ ...run, runId: '' }));
  assert.throws(() => retained.bind({ ...run, runId: 'r'.repeat(16_000_001) }), /JSON exceeds size limit/);
  await setImmediate(); assert.equal(disposed, 0);
  const later = retained.bind(run); if (p) assert.equal(later, p);
  later.release(); retained.release(); await retired; assert.equal(disposed, 1);
});

for (const nested of ['release', 'equal', 'conflict']) test(`bind parsing cannot overwrite a reentrant ${nested}`, async () => {
  let disposed = 0, nestedPin;
  const g = await make({ dispose() { disposed++; } }), retained = retain([g]);
  const retired = g.retire();
  const proxy = new Proxy(run, { ownKeys(target) {
    if (nested === 'release') retained.release();
    else nestedPin = retained.bind(nested === 'equal' ? run : { ...run, runId: 'nested' });
    return Reflect.ownKeys(target);
  } });
  if (nested === 'equal') assert.equal(retained.bind(proxy), nestedPin);
  else assert.throws(() => retained.bind(proxy), nested === 'release' ? /released/ : /already bound/);
  if (nested === 'conflict') {
    assert.equal(retained.bind({ ...run, runId: 'nested' }), nestedPin);
    assert.deepEqual(await nestedPin.invoke('demo__x', {}, g.activationId), { kind: 'completed', output: 'original' });
  }
  retained.release(); nestedPin?.release(); await retired; assert.equal(disposed, 1);
});

test('retention validates complete candidates before holding and preserves selection order without empty holds', async () => {
  const disposed = [];
  const first = await make({ namespace: 'first', dispose() { disposed.push('first'); } });
  const second = await make({ namespace: 'second' });
  const duplicate = await make({ namespace: 'first' });
  const ios = await make({ platform: 'ios' });
  const empty = await make({ namespace: 'empty', tools: [], dispose() { disposed.push('empty'); } });
  try {
    assert.throws(() => retain([first, {}]), /Invalid or retired/);
    assert.throws(() => retain([first, duplicate]), /Duplicate tool namespace/);
    for (const generations of [[first, duplicate], [first, {}]]) assert.throws(() => pinFrontendTools({ generations, platform: 'desktop', run, capabilities: undefined }));
    const snapshot = retain([second, ios, empty, first]);
    assert.deepEqual(snapshot.definitions.map(tool => tool.name), ['second__x', 'first__x']);
    await empty.retire(); assert.deepEqual(disposed, ['empty']);
    snapshot.release();
    await first.retire(); assert.deepEqual(disposed, ['empty', 'first']);
  } finally { await Promise.all([first, second, duplicate, ios, empty].map(g => g.retire())); }
});

test('shared release drains concurrent calls including decoder release and rejected execution', async () => {
  let retained, retired, disposed = 0;
  const pending = Promise.withResolvers(), failure = new Error('execution rejected');
  const g = await make({ dispose() { disposed++; }, tools: [{ definition: { name: 'x', description: 'x' },
    decodeInput(value) { if (value.release) { retained.release(); retired = g.retire(); } return value; },
    async execute(value) { await pending.promise; if (value.reject) throw failure; return 'done'; },
  }] });
  retained = retain([g]); const p = retained.bind(run);
  const first = p.invoke('demo__x', { reject: true }, g.activationId);
  const rejected = assert.rejects(first, error => error === failure);
  const second = p.invoke('demo__x', { release: true }, g.activationId);
  p.release(); retained.release();
  await setImmediate(); assert.equal(disposed, 0);
  pending.resolve(); await rejected;
  assert.deepEqual(await second, { kind: 'completed', output: 'done' });
  await retired; assert.equal(disposed, 1);
});

test('unbound release observes one shared rejecting retirement without retry', async () => {
  let disposed = 0;
  const g = await make({ dispose() { disposed++; throw Error('cleanup rejected'); } }), retained = retain([g]);
  const retired = g.retire(), rejected = assert.rejects(retired, /cleanup rejected/);
  retained.release(); retained.release(); assert.throws(() => retained.bind(run), /released/);
  await rejected; assert.equal(g.retire(), retired); assert.equal(disposed, 1);
});

test('convenience pin reads every external option in its original order before holding', async () => {
  const events = [], g = await make();
  const options = {
    get platform() { events.push('platform'); return 'desktop'; },
    get generations() { events.push('generations'); return { *[Symbol.iterator]() { events.push('iterate'); yield g; } }; },
    get run() { events.push('run'); return new Proxy(run, { ownKeys(target) { events.push('copy run'); return Reflect.ownKeys(target); } }); },
    get capabilities() { events.push('capabilities'); return { get tools() { events.push('tools'); return {
      get clientProvided() { events.push('clientProvided'); return true; },
      get supported() { events.push('supported'); return true; },
      get items() { events.push('items'); return [{ get name() { events.push('name'); return 'agent__x'; } }]; },
    }; } }; },
  };
  const p = pinFrontendTools(options);
  assert.deepEqual(events, ['platform', 'generations', 'iterate', 'run', 'copy run', 'copy run', 'capabilities', 'tools', 'clientProvided', 'supported', 'items', 'name']);
  p.release(); await g.retire();
});

for (const platform of ['desktop', 'ios']) test(`retention refuses retired ${platform} candidates even if filtered by platform`, async () => {
  const g = await make({ platform }); await g.retire();
  assert.throws(() => retain([g]), /Invalid or retired/);
});
