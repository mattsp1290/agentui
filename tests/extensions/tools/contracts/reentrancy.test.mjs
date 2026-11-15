import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRunIdentity } from '@agentui/contracts';
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
async function make(dispose, overrides = {}) {
  return (await createFrontendToolGeneration({
    namespace: 'demo', generation: '1', platform: 'desktop', accept: validateExtensionLifetime,
    activate(tools) {
      tools.add({ definition: { name: 'x', description: 'x' }, decodeInput: value => value,
        async execute() { return 'ok'; }, ...overrides });
      return { dispose };
    },
  })).generation;
}

for (const source of ['capabilities getter', 'run proxy', 'generation iterator']) {
  test(`pin refuses retirement during ${source}`, async () => {
    let disposed = 0;
    let retired;
    let snapshot;
    const generation = await make(() => { disposed++; });
    const retire = () => { retired ??= generation.retire(); };
    const overrides = source === 'capabilities getter'
      ? { capabilities: { get tools() { retire(); return capabilities.tools; } } }
      : source === 'run proxy'
        ? { run: new Proxy(run, { ownKeys(target) { retire(); return Reflect.ownKeys(target); } }) }
        : { generations: { *[Symbol.iterator]() { yield generation; retire(); } } };
    try {
      assert.throws(() => { snapshot = pin([generation], overrides); }, /Invalid or retired/u);
    } finally {
      snapshot?.release();
      await (retired ?? generation.retire());
    }
    assert.equal(disposed, 1);
  });
}

test('decoder may release its pin and retire while its call retains resources', async () => {
  const events = [];
  let snapshot;
  let retired;
  let finish;
  const pending = new Promise(resolve => { finish = resolve; });
  const generation = await make(() => { events.push('disposed'); }, {
    decodeInput(value) { snapshot.release(); retired = generation.retire(); return value; },
    async execute() { await pending; events.push('execute'); return 'ok'; },
  });
  snapshot = pin([generation]);
  let call;
  try {
    call = snapshot.invoke('demo__x', {});
    await Promise.resolve();
    assert.deepEqual(events, []);
    finish();
    assert.deepEqual(await call, { kind: 'completed', output: 'ok' });
    await retired;
    assert.deepEqual(events, ['execute', 'disposed']);
  } finally {
    finish();
    snapshot.release();
    await call;
    await generation.retire();
  }
});

test('pin bounds opaque run identity JSON without narrowing the identity parser', async () => {
  const oversized = { ...run, runId: 'r'.repeat(16_000_001) };
  assert.equal(parseRunIdentity(oversized).runId, oversized.runId);
  let disposed = 0;
  let snapshot;
  const generation = await make(() => { disposed++; });
  try {
    assert.throws(() => { snapshot = pin([generation], { run: oversized }); }, /JSON exceeds size limit/u);
  } finally {
    snapshot?.release();
    await generation.retire();
  }
  assert.equal(disposed, 1);
});
