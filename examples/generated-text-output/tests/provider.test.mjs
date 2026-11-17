import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { canonicalJson, OUTPUT_MAX_BYTES, OUTPUT_MAX_COUNT, OUTPUT_MAX_LIST_BYTES } from '@agentui/contracts';
import { reportProvider } from '../dist/provider.js';
import { openReportExample } from '../dist/consumer.js';

const instance = { namespace: 'reports', installationId: 'reports', generation: '1', protocolVersion: '1' };
const intent = (conversationId = randomUUID()) => ({ kind: 'create', operationId: randomUUID(), scope: { hostId: 'host', conversationId }, agent: { instance, kind: 'agent', opaqueId: 'writer' } });
const send = (binding, text = 'A report. é🐦\n') => ({ kind: 'send', operationId: randomUUID(), binding, request: { text } });
const createReceipt = value => ({ kind: 'confirmed', evidence: null, value: { kind: 'agentui-created', creation: value,
  authority: { kind: 'remote-provider', binding: { namespace: 'reports', installationId: 'reports', opaqueSessionId: value.operationId } } } });
const sendReceipt = value => ({ kind: 'confirmed', evidence: null, value: { kind: 'send', state: 'completed', run: {
  binding: value.binding, ref: { instance, kind: 'run', opaqueId: value.operationId } } } });
function directory(t) {
  const path = mkdtempSync(join(tmpdir(), 'agentui-report-'));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
}
async function connect(path) {
  const provider = reportProvider(path), result = await provider.backend.connect({ apiVersion: 1, instance, credential: null });
  assert.equal(result.kind, 'connected');
  return { provider, connected: result.backend };
}
function dbRead(path, action) { const db = new DatabaseSync(path); try { return action(db); } finally { db.close(); } }
function state(path) {
  return dbRead(path, db => JSON.stringify({ creations: db.prepare('SELECT * FROM creations ORDER BY scope').all(),
    receipts: db.prepare('SELECT * FROM receipts ORDER BY id').all(),
    payloads: db.prepare('SELECT seq,scope,opaque,metadata,hex(bytes) AS bytes FROM payloads ORDER BY seq').all(),
    sequence: db.prepare('SELECT * FROM sqlite_sequence').all() }));
}
function encodings(t) {
  const original = TextEncoder.prototype.encode;
  let count = 0;
  t.mock.method(TextEncoder.prototype, 'encode', function (...args) { count++; return original.apply(this, args); });
  return () => count;
}

function worstListing(binding) {
  return { kind: 'complete', outputs: Array.from({ length: OUTPUT_MAX_COUNT }, (_, index) => ({
    name: 'response.txt', mediaType: 'text/plain', byteLength: OUTPUT_MAX_BYTES, sha256: 'f'.repeat(64),
    reference: { binding, ref: { instance, kind: 'output', opaqueId: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}` } },
  })) };
}
function listingBoundary(prefix) {
  const value = intent(prefix); value.scope.hostId = 'h'.repeat(1024);
  const size = () => Buffer.byteLength(canonicalJson(worstListing(createReceipt(value).value)));
  while (size() <= OUTPUT_MAX_LIST_BYTES) value.scope.conversationId += 'c';
  const refused = structuredClone(value);
  value.scope.conversationId = value.scope.conversationId.slice(0, -1);
  assert.ok(size() <= OUTPUT_MAX_LIST_BYTES);
  assert.ok(Buffer.byteLength(canonicalJson(worstListing(createReceipt(refused).value))) > OUTPUT_MAX_LIST_BYTES);
  return { accepted: value, refused };
}

test('creation refuses one byte beyond complete-list capacity without encoding, creation or receipt effects', async t => {
  const count = encodings(t);
  for (const prefix of ['c', 'é🐦"\\\n']) {
    const path = join(directory(t), 'reports.sqlite');
    let { provider, connected } = await connect(path);
    provider.close(); const before = state(path);
    ({ provider, connected } = await connect(path));
    const { refused } = listingBoundary(prefix);
    try {
      assert.deepEqual(await connected.create(refused), { kind: 'not-dispatched', reason: 'listing-capacity' });
      assert.equal(count(), 0);
      assert.equal((await connected.reconcileCreation(refused)).reason, 'operation-absent');
    } finally { provider.close(); }
    assert.equal(state(path), before);
  }
});

test('exact listing-capable context retains 32 maximum-byte payloads through public listing and evicts only result 1 at 33', async t => {
  const previous = process.env.AGENTUI_REPORT_DATABASE;
  t.after(() => { if (previous === undefined) delete process.env.AGENTUI_REPORT_DATABASE; else process.env.AGENTUI_REPORT_DATABASE = previous; });
  for (const prefix of ['c', 'é🐦"\\\n']) {
    const dir = directory(t), { accepted, refused } = listingBoundary(prefix), scope = accepted.scope;
    assert.equal(Buffer.byteLength(canonicalJson(worstListing(createReceipt(refused).value))) -
      Buffer.byteLength(canonicalJson(worstListing(createReceipt(accepted).value))), OUTPUT_MAX_COUNT);
    if (prefix !== 'c') assert.ok(Buffer.byteLength(canonicalJson(scope)) > JSON.stringify(scope).length);
    process.env.AGENTUI_REPORT_DATABASE = join(dir, 'reports.sqlite');
    let example = await openReportExample({ hostPath: join(dir, 'host.sqlite'), scope });
    const binding = example.host.creation(scope).observation.binding;
    await example.close();
    const { provider, connected } = await connect(process.env.AGENTUI_REPORT_DATABASE);
    try {
      for (let i = 0; i < OUTPUT_MAX_COUNT; i++) assert.equal((await connected.submit(send(binding, 'é'.repeat(32768)))).kind, 'confirmed');
      const listing = await connected.outputs.list(binding);
      assert.equal(listing.outputs.length, OUTPUT_MAX_COUNT);
      assert.equal(Buffer.byteLength(canonicalJson(listing)), Buffer.byteLength(canonicalJson(worstListing(binding))));
      assert.ok(Buffer.byteLength(canonicalJson(listing)) <= OUTPUT_MAX_LIST_BYTES);
      t.diagnostic(JSON.stringify({ context: prefix === 'c' ? 'ASCII' : 'escaped and multibyte',
        contextBytes: Buffer.byteLength(canonicalJson(scope)), bindingBytes: Buffer.byteLength(canonicalJson(binding)),
        completeListingBytes: Buffer.byteLength(canonicalJson(listing)), outputs: listing.outputs.length,
        payloadBytes: listing.outputs.map(output => output.byteLength),
        nextContextListingBytes: Buffer.byteLength(canonicalJson(worstListing(createReceipt(refused).value))) }));
    } finally { provider.close(); }
    example = await openReportExample({ hostPath: join(dir, 'host.sqlite'), scope });
    try {
      const listing = await example.outputs();
      assert.equal(listing.kind, 'available'); assert.equal(listing.outputs.length, OUTPUT_MAX_COUNT);
      for (const output of listing.outputs) {
        assert.equal(output.byteLength, OUTPUT_MAX_BYTES);
        const read = await example.read(output.outputId);
        assert.equal(read.kind, 'available'); assert.equal(read.bytes.length, OUTPUT_MAX_BYTES);
      }
      assert.equal((await example.send('Result 33', randomUUID())).receipt.state.kind, 'completed');
      const after = await example.outputs();
      assert.equal(after.kind, 'available'); assert.equal(after.outputs.length, OUTPUT_MAX_COUNT);
      assert.deepEqual(after.outputs.slice(0, -1), listing.outputs.slice(1));
      assert.equal((await example.read(listing.outputs[0].outputId)).kind, 'missing');
    } finally { await example.close(); }
  }
});

test('startup rejects a previously confirmed oversized listing context without repair', async t => {
  const path = join(directory(t), 'reports.sqlite'), { provider } = await connect(path);
  provider.close();
  const { refused } = listingBoundary('é🐦"\\\n'), result = createReceipt(refused);
  dbRead(path, db => {
    db.prepare('INSERT INTO creations VALUES (?,?,?)').run(canonicalJson(refused.scope), canonicalJson(refused), canonicalJson(result.value));
    db.prepare('INSERT INTO receipts VALUES (?,?,?)').run(refused.operationId, canonicalJson(refused), canonicalJson(result));
  });
  const before = state(path); let unexpected;
  try { assert.throws(() => { unexpected = reportProvider(path); }, /unavailable/); }
  finally { unexpected?.close(); }
  assert.equal(state(path), before);
});

test('normal installed-entry loader and public LocalHost preserve creation, completed command and output on restart', async t => {
  const dir = directory(t), scope = { hostId: 'host', conversationId: 'consumer' }, hostPath = join(dir, 'host.sqlite');
  const previous = process.env.AGENTUI_REPORT_DATABASE;
  process.env.AGENTUI_REPORT_DATABASE = join(dir, 'reports.sqlite');
  t.after(() => { if (previous === undefined) delete process.env.AGENTUI_REPORT_DATABASE; else process.env.AGENTUI_REPORT_DATABASE = previous; });
  let example = await openReportExample({ hostPath, scope });
  t.after(async () => example.close());
  const count = encodings(t), id = randomUUID(), text = 'Exact report é🐦\n';
  const receipt = await example.send(text, id);
  assert.equal(receipt.receipt.state.kind, 'completed');
  const creation = example.host.creation(scope), listed = await example.outputs();
  assert.equal(listed.kind, 'available'); assert.equal(listed.outputs.length, 1);
  const descriptor = listed.outputs[0], read = await example.host.readOutput(scope, descriptor.outputId);
  assert.equal(descriptor.name, 'response.txt'); assert.equal(new TextDecoder().decode(read.bytes), text);
  const before = count();
  await example.close(); example = await openReportExample({ hostPath, scope });
  assert.deepEqual(example.host.creation(scope), creation);
  assert.deepEqual(await example.send(text, id), receipt);
  assert.deepEqual(await example.host.reconcile(scope, id), receipt.receipt);
  assert.deepEqual(await example.outputs(), listed);
  assert.deepEqual(await example.host.readOutput(scope, descriptor.outputId), read);
  assert.equal(count(), before);
  assert.equal((await example.send('', randomUUID())).kind, 'rejected');
});

test('33 results evict bytes only; exact submit/reconcile/reopen never encode or advance retention', async t => {
  const path = join(directory(t), 'reports.sqlite'), count = encodings(t), original = intent();
  let { provider, connected } = await connect(path);
  const created = await connected.create(original), binding = created.value, first = send(binding);
  assert.deepEqual(created, createReceipt(original));
  const receipt = await connected.submit(first);
  const firstOutput = (await connected.outputs.list(binding)).outputs[0];
  for (let i = 1; i < 33; i++) assert.equal((await connected.submit(send(binding, `Report ${i}`))).kind, 'confirmed');
  assert.equal(count(), 33);
  assert.equal((await connected.outputs.list(binding)).outputs.length, 32);
  assert.deepEqual(await connected.outputs.read(firstOutput.reference), { kind: 'missing' });
  provider.close(); const before = state(path);
  ({ provider, connected } = await connect(path));
  assert.deepEqual(await connected.create(original), created);
  assert.deepEqual(await connected.reconcileCreation(original), created);
  assert.deepEqual(await connected.submit(first), receipt);
  assert.deepEqual(await connected.reconcileCommand(first), receipt);
  assert.equal((await connected.submit({ ...first, request: { text: 'changed' } })).reason, 'operation-conflict');
  assert.equal((await connected.reconcileCommand(send(binding))).reason, 'operation-absent');
  assert.equal(count(), 33);
  provider.close(); assert.equal(state(path), before);
  dbRead(path, db => { assert.equal(db.prepare('SELECT count(*) n FROM receipts').get().n, 34); });
});

test('rollback after eviction restores 32 payloads, bytes, metadata, receipt and sequence; lost commit ACK reopens once', async t => {
  const path = join(directory(t), 'reports.sqlite'), count = encodings(t);
  let { provider, connected } = await connect(path);
  const binding = (await connected.create(intent())).value;
  for (let i = 0; i < 32; i++) await connected.submit(send(binding, String(i)));
  provider.close(); const before = state(path);
  ({ provider, connected } = await connect(path));
  const operation = send(binding, 'Number 33');
  const prepare = DatabaseSync.prototype.prepare;
  const fault = t.mock.method(DatabaseSync.prototype, 'prepare', function(sql) {
    const statement = prepare.call(this, sql);
    if (sql.startsWith('DELETE FROM payloads')) {
      const run = statement.run.bind(statement);
      statement.run = (...args) => { run(...args); throw new Error('Injected after eviction'); };
    }
    return statement;
  });
  await assert.rejects(() => connected.submit(operation), /Injected/);
  fault.mock.restore(); provider.close(); assert.equal(state(path), before); assert.equal(count(), 33);
  ({ provider, connected } = await connect(path));
  const exec = DatabaseSync.prototype.exec;
  const ack = t.mock.method(DatabaseSync.prototype, 'exec', function(sql) { const result = exec.call(this, sql); if (sql === 'COMMIT') throw new Error('Lost acknowledgement'); return result; });
  await assert.rejects(() => connected.submit(operation), /Lost acknowledgement/);
  ack.mock.restore(); provider.close(); const committed = state(path);
  ({ provider, connected } = await connect(path));
  assert.deepEqual(await connected.submit(operation), sendReceipt(operation));
  assert.deepEqual(await connected.reconcileCommand(operation), sendReceipt(operation));
  assert.equal((await connected.outputs.list(binding)).outputs.length, 32);
  assert.equal(count(), 34); provider.close(); assert.equal(state(path), committed);
});

test('receipt structure rejects replacement and rowid routes with recursive triggers disabled', async t => {
  const path = join(directory(t), 'reports.sqlite'), { provider, connected } = await connect(path);
  await connected.create(intent()); provider.close(); const before = state(path);
  dbRead(path, db => {
    db.exec('PRAGMA recursive_triggers=OFF');
    const row = db.prepare('SELECT * FROM receipts LIMIT 1').get();
    for (const sql of ["UPDATE receipts SET request='changed' WHERE id=?", "UPDATE receipts SET id='changed' WHERE id=?", 'DELETE FROM receipts WHERE id=?']) assert.throws(() => db.prepare(sql).run(row.id));
    for (const verb of ['INSERT OR REPLACE', 'REPLACE']) assert.throws(() => db.prepare(`${verb} INTO receipts VALUES (?,?,?)`).run(row.id, 'changed', 'changed'));
    assert.throws(() => db.prepare('INSERT OR REPLACE INTO receipts(rowid,id,request,reply) VALUES (1,?,?,?)').run(randomUUID(), 'x', 'y'));
  });
  assert.equal(state(path), before);
});

test('creation count, receipt count and actual 64 MiB reservation refuse before encoding; fixtures are directly seeded history', async t => {
  const dir = directory(t), count = encodings(t), creationPath = join(dir, 'creations.sqlite');
  let { provider, connected } = await connect(creationPath);
  const first = intent(), creation = await connected.create(first);
  for (let i = 1; i < 128; i++) await connected.create(intent());
  assert.equal((await connected.create(intent())).reason, 'creation-capacity');
  assert.deepEqual(await connected.create(first), creation); provider.close();
  for (const boundary of ['count', 'bytes']) {
    const path = join(dir, boundary + '.sqlite');
    ({ provider, connected } = await connect(path));
    const binding = (await connected.create(intent())).value, historical = send(binding, 'real producer execution');
    const receipt = await connected.submit(historical); provider.close();
    let exact;
    dbRead(path, db => {
      const insert = db.prepare('INSERT INTO receipts VALUES (?,?,?)');
      db.exec('BEGIN');
      if (boundary === 'count') {
        for (let i = 2; i < 4096; i++) { const op = send(binding, 'Directly seeded count fixture'); insert.run(op.operationId, canonicalJson(op), canonicalJson(sendReceipt(op))); }
      } else {
        exact = send(binding, 'é'.repeat(500));
        const target = 67108864 - Buffer.byteLength(canonicalJson(exact)) - 16384;
        let used = db.prepare('SELECT sum(length(CAST(request AS BLOB))+length(CAST(reply AS BLOB))) n FROM receipts').get().n;
        while (true) {
          const op = send(binding, ''), reply = canonicalJson(sendReceipt(op)), base = Buffer.byteLength(canonicalJson(op)) + Buffer.byteLength(reply);
          const length = Math.min(60000, target - used - base);
          if (length < 0) break;
          op.request.text = 'é'.repeat(Math.floor(length / 2)) + 'x'.repeat(length % 2); insert.run(op.operationId, canonicalJson(op), reply); used += base + length;
        }
        assert.equal(used, target, 'direct fixture fills actual 64 MiB reservation boundary');
        assert.ok(db.prepare('SELECT count(*) n FROM receipts').get().n < 4096);
      }
      db.exec('COMMIT');
    });
    const before = count(); ({ provider, connected } = await connect(path));
    const refused = boundary === 'count' ? send(binding) : { ...exact, request: { text: exact.request.text + 'x' } };
    assert.equal((await connected.submit(refused)).reason, 'receipt-capacity');
    assert.deepEqual(await connected.submit(historical), receipt); assert.deepEqual(await connected.reconcileCommand(historical), receipt);
    assert.equal(count(), before, 'neither capacity refusal nor replay encodes');
    if (exact) { assert.equal((await connected.submit(exact)).kind, 'confirmed'); assert.equal(count(), before + 1); }
    provider.close();
  }
});

test('logical identities, UTF-8 validation, exclusive ownership, once-only disposal and malformed stores', async t => {
  const path = join(directory(t), 'reports.sqlite'), count = encodings(t);
  const { provider, connected } = await connect(path);
  assert.throws(() => reportProvider(path), /unavailable/);
  const original = intent(), binding = (await connected.create(original)).value;
  const operation = send(binding, ''); await connected.submit(operation);
  const output = (await connected.outputs.list(binding)).outputs[0]; assert.equal(output.byteLength, 0);
  await connected.submit(send(binding, 'é'.repeat(32768)));
  assert.equal((await connected.outputs.list(binding)).outputs[1].byteLength, 65536);
  assert.equal((await connected.submit(send(binding, '\n'.repeat(65536)))).reason, 'request-capacity');
  for (const text of ['x'.repeat(65537), '\ud800']) await assert.rejects(() => connected.submit(send(binding, text)));
  assert.equal(count(), 2);
  const mutations = [
    b => { b.creation.scope.hostId += 'other'; }, b => { b.creation.scope.conversationId += 'other'; },
    b => { b.creation.operationId = randomUUID(); }, b => { b.creation.agent.opaqueId = 'other'; },
    ...['namespace', 'installationId', 'generation', 'protocolVersion'].map(key => b => { b.creation.agent.instance[key] += 'other'; }),
    b => { b.authority.kind = 'agentui-host'; b.authority.hostId = 'host'; },
    ...['namespace', 'installationId', 'opaqueSessionId'].map(key => b => { b.authority.binding[key] += 'other'; }),
  ];
  for (const mutate of mutations) {
    const foreign = structuredClone(binding); mutate(foreign);
    await assert.rejects(async () => { const value = await connected.outputs.list(foreign); if (value.kind === 'unavailable') throw new Error('rejected'); });
    await assert.rejects(async () => { const value = await connected.submit(send(foreign)); if (value.kind === 'rejected') throw new Error('rejected'); });
  }
  for (const key of ['namespace', 'installationId', 'generation', 'protocolVersion']) {
    const reference = structuredClone(output.reference); reference.ref.instance[key] += 'other';
    assert.equal((await connected.outputs.read(reference)).kind, 'unavailable');
  }
  const close = DatabaseSync.prototype.close; let closes = 0;
  const closeMock = t.mock.method(DatabaseSync.prototype, 'close', function() { closes++; return close.call(this); });
  await connected.close(); provider.close(); provider.close(); assert.equal(closes, 1); closeMock.mock.restore();
  dbRead(path, db => db.exec('DROP TRIGGER receipt_insert'));
  assert.throws(() => reportProvider(path), /unavailable/);
  dbRead(path, db => assert.equal(db.prepare("SELECT name FROM sqlite_schema WHERE name='receipt_insert'").get(), undefined));
});

test('malformed stored bytes and receipts fail closed without repair', async t => {
  const dir = directory(t);
  for (const corruption of ['payload', 'receipt', 'creation']) {
    const path = join(dir, corruption + '.sqlite'), { provider, connected } = await connect(path);
    const binding = (await connected.create(intent())).value;
    await connected.submit(send(binding)); provider.close();
    dbRead(path, db => {
      if (corruption === 'payload') db.exec("UPDATE payloads SET bytes=X'FF'");
      if (corruption === 'creation') db.exec("UPDATE creations SET binding='{}'");
      if (corruption === 'receipt') {
        const sql = db.prepare("SELECT sql FROM sqlite_schema WHERE name='receipt_update'").get().sql;
        db.exec("DROP TRIGGER receipt_update; UPDATE receipts SET reply='{}'"); db.exec(sql);
      }
    });
    const before = state(path); assert.throws(() => reportProvider(path), /unavailable/); assert.equal(state(path), before);
  }
});
