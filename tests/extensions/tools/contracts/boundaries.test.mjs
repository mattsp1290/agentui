import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { validateExtensionLifetime } from '@agentui/sdk';
import { createFrontendToolGeneration, pinFrontendTools } from '@agentui/sdk/tools';

const run = {
  conversation: { hostId: 'h', conversationId: 'c' }, runId: 'r',
  authority: { kind: 'agentui-host', hostId: 'h',
    binding: { namespace: 'n', installationId: 'i', opaqueSessionId: 's' } },
};
const capabilities = { tools: { clientProvided: true } };
const pin = (generations, overrides = {}) =>
  pinFrontendTools({ generations, platform: 'desktop', run, capabilities, ...overrides });
const activate = options => createFrontendToolGeneration({
  namespace: 'demo', generation: '1', platform: 'desktop',
  accept: value => { validateExtensionLifetime(value); return value; },
  activate({ frontendTools }) {
    frontendTools.add({ definition: { name: 'x', description: 'x' },
      decodeInput: value => value, async execute() { return 'ok'; } });
    return { dispose() {} };
  },
  ...options,
});

test('agent name collisions reject before acquiring any generation references', async () => {
  const disposed = [];
  const generations = [];
  for (const namespace of ['first', 'demo']) {
    const result = await activate({ namespace, accept(value) {
      validateExtensionLifetime(value);
      value.dispose = () => { throw Error('captured disposer replaced'); };
      return value;
    }, activate({ frontendTools }) {
      frontendTools.add({ definition: { name: 'x', description: 'x' },
        decodeInput: value => value, async execute() { return 'ok'; } });
      return { dispose() { disposed.push(namespace); } };
    } });
    generations.push(result.generation);
  }
  let snapshot;
  try {
    assert.throws(() => { snapshot = pin(generations, {
      capabilities: { tools: { clientProvided: true, items: [{ name: 'demo__x', description: 'agent' }] } },
    }); }, /collides with an agent-provided tool/u);
  } finally {
    snapshot?.release();
    const retired = generations.map(generation => generation.retire());
    await setImmediate();
    assert.deepEqual(disposed, ['first', 'demo']);
    await Promise.all(retired);
  }
});

for (const gate of [{ clientProvided: false }, { clientProvided: true, supported: false }]) {
  test(`disabled pins ignore agent collisions with ${JSON.stringify(gate)}`, async () => {
    const { generation } = await activate();
    const snapshot = pin([generation], { capabilities: { tools: {
      ...gate, items: [{ name: 'demo__x', description: 'agent' }],
    } } });
    try {
      assert.deepEqual(snapshot.definitions, []);
      assert.equal((await snapshot.invoke('demo__x', {})).code, 'unknown-tool');
      await generation.retire();
    } finally { snapshot.release(); await generation.retire(); }
  });
}

for (const source of ['items getter', 'item name getter']) {
  test(`pin refuses retirement during agent ${source}`, async () => {
    let disposed = 0;
    const { generation } = await activate({ activate() { return { dispose() { disposed++; } }; } });
    let retired;
    const retire = () => { retired ??= generation.retire(); };
    const tools = source === 'items getter'
      ? { clientProvided: true, get items() { retire(); return []; } }
      : { clientProvided: true, items: [{ get name() { retire(); return 'agent'; }, description: 'agent' }] };
    let snapshot;
    try { assert.throws(() => { snapshot = pin([generation], { capabilities: { tools } }); }, /Invalid or retired/u); }
    finally { snapshot?.release(); await (retired ?? generation.retire()); }
    assert.equal(disposed, 1);
  });
}

test('pins do not retain a zero-tool generation while another generation serves calls', async () => {
  let disposed = 0;
  const empty = (await activate({ namespace: 'empty', activate() { return { dispose() { disposed++; } }; } })).generation;
  const { generation } = await activate();
  const snapshot = pin([empty, generation]);
  const retired = empty.retire();
  try {
    await setImmediate();
    assert.equal(disposed, 1);
    await retired;
    assert.equal((await snapshot.invoke('demo__x', {})).kind, 'completed');
  } finally { snapshot.release(); await Promise.all([retired, generation.retire()]); }
});

test('factory supplies an immutable context correlated with the validated namespace', async () => {
  let context;
  const { generation } = await activate({ namespace: 'validated-name', activate(value) {
    context = value;
    assert.ok(Object.isFrozen(value));
    assert.ok(Object.isFrozen(value.frontendTools));
    assert.throws(() => { value.namespace = 'wrong'; }, TypeError);
    value.frontendTools.add({ definition: { name: 'x', description: 'x' },
      decodeInput: input => input, async execute() { return 'ok'; } });
    return { dispose() {} };
  } });
  const snapshot = pin([generation]);
  try {
    assert.equal(context.namespace, generation.namespace);
    assert.equal(snapshot.definitions[0].name, `${context.namespace}__x`);
  } finally { snapshot.release(); await generation.retire(); }
});

for (const asyncAccept of [false, true]) {
  test(`${asyncAccept ? 'async' : 'sync'} acceptance returns decoded contributions and preserves raw disposer ownership`, async () => {
    let reads = 0;
    let disposed = 0;
    let escaped;
    const raw = { get dispose() {
      reads++;
      return function () { assert.equal(this, raw); disposed++; };
    } };
    const decoded = { modules: ['decoded'], get dispose() { throw Error('decoded disposal must not be read'); } };
    const decode = value => {
      assert.equal(value, raw);
      assert.equal(reads, 1);
      assert.throws(() => escaped.add({}), /registration is closed/u);
      return decoded;
    };
    const result = await activate({
      activate({ frontendTools }) {
        escaped = frontendTools;
        frontendTools.add({ definition: { name: 'x', description: 'x' },
          decodeInput: value => value, async execute() { return 'accepted tool'; } });
        return raw;
      },
      accept: asyncAccept ? async value => { await setImmediate(); return decode(value); } : decode,
    });
    assert.equal(result.contributions, decoded);
    assert.deepEqual(result.contributions.modules, ['decoded']);
    const snapshot = pin([result.generation]);
    try {
      assert.deepEqual(await snapshot.invoke('demo__x', {}), { kind: 'completed', output: 'accepted tool' });
    } finally { snapshot.release(); await result.generation.retire(); }
    assert.equal(reads, 1);
    assert.equal(disposed, 1);
  });
}

test('async acceptance rejection is awaited and cleans up without an unhandled rejection', async () => {
  const rejection = Error('async acceptance failed');
  const unhandled = [];
  const observe = error => unhandled.push(error);
  let disposed = 0;
  process.on('unhandledRejection', observe);
  try {
    await assert.rejects(activate({
      activate() { return { dispose() { disposed++; } }; },
      async accept() { await setImmediate(); throw rejection; },
    }), error => error === rejection);
    await setImmediate();
    assert.equal(disposed, 1);
    assert.deepEqual(unhandled, []);
  } finally { process.off('unhandledRejection', observe); }
});
