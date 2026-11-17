import assert from 'node:assert/strict';
import test from 'node:test';
import { canonicalJson, isOutputId, parseOutputId, parseTextMetadata } from '@agentui/contracts';
import { parseProviderCapture } from '../../packages/host/dist/provider-commands.js';
import { providerReference } from '../../packages/host/dist/provider-commands.js';
import { fixture, hash, invalid, missing, secret, unavailable, unsupported } from './provider-outputs-fixture.mjs';

test('public LocalHost reads confirmed provider output with fresh listings, owned bytes and private identities', async t => {
  const f = await fixture(t), id = await f.id(), initial = structuredClone(f.original);
  assert.ok(isOutputId(id)); assert.equal(parseOutputId(id), id); assert.throws(() => parseOutputId('report'));
  const result = await f.host.readOutput(f.scope, id);
  assert.equal(result.kind, 'available');
  assert.deepEqual(result.bytes, f.state.bytes);
  assert.deepEqual(Object.keys(result.output).sort(), ['byteLength', 'lifetime', 'mediaType', 'name', 'outputId', 'sha256']);
  assert.equal(result.output.lifetime, 'provider-retained');
  assert.ok(!JSON.stringify(result).includes(secret));
  const saved = new Uint8Array(result.bytes);
  f.state.bytes[0] ^= 1;
  assert.deepEqual(result.bytes, saved);
  f.state.bytes[0] ^= 1;
  result.bytes[0] ^= 1;
  assert.deepEqual((await f.host.readOutput(f.scope, id)).bytes, saved);
  assert.equal(f.calls.list, 3); assert.equal(f.calls.read, 2);
  assert.deepEqual(f.host.creation(f.scope), initial);
  const alternate = structuredClone(f.original); alternate.credential.opaqueHandle = 'another-secret';
  f.state.credential = structuredClone(alternate.credential);
  assert.equal((await f.registry.conversationOutputs(alternate)).outputs[0].outputId, id);
  assert.deepEqual(await f.registry.conversationOutputs(f.original), unavailable);
});

const mutations = [
  ['scope host', b => { b.creation.scope.hostId += '-foreign'; }],
  ['scope conversation', b => { b.creation.scope.conversationId += '-foreign'; }],
  ['creation', b => { b.creation.operationId = '00000000-0000-4000-8000-000000000000'; }],
  ['agent', b => { b.creation.agent.opaqueId += '-foreign'; }],
  ...['namespace', 'installationId', 'generation', 'protocolVersion'].map(key => [`creation ${key}`, b => { b.creation.agent.instance[key] += '-foreign'; }]),
  ['authority kind', b => { b.authority.kind = 'remote-provider'; delete b.authority.hostId; }],
  ['authority host', b => { b.authority.hostId += '-foreign'; }],
  ...['namespace', 'installationId', 'opaqueSessionId'].map(key => [`authority ${key}`, b => { b.authority.binding[key] += '-foreign'; }]),
];
test('every original binding and reference identity dimension rejects foreign listings before read', async t => {
  const f = await fixture(t, { expectedAuthority: 'agentui-host' }), id = await f.id();
  for (const [label, mutate] of mutations) {
    f.hooks.list = binding => { const row = f.row(binding); mutate(row.reference.binding); return { kind: 'complete', outputs: [row] }; };
    assert.deepEqual(await f.host.conversationOutputs(f.scope), invalid, label);
    assert.deepEqual(await f.host.readOutput(f.scope, id), invalid, label);
  }
  for (const key of ['namespace', 'installationId', 'generation', 'protocolVersion']) {
    f.hooks.list = binding => { const row = f.row(binding); row.reference.ref.instance[key] += '-foreign'; return { kind: 'complete', outputs: [row] }; };
    assert.deepEqual(await f.host.readOutput(f.scope, id), invalid, key);
  }
  assert.equal(f.calls.read, 0);
});

test('provider mutations of outward arguments cannot alter pristine binding or ID', async t => {
  const f = await fixture(t, { expectedAuthority: 'agentui-host' }), id = await f.id(), pristine = structuredClone(f.original);
  for (const [label, mutate] of mutations) {
    f.hooks.list = binding => { mutate(binding); return { kind: 'complete', outputs: [f.row(binding)] }; };
    assert.deepEqual(await f.host.readOutput(f.scope, id), invalid, label);
    delete f.hooks.list;
    f.hooks.read = reference => { mutate(reference.binding); reference.ref.instance.generation = 'foreign'; return { kind: 'available', bytes: f.state.bytes }; };
    const result = await f.host.readOutput(f.scope, id);
    assert.equal(result.output.outputId, id, label);
    assert.deepEqual(f.host.creation(f.scope), pristine);
  }
  const shared = structuredClone(pristine.observation.binding);
  shared.authority.binding.opaqueSessionId = 'provider-mutated';
  assert.doesNotThrow(() => providerReference(f.row(shared).reference, shared, f.installation, 'output'));
  f.hooks.list = binding => { binding.authority.binding.opaqueSessionId = 'provider-mutated'; return { kind: 'complete', outputs: [f.row(binding)] }; };
  assert.deepEqual(await f.host.readOutput(f.scope, id), invalid);
  delete f.hooks.list; delete f.hooks.read;
  const original = structuredClone(pristine);
  const pending = f.registry.conversationOutputs(original);
  original.intent.scope.conversationId = 'caller-mutated';
  original.observation.binding.authority.binding.opaqueSessionId = 'caller-mutated';
  assert.equal((await pending).outputs[0].outputId, id);
});

test('immutable metadata and opaque identity change IDs; public IDs cannot cross conversations', async t => {
  const f = await fixture(t), id = await f.id();
  for (const [label, change] of [
    ['name', row => { row.name = 'renamed.txt'; }], ['opaque', row => { row.reference.ref.opaqueId = 'another'; }],
    ['digest', row => { row.sha256 = 'b'.repeat(64); }], ['length', row => { row.byteLength++; }],
  ]) {
    f.hooks.list = binding => { const row = f.row(binding); change(row); return { kind: 'complete', outputs: [row] }; };
    assert.notEqual(await f.id(), id, label);
    assert.deepEqual(await f.host.readOutput(f.scope, id), missing, label);
  }
  delete f.hooks.list;
  const scope = { ...f.scope, conversationId: 'other' };
  await f.host.createProviderConversation(scope, f.installation, f.registry);
  assert.notEqual((await f.host.conversationOutputs(scope)).outputs[0].outputId, id);
  assert.deepEqual(await f.host.readOutput(scope, id), missing);
  assert.equal(f.calls.read, 0);
});

test('output references never enter command run, decision, choice or permission slots', async t => {
  const f = await fixture(t), binding = f.original.observation.binding, output = f.row(binding).reference;
  const ref = kind => ({ binding, ref: { ...output.ref, kind } });
  const capture = operation => parseProviderCapture({ kind: 'provider', installation: f.installation, credential: f.original.credential,
    operation: { operationId: '00000000-0000-4000-8000-000000000001', binding, ...operation } }, f.scope);
  for (const operation of [
    { kind: 'cancel', run: output },
    { kind: 'decide', run: ref('run'), decision: output, choice: ref('choice') },
    { kind: 'decide', run: ref('run'), decision: ref('decision'), choice: output },
    { kind: 'revoke-permission', permission: output, scope: 'conversation' },
  ]) assert.throws(() => capture(operation), /Foreign provider reference|Invalid/);
  assert.doesNotThrow(() => capture({ kind: 'cancel', run: ref('run') }));
});

test('fixed failures hide reasons; malformed results, partial capabilities and thrown providers release slots', async t => {
  const f = await fixture(t), id = await f.id();
  const failures = [
    ...['unsupported', 'unavailable', 'authentication-failed', 'unauthorized', 'version-unsupported'].map(kind => [{ kind, reason: secret }, kind === 'unsupported' ? unsupported : unavailable]),
    [{ kind: 'whatever', reason: secret }, invalid], [{ kind: 'unavailable', reason: 1 }, invalid],
    [{ kind: 'unavailable', reason: secret, extra: true }, invalid], [null, invalid],
  ];
  for (const [value, expected] of failures) {
    f.hooks.list = () => value;
    assert.deepEqual(await f.host.conversationOutputs(f.scope), expected);
    assert.deepEqual(await f.host.readOutput(f.scope, id), expected);
    delete f.hooks.list; f.hooks.read = () => value;
    assert.deepEqual(await f.host.readOutput(f.scope, id), expected);
    delete f.hooks.read;
    assert.equal((await f.host.readOutput(f.scope, id)).kind, 'available');
    assert.equal(f.registry.activity().pending, 0);
  }
  f.hooks.list = () => ({ kind: 'missing' }); assert.deepEqual(await f.host.conversationOutputs(f.scope), invalid);
  delete f.hooks.list;
  f.hooks.read = () => ({ kind: 'missing' }); assert.deepEqual(await f.host.readOutput(f.scope, id), missing);
  for (const key of ['list', 'read']) {
    delete f.hooks.read; f.hooks[key] = () => { throw new Error(secret); };
    assert.deepEqual(await f.host.readOutput(f.scope, id), unavailable); delete f.hooks[key];
  }
  for (const capability of [null, {}, { list() {} }, { read() {} }, { list: 1, read() {} }]) {
    f.connected.outputs = capability; assert.deepEqual(await f.host.readOutput(f.scope, id), invalid);
  }
  f.connected.outputs = undefined;
  const calls = { ...f.calls };
  assert.deepEqual(await f.host.conversationOutputs(f.scope), unsupported);
  assert.deepEqual(await f.host.readOutput(f.scope, id), unsupported);
  assert.equal(f.calls.list, calls.list); assert.equal(f.calls.read, calls.read);
  Object.defineProperty(f.connected, 'outputs', { configurable: true, get() { throw new Error(secret); } });
  assert.deepEqual(await f.host.conversationOutputs(f.scope), invalid);
  Object.defineProperty(f.connected, 'outputs', { configurable: true, value: f.outputs, writable: true });
  for (const value of [undefined, null, 7, 'report']) assert.deepEqual(await f.registry.readOutput(f.original, value), invalid);
  assert.equal((await f.host.readOutput(f.scope, id)).kind, 'available');
  assert.equal(f.registry.activity().pending, 0);
});

test('byte boundaries accept zero and maximum text and reject corrupt, borrowed or shared payloads safely', async t => {
  const f = await fixture(t);
  for (const length of [0, 65536]) {
    f.state.bytes = new Uint8Array(length).fill(65);
    const id = await f.id(), result = await f.host.readOutput(f.scope, id);
    assert.equal(result.kind, 'available'); assert.equal(result.bytes.length, length);
  }
  f.state.bytes = new Uint8Array([0xc0, 0xaf]);
  assert.deepEqual(await f.host.readOutput(f.scope, await f.id()), invalid);
  f.state.bytes = new TextEncoder().encode('valid');
  const id = await f.id();
  for (const bytes of [new Uint8Array(new SharedArrayBuffer(5)), 'valid', [118, 97, 108, 105, 100],
    new Uint8Array(4), new Uint8Array(5), new DataView(new ArrayBuffer(5))]) {
    f.hooks.read = () => ({ kind: 'available', bytes });
    assert.deepEqual(await f.host.readOutput(f.scope, id), invalid);
  }
  delete f.hooks.read;
  assert.equal((await f.host.readOutput(f.scope, id)).kind, 'available');
  assert.equal(f.registry.activity().pending, 0);
});

test('complete list and metadata validation enforce count, opaque and filename boundaries', async t => {
  const f = await fixture(t);
  const good = f.row(f.original.observation.binding);
  for (const name of ['a.txt', 'a'.repeat(124) + '.txt']) assert.equal(parseTextMetadata({ name, mediaType: 'text/plain', byteLength: 0, sha256: hash('') }).name, name);
  const edits = [
    row => { row.name = '../report.txt'; }, row => { row.name = '.txt'; }, row => { row.name = 'a'.repeat(125) + '.txt'; },
    row => { row.name = 'report.TXT'; }, row => { row.name = 'résumé.txt'; }, row => { row.name = 'a/b.txt'; },
    row => { row.mediaType = 'text/html'; }, row => { row.byteLength = -1; }, row => { row.byteLength = 65537; },
    row => { row.byteLength = 0.5; }, row => { row.sha256 = 'A'.repeat(64); }, row => { row.sha256 = 'a'.repeat(63); },
    row => { row.reference.ref.opaqueId = 'a'.repeat(513); }, row => { row.reference.ref.opaqueId = 'é'.repeat(257); },
    row => { row.reference.ref.opaqueId = ' '; }, row => { row.reference.ref.opaqueId = '\u0000'; },
    row => { row.reference.ref.opaqueId = ''; }, row => { row.extra = true; },
  ];
  for (const edit of edits) {
    const row = structuredClone(good); edit(row); f.hooks.list = () => ({ kind: 'complete', outputs: [row] });
    assert.deepEqual(await f.host.conversationOutputs(f.scope), invalid);
  }
  for (const opaqueId of ['a'.repeat(512), 'é'.repeat(256)]) {
    const row = structuredClone(good); row.reference.ref.opaqueId = opaqueId;
    f.hooks.list = () => ({ kind: 'complete', outputs: [row] });
    assert.equal((await f.host.conversationOutputs(f.scope)).kind, 'available');
  }
  for (const length of [32, 33]) {
    f.hooks.list = binding => ({ kind: 'complete', outputs: Array.from({ length }, (_, index) => f.row(binding, `id-${index}`)) });
    assert.equal((await f.host.conversationOutputs(f.scope)).kind, length === 32 ? 'available' : 'invalid');
  }
  for (const value of [{ kind: 'partial', outputs: [] }, { kind: 'complete', outputs: [good, good] }, { kind: 'complete', outputs: [], more: false }]) {
    f.hooks.list = () => value; assert.deepEqual(await f.host.conversationOutputs(f.scope), invalid);
  }
  delete f.hooks.list; assert.equal((await f.host.conversationOutputs(f.scope)).kind, 'available');
});

test('complete canonical listing byte limit rejects a valid one-byte-over listing', async t => {
  const f = await fixture(t);
  const original = structuredClone(f.original);
  original.observation.binding.authority.binding.opaqueSessionId = 's'.repeat(950);
  const rows = Array.from({ length: 32 }, (_, index) => f.row(original.observation.binding, `id-${index}`));
  const listing = { kind: 'complete', outputs: rows };
  let remaining = 65536 - Buffer.byteLength(canonicalJson(listing));
  assert.ok(remaining > 0 && remaining < 32 * 400);
  for (const row of rows) {
    const addition = Math.min(remaining, 400); row.reference.ref.opaqueId += 'x'.repeat(addition); remaining -= addition;
  }
  assert.equal(remaining, 0); assert.equal(Buffer.byteLength(canonicalJson(listing)), 65536);
  f.hooks.list = () => listing;
  assert.equal((await f.registry.conversationOutputs(original)).kind, 'available');
  rows.at(-1).reference.ref.opaqueId += 'x';
  assert.equal(Buffer.byteLength(canonicalJson(listing)), 65537);
  for (const row of rows) {
    f.hooks.list = () => ({ kind: 'complete', outputs: [row] });
    assert.equal((await f.registry.conversationOutputs(original)).kind, 'available');
  }
  f.hooks.list = () => listing;
  assert.deepEqual(await f.registry.conversationOutputs(original), invalid);
});

test('canonical metadata byte budget admits exactly 1024 bytes and rejects one extra escaped byte', async t => {
  const f = await fixture(t), row = f.row(f.original.observation.binding);
  row.name = 'a'.repeat(124) + '.txt';
  row.reference.ref.opaqueId = '"'.repeat(350);
  const metadata = () => ({ opaqueId: row.reference.ref.opaqueId, name: row.name, mediaType: row.mediaType, byteLength: row.byteLength, sha256: row.sha256 });
  row.reference.ref.opaqueId += 'x'.repeat(1024 - Buffer.byteLength(canonicalJson(metadata())));
  assert.ok(Buffer.byteLength(row.reference.ref.opaqueId) <= 512);
  assert.equal(Buffer.byteLength(canonicalJson(metadata())), 1024);
  f.hooks.list = () => ({ kind: 'complete', outputs: [row] });
  assert.equal((await f.host.conversationOutputs(f.scope)).kind, 'available');
  row.reference.ref.opaqueId += 'x';
  assert.ok(Buffer.byteLength(row.reference.ref.opaqueId) <= 512);
  assert.equal(Buffer.byteLength(canonicalJson(metadata())), 1025);
  assert.deepEqual(await f.host.conversationOutputs(f.scope), invalid);
});

test('capability getters and byte-result inspection cannot retain a slot or bypass authorization', async t => {
  const f = await fixture(t), id = await f.id();
  const method = f.outputs.list;
  Object.defineProperty(f.outputs, 'list', { configurable: true, get() { throw new Error(secret); } });
  assert.deepEqual(await f.host.conversationOutputs(f.scope), invalid);
  Object.defineProperty(f.outputs, 'list', { configurable: true, value: method, writable: true });
  f.hooks.read = () => new Proxy({ kind: 'available', bytes: new Uint8Array(f.state.bytes) }, {
    ownKeys(target) { f.state.authorized = false; return Reflect.ownKeys(target); },
  });
  assert.deepEqual(await f.host.readOutput(f.scope, id), unavailable);
  assert.equal(f.registry.activity().pending, 0);
  f.state.authorized = true; delete f.hooks.read;
  assert.equal((await f.host.readOutput(f.scope, id)).kind, 'available');
});

test('callers cannot poison fixed failure results returned by later operations', async t => {
  const f = await fixture(t), id = await f.id();
  f.connected.outputs = undefined;
  const result = await f.host.conversationOutputs(f.scope);
  assert.throws(() => { result.reason = secret; }, TypeError);
  assert.deepEqual(await f.host.readOutput(f.scope, id), unsupported);
  f.connected.outputs = f.outputs;
  const descriptor = (await f.host.conversationOutputs(f.scope)).outputs[0];
  descriptor.name = 'changed.txt'; descriptor.outputId = 'changed';
  assert.equal((await f.host.readOutput(f.scope, id)).output.name, 'report.txt');
});

test('output storage checks ignore shadowed typed-array properties', async t => {
  const f = await fixture(t), id = await f.id();
  const shared = new Uint8Array(new SharedArrayBuffer(f.state.bytes.byteLength));
  shared.set(f.state.bytes);
  Object.defineProperty(shared, 'buffer', { value: new ArrayBuffer(0) });
  f.hooks.read = () => ({ kind: 'available', bytes: shared });
  assert.deepEqual(await f.host.readOutput(f.scope, id), invalid);
  const ordinary = new Uint8Array(f.state.bytes);
  Object.defineProperties(ordinary, {
    buffer: { get() { throw new Error('Shadowed buffer getter must not run'); } },
    byteLength: { get() { throw new Error('Shadowed length getter must not run'); } },
  });
  f.hooks.read = () => ({ kind: 'available', bytes: ordinary });
  const result = await f.host.readOutput(f.scope, id);
  assert.equal(result.kind, 'available');
  assert.deepEqual(result.bytes, f.state.bytes);
  assert.notEqual(result.bytes, ordinary);
});
