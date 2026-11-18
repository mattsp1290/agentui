import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { connected, events, projection, receipt, scope, snapshot } from './support.mjs';

const validDecision = { pendingId: 'pending', runId: 'run', choices: ['allow'], prompt: 'Allow?' };
const validReceipt = receipt({ scope, clientCommandId: 'command' });
const malformed = [
  ['empty choices', 'decision-opened', { ...validDecision, choices: [] }],
  ['duplicate choices', 'decision-opened', { ...validDecision, choices: ['allow', 'allow'] }],
  ['empty choice', 'decision-opened', { ...validDecision, choices: [''] }],
  ...['pendingId', 'runId', 'prompt'].map(key => [`empty ${key}`, 'decision-opened', { ...validDecision, [key]: '' }]),
  ...['clientCommandId', 'hostOperationId'].map(key => [`empty ${key}`, 'receipt', { ...validReceipt, [key]: '' }]),
  ...['uncertain', 'rejected', 'not-dispatched'].map(kind => [`empty ${kind} reason`, 'receipt', { ...validReceipt, state: { kind, reason: '' } }]),
];

for (const [name, kind, value] of malformed) {
  test(`client rejects ${name} in snapshots and atomically rejects event pages`, async () => {
    const first = await connected();
    const before = first.store.getSnapshot().document;
    const receipts = kind === 'receipt' ? { [value.clientCommandId]: value } : {};
    const decisions = kind === 'decision-opened' ? { [value.pendingId]: value } : {};
    await assert.rejects(first.stream.receive(snapshot(1, 'uncommitted', scope, receipts, decisions)));
    assert.equal(first.store.getSnapshot().document, before);
    assert.equal(first.store.getSnapshot().cursor, 0);
    const next = await connected();
    const page = events([1, 'uncommitted']);
    page.events.push({ scope, sequence: 2, event: kind === 'receipt'
      ? { kind, receipt: { ...value, sequence: 2 } } : { kind, decision: value } });
    await assert.rejects(next.stream.receive(page));
    assert.equal(next.store.getSnapshot().document.domain.text, '');
    assert.equal(next.store.getSnapshot().cursor, 0);
  });
}

test('receipt scope mismatches keep their connection classification and sequence mismatches reject atomically', async () => {
  for (const [changed, classification] of [
    [{ scope: { ...scope, hostId: 'foreign' } }, 'mismatch'],
    [{ sequence: 9 }, 'resync'],
  ]) {
    const { store, stream } = await connected();
    await assert.rejects(stream.receive({ kind: 'events', events: [{ scope, sequence: 1,
      event: { kind: 'receipt', receipt: { ...validReceipt, ...changed } } }] }));
    assert.equal(store.getSnapshot().connection.kind, classification);
    assert.equal(store.getSnapshot().cursor, 0);
  }
});

test('snapshot maps preserve prototype-like receipt and pending-decision identities', async () => {
  const { store, stream } = await connected();
  const specialReceipt = { ...validReceipt, clientCommandId: '__proto__' };
  const specialDecision = { ...validDecision, pendingId: '__proto__' };
  await stream.receive(snapshot(1, '', scope,
    { ['__proto__']: specialReceipt }, { ['__proto__']: specialDecision }));
  const document = store.getSnapshot().document;
  assert.equal(Object.hasOwn(document.receipts, '__proto__'), true);
  assert.equal(Object.hasOwn(document.decisions, '__proto__'), true);
  assert.deepEqual(document.receipts.__proto__, specialReceipt);
  assert.deepEqual(document.decisions.__proto__, specialDecision);
});

test('shared event decoding preserves the projection method receiver', async () => {
  const selectedProjection = { ...projection, prefix: 'decoded ',
    decodeEvent(value) { return this.prefix + value; } };
  const { store, stream } = await connected({ selectedProjection });
  await stream.receive(events([1, 'value']));
  assert.equal(store.getSnapshot().document.domain.text, 'decoded value');
});

test('only the latest 256 sequence identities can be recognized as duplicates', async () => {
  const { store, stream } = await connected();
  await stream.receive(events(...Array.from({ length: 257 }, (_, index) => [index + 1, 'x'])));
  await stream.receive(events([2, 'x']));
  assert.equal(store.getSnapshot().cursor, 257);
  await assert.rejects(stream.receive(events([1, 'x'])), /duplicate/);
  assert.equal(store.getSnapshot().connection.kind, 'resync');
  assert.equal(store.getSnapshot().document.domain.text.length, 257);
});

test('extension-call requests and every result kind round-trip with exact keys and patterns', async () => {
  const { parseServiceRequest, parseServiceResponse, EXTENSION_CALL_FAILURES } = await import('@agentui/contracts/service');
  const request = { op: 'extension-call', namespace: 'fixture', installationId: 'personal', operation: 'members.list', input: { nested: [1, 'two', null] } };
  assert.deepEqual(parseServiceRequest(request), request);
  for (const changed of [{ extra: true }, { operation: 'Members' }, { operation: '.list' }, { operation: 'o'.repeat(65) }, { namespace: 'Fixture' },
    { namespace: 'fix.ture' }, { installationId: '' }, { input: 'x'.repeat(64_000) }]) {
    assert.throws(() => parseServiceRequest({ ...request, ...changed }), `accepted ${Object.keys(changed)[0]}`);
  }
  const { input: _input, ...missing } = request;
  assert.throws(() => parseServiceRequest(missing));
  const values = [{ kind: 'ok', output: { members: [] } }, { kind: 'refused', code: 'unknown-profile' },
    ...EXTENSION_CALL_FAILURES.map(cause => ({ kind: 'failed', cause }))];
  for (const value of values) assert.deepEqual(parseServiceResponse(request, { ok: true, value }), { ok: true, value });
  for (const value of [{ kind: 'ok', output: {}, agentsChanged: true }, { kind: 'refused', code: 'Bad code' }, { kind: 'failed', cause: 'secret' },
    { kind: 'ok' }, { kind: 'ok', output: 'x'.repeat(256_000) }, { kind: 'other' }]) {
    assert.throws(() => parseServiceResponse(request, { ok: true, value }), JSON.stringify(value).slice(0, 60));
  }
});

test('metadata requires sorted extension descriptors without origins or credentials', async () => {
  const { parseServiceResponse } = await import('@agentui/contracts/service');
  const { SERVICE_WIRE_VERSION, EXTENSION_SDK_VERSION } = await import('@agentui/contracts/compatibility');
  const metadata = extensions => ({ hostId: 'host', principalId: 'principal', agents: [], defaultAgentId: null, extensions,
    compatibility: { wireVersion: SERVICE_WIRE_VERSION, extensionSdkVersion: EXTENSION_SDK_VERSION, nativeRuntime: null,
      desiredGitRevision: 'r', appliedArtifact: { artifactId: 'a', gitRevision: 'r' } } });
  const valid = [{ namespace: 'alpha', state: 'active', operations: ['echo'], installations: [{ installationId: 'a', status: 'available' }, { installationId: 'b', status: 'unavailable' }] },
    { namespace: 'beta', state: 'failed', operations: [], installations: [] }];
  assert.deepEqual(parseServiceResponse({ op: 'metadata' }, { ok: true, value: metadata(valid) }).value.extensions, valid);
  const { extensions: _extensions, ...missing } = metadata([]);
  for (const value of [missing, metadata([...valid].reverse()), metadata([{ ...valid[0], service: 'http://127.0.0.1' }]),
    metadata([{ ...valid[0], installations: [...valid[0].installations].reverse() }]), metadata([{ ...valid[1], operations: ['echo'] }]),
    metadata([{ ...valid[0], installations: [{ installationId: 'a', status: 'available', credential: 'x' }] }])]) {
    assert.throws(() => parseServiceResponse({ op: 'metadata' }, { ok: true, value }));
  }
});

test('the client keeps an over-limit extension input local and refuses malformed calls without sending', async () => {
  const { createServiceConnection } = await import('../../packages/client/dist/service-engine.js');
  const { transcriptProjection } = await import('@agentui/contracts/conversation');
  let sent = 0;
  const connection = createServiceConnection(async () => { sent++; return new Response(JSON.stringify({ ok: true, value: { kind: 'ok', output: 1 } }), { headers: { 'content-type': 'application/json' } }); }, transcriptProjection);
  assert.deepEqual(await connection.extensionCall({ namespace: 'fixture', installationId: 'i', operation: 'echo', input: 'x'.repeat(64_000) }), { kind: 'failed', cause: 'too-large' });
  await assert.rejects(connection.extensionCall({ namespace: 'fixture', installationId: 'i', operation: 'Echo', input: {} }));
  assert.equal(sent, 0);
  assert.deepEqual(await connection.extensionCall({ namespace: 'fixture', installationId: 'i', operation: 'echo', input: {} }), { kind: 'ok', output: 1 });
  assert.equal(sent, 1);
});

const nest = depth => { let value = 0; for (let index = 0; index < depth; index++) value = [value]; return value; };

test('TypeScript and Rust share the extension-call and catalog-filter request golden cases', async () => {
  const { parseServiceRequest } = await import('@agentui/contracts/service');
  const cases = JSON.parse(readFileSync(new URL('./fixtures/extension-requests.json', import.meta.url)));
  assert.ok(cases.some(row => row.valid) && cases.some(row => !row.valid));
  for (const row of cases) {
    if (row.valid) assert.deepEqual(parseServiceRequest(row.request), row.request);
    else assert.throws(() => parseServiceRequest(row.request), undefined, JSON.stringify(row.request).slice(0, 120));
  }
});

test('an extension call resolves too-large exactly where the request envelope would exceed its structural limit', async () => {
  const { canonicalJson } = await import('@agentui/contracts');
  const { parseServiceRequest, parseServiceResponse, parseExtensionCallValue, ExtensionCallTooLarge } = await import('@agentui/contracts/service');
  const { createServiceConnection } = await import('../../packages/client/dist/service-engine.js');
  const { transcriptProjection } = await import('@agentui/contracts/conversation');
  const bodies = [];
  const connection = createServiceConnection(async body => { bodies.push(body); return new Response(JSON.stringify({ ok: true, value: { kind: 'ok', output: 1 } }), { headers: { 'content-type': 'application/json' } }); }, transcriptProjection);
  const call = input => ({ namespace: 'fixture', installationId: 'i', operation: 'echo', input });
  // Depth: the deepest input the envelope can carry is sent; one level more stays local as too-large instead of rejecting.
  assert.deepEqual(await connection.extensionCall(call(nest(63))), { kind: 'ok', output: 1 });
  assert.deepEqual(await connection.extensionCall(call(nest(64))), { kind: 'failed', cause: 'too-large' });
  assert.equal(bodies.length, 1);
  for (const body of bodies) canonicalJson(JSON.parse(body));
  assert.throws(() => parseServiceRequest({ op: 'extension-call', ...call(nest(64)) }));
  // Output sits two levels below the response root and shares its node budget with ok, value and kind. The host parses a
  // handler result with parseExtensionCallValue, so an output the response envelope cannot carry must fail there.
  // (The input's 64,000-byte limit is reached long before its node budget, so only the output's node edge is reachable.)
  const items = count => Array.from({ length: count - 1 }, () => 0);
  const request = { op: 'extension-call', ...call({}) };
  for (const output of [nest(62), items(99_996)]) {
    assert.deepEqual(parseExtensionCallValue({ kind: 'ok', output }), { kind: 'ok', output });
    assert.deepEqual(parseServiceResponse(request, { ok: true, value: { kind: 'ok', output } }).value, { kind: 'ok', output });
  }
  for (const output of [nest(63), items(99_997)]) assert.throws(() => parseExtensionCallValue({ kind: 'ok', output }), ExtensionCallTooLarge);
});

test('catalog filters and provider identities round-trip; unknown filter kinds and missing fields are rejected', async () => {
  const { parseServiceRequest, parseServiceResponse } = await import('@agentui/contracts/service');
  const filters = [{ kind: 'namespace', namespace: 'crew-like' }, { kind: 'provider-agent', namespace: 'ns', installationId: 'personal', providerAgentId: 'agent-1' }];
  for (const filter of filters) {
    const request = { op: 'catalog', after: null, limit: 10, filter };
    assert.deepEqual(parseServiceRequest(request), request);
  }
  assert.deepEqual(parseServiceRequest({ op: 'catalog', after: null, limit: 10 }), { op: 'catalog', after: null, limit: 10 });
  for (const filter of [{ kind: 'agent', namespace: 'ns' }, { kind: 'namespace' }, { kind: 'namespace', namespace: 'NS' }, { ...filters[1], extra: 1 },
    { kind: 'provider-agent', namespace: 'ns', installationId: 'i' }, null]) {
    assert.throws(() => parseServiceRequest({ op: 'catalog', after: null, limit: 10, filter }), JSON.stringify(filter));
  }
  const scope = { hostId: 'host', conversationId: 'c' }, provider = { namespace: 'ns', installationId: 'i', providerAgentId: 'a' };
  const catalog = [{ scope, preview: null, provider }, { scope: { ...scope, conversationId: 'd' }, preview: 'Hi', provider: null }];
  assert.deepEqual(parseServiceResponse({ op: 'catalog' }, { ok: true, value: catalog }).value, catalog);
  assert.throws(() => parseServiceResponse({ op: 'catalog' }, { ok: true, value: [{ scope, preview: null }] }));
  assert.throws(() => parseServiceResponse({ op: 'catalog' }, { ok: true, value: [{ scope, preview: null, provider: { ...provider, generation: '1' } }] }));
  for (const namespace of ['NS', 'example.crew', '1ns']) {
    assert.throws(() => parseServiceResponse({ op: 'catalog' }, { ok: true, value: [{ scope, preview: null, provider: { ...provider, namespace } }] }), namespace);
  }
  const search = { items: [{ scope, preview: null, provider, excerpt: null }], after: null };
  assert.deepEqual(parseServiceResponse({ op: 'search' }, { ok: true, value: search }).value, search);
  assert.throws(() => parseServiceResponse({ op: 'search' }, { ok: true, value: { items: [{ scope, preview: null, excerpt: null }], after: null } }));
});
