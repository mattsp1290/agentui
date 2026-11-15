import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFrontendToolGeneration, pinFrontendTools } from '@agentui/sdk/tools';

const run = { conversation: { hostId: 'h', conversationId: 'c' }, runId: 'r', authority: { kind: 'agentui-host', hostId: 'h', binding: { namespace: 'n', installationId: 'i', opaqueSessionId: 's' } } };
const capabilities = { tools: { clientProvided: true } };
const pin = (generations, overrides = {}) => pinFrontendTools({ generations, platform: 'desktop', run, capabilities, ...overrides });
const make = (opts = {}) => createFrontendToolGeneration({ namespace: 'demo', generation: '1', platform: 'desktop', activate(tools) { tools.add({ definition: { name: 'text_length', description: 'count', parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false } }, decodeInput(x) { return x.text; }, async execute(x) { return String(x.length); } }); return { dispose() {} }; }, ...opts });

test('pins hold retired generations and active calls until they drain', async () => {
  let finish, disposed = 0;
  const a = await make({ activate(tools) { tools.add({ definition: { name: 'x', description: 'x' }, decodeInput(x) { return x; }, execute() { return new Promise(resolve => { finish = resolve; }); } }); return { dispose() { disposed++; } }; } });
  const p = pin([a]); const call = p.invoke('demo__x', {}); const retired = a.retire();
  assert.equal(retired, a.retire()); p.release(); p.release();
  assert.deepEqual(await p.invoke('demo__x', {}), { kind: 'refused', code: 'released' });
  assert.equal(disposed, 0); finish('done'); assert.equal((await call).output, 'done'); await retired; assert.equal(disposed, 1);
  assert.throws(() => pin([a]));
});

test('old and new generations and multiple pins are independent', async () => {
  let disposed = 0;
  const a = await make({ activate(t) { t.add({ definition: { name: 'x', description: 'x' }, decodeInput(x) { return x; }, async execute() { return 'old'; } }); return { dispose() { disposed++; } }; } });
  const p = pin([a]), q = pin([a]); const done = a.retire();
  const b = await make(); const newer = pin([b]);
  assert.equal((await p.invoke('demo__x', {})).output, 'old');
  assert.equal((await newer.invoke('demo__text_length', { text: 'abc' })).output, '3');
  p.release(); assert.equal(disposed, 0); q.release(); await done; assert.equal(disposed, 1); newer.release(); await b.retire();
});

test('schema, capability, snapshot, and receiver boundaries', async () => {
  class Tool { definition = { name: 'x', description: 'x', parameters: { type: 'object', definitions: { item: { type: 'string' } }, properties: { value: { $ref: '#/definitions/item' } }, required: ['value'] } }; prefix = 'ok'; decodeInput(x) { return x.value; } async execute(x) { return this.prefix + x; } }
  const tool = new Tool(); const g = await make({ activate(t) { t.add(tool); return { dispose() {} }; } });
  tool.definition.name = 'changed'; run.conversation.conversationId = 'snapshot';
  const p = pin([g]); run.conversation.conversationId = 'later';
  assert.equal(p.run.conversation.conversationId, 'snapshot'); assert.equal(p.definitions[0].name, 'demo__x');
  assert.equal((await p.invoke('demo__x', { value: '!' })).output, 'ok!');
  assert.equal((await p.invoke('demo__x', { value: 3 })).code, 'invalid-arguments');
  for (const caps of [undefined, {}, { tools: { clientProvided: false } }, { tools: { clientProvided: true, supported: false } }]) assert.equal(pin([g], { capabilities: caps }).definitions.length, 0);
  assert.equal(pin([g], { platform: 'ios' }).definitions.length, 0); p.release(); await g.retire();
});

test('invalid schemas poison registration and clean up', async () => {
  for (const schema of [{ type: 'object', properties: { x: { minimum: 'no' } } }, { type: 'object', future: true }, { type: 'object', format: 'unknown' }, { type: 'object', properties: { x: { $ref: '#/missing' } } }, { type: 'object', $ref: 'https://example.com/schema' }, { type: 'object', $id: 'x' }, { type: 'object', $schema: 'other' }, { type: 'object', properties: { x: { $ref: '#' } } }, { type: 'object', definitions: { a: { type: 'object', properties: { b: { type: 'string' } } } }, properties: { x: { $ref: '#/definitions/a%2Fproperties%2Fb' } } }]) {
    let disposed = 0;
    await assert.rejects(make({ activate(t) { try { t.add({ definition: { name: 'x', description: 'x', parameters: schema }, decodeInput(x) { return x; }, async execute() { return ''; } }); } catch {} return { dispose() { disposed++; } }; } }));
    assert.equal(disposed, 1);
  }
});

test('disposal rejection is shared without retry', async () => {
  let count = 0; const g = await make({ activate() { return { dispose() { count++; throw new Error('failed'); } }; } });
  const a = g.retire(); const b = g.retire(); assert.equal(a, b); await assert.rejects(a, /failed/); await assert.rejects(b, /failed/); assert.equal(count, 1);
});

test('wire definition conforms to retained protocol Tool schema', async () => {
  const { readFile } = await import('node:fs/promises');
  const { default: Ajv } = await import('ajv/dist/2020.js');
  const schema = JSON.parse(await readFile('tests/protocol/fixtures/upstream/schema.json', 'utf8'));
  const validate = new Ajv({ strict: false }).compile({ ...schema, $ref: '#/$defs/Tool' });
  const g = await make(); const p = pin([g]);
  assert.equal(validate(p.definitions[0]), true, JSON.stringify(validate.errors));
  p.release(); await g.retire();
});

test('rejects malformed public definitions and generation identity', async () => {
  for (const definition of [{ name: 'x' }, { name: 'x', description: 3 }, { name: 'x', description: 'x', parameters: null }, { name: 'x', description: 'x', extra: true }, { name: 'x', description: 'x', metadata: null }]) {
    await assert.rejects(make({ activate(t) { t.add({ definition, decodeInput(x) { return x; }, async execute() { return ''; } }); return { dispose() {} }; } }));
  }
  await assert.rejects(make({ generation: '' }));
  await assert.rejects(make({ platform: 'web' }));
});

test('generation identity is captured before activation settles', async () => {
  let finish;
  const options = { namespace: 'original', generation: 'one', platform: 'desktop', activate() { return new Promise(resolve => { finish = resolve; }); } };
  const creating = createFrontendToolGeneration(options);
  options.namespace = 'changed'; options.generation = 'two'; options.platform = 'ios'; finish({ dispose() {} });
  const g = await creating; assert.equal(g.namespace, 'original'); assert.equal(g.generation, 'one'); assert.equal(g.platform, 'desktop'); assert.equal(Object.isFrozen(g), true); await g.retire();
});

test('registration rejects collisions and closes after activation', async () => {
  let add;
  const contribution = { definition: { name: 'x', description: 'x' }, decodeInput(x) { return x; }, async execute() { return ''; } };
  await assert.rejects(make({ activate(t) { t.add(contribution); t.add(contribution); return { dispose() {} }; } }));
  const g = await make({ activate(t) { add = t.add; return { dispose() {} }; } });
  assert.throws(() => add(contribution), /closed/);
  const other = await make(); assert.throws(() => pin([g, other]), /Duplicate/); await g.retire(); await other.retire();
});

test('arguments are not defaulted or coerced and decoder errors refuse', async () => {
  const g = await make({ activate(t) { t.add({ definition: { name: 'x', description: 'x', parameters: { type: 'object', properties: { n: { type: 'number', default: 4 } } } }, decodeInput(x) { if (!('n' in x)) throw Error('missing'); return x.n; }, async execute(x) { return String(x); } }); return { dispose() {} }; } });
  const p = pin([g]); assert.equal((await p.invoke('demo__x', {})).code, 'decode-failed'); assert.equal((await p.invoke('demo__x', { n: '4' })).code, 'invalid-arguments');
  p.release(); await g.retire();
});

test('ios pins select ios generations and refuse unknown names', async () => {
  const g = await make({ platform: 'ios' }); const p = pin([g], { platform: 'ios' });
  assert.equal((await p.invoke('demo__text_length', { text: 'hi' })).output, '2'); assert.equal((await p.invoke('missing', {})).code, 'unknown-tool');
  p.release(); await g.retire();
});

test('handler rejection drains an in-flight call and nonstring results reject', async () => {
  let reject, disposed = 0;
  const g = await make({ activate(t) { t.add({ definition: { name: 'x', description: 'x' }, decodeInput(x) { return x; }, execute() { return new Promise((_, fail) => { reject = fail; }); } }); return { dispose() { disposed++; } }; } });
  const p = pin([g]); const call = p.invoke('demo__x', {}); const retired = g.retire(); p.release(); reject(new Error('handler')); await assert.rejects(call, /handler/); await retired; assert.equal(disposed, 1);
  const other = await make({ activate(t) { t.add({ definition: { name: 'x', description: 'x' }, decodeInput(x) { return x; }, async execute() { return 3; } }); return { dispose() {} }; } });
  const q = pin([other]); await assert.rejects(q.invoke('demo__x', {}), /string/); q.release(); await other.retire();
});

test('registration captures methods and schema independently', async () => {
  const contribution = { definition: { name: 'x', description: 'x', parameters: { type: 'object', properties: { n: { type: 'string' } } } }, decodeInput(x) { return x.n; }, async execute(x) { return x; } };
  const g = await make({ activate(t) { t.add(contribution); return { dispose() {} }; } });
  contribution.definition.parameters.properties.n.type = 'number'; contribution.decodeInput = () => 'changed'; contribution.execute = async () => 'changed';
  const p = pin([g]); assert.equal((await p.invoke('demo__x', { n: 'original' })).output, 'original'); assert.equal((await p.invoke('demo__x', { n: 2 })).code, 'invalid-arguments'); p.release(); await g.retire();
  await assert.rejects(make({ namespace: ['demo'] }));
});
