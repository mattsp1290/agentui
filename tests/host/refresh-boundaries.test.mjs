import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import { canonicalJson } from '@agentui/contracts';
import { createRefreshController, parseRefreshRequest, parseRefreshReceipt } from '../../apps/host/build/tsc/refresh-jobs.js';
import { createServerSelection } from '../../apps/host/build/tsc/server-selection.js';
import { SelectionRefusal } from '../../apps/host/build/tsc/selection-protocol.js';
import { databaseFixture, realFixture, request, source, rows, deferred } from './refresh-support.mjs';

function readyBuilder(run, close = async () => {}) {
  return { kind: 'ready', identity: { kind: 'ready', node: process.execPath, entrySha256: 'a'.repeat(64), lockSha256: 'b'.repeat(64),
    builder: { identity: 'c'.repeat(64), esbuildVersion: 'test' } }, run, close };
}
function snapshot(database) {
  const schema = database.prepare('SELECT * FROM sqlite_schema ORDER BY name').all();
  return { schema, rows: schema.filter(row => row.type === 'table').map(row =>
    database.prepare(`SELECT * FROM "${row.name.replaceAll('"', '""')}"`).all()) };
}

for (const [name, result] of [['null', null], ['undefined', undefined], ['missing kind', {}], ['unknown kind', { kind: 'unknown', failure: 'build' }],
  ['invalid failure', { kind: 'failed', failure: 'unknown' }], ['extra failure field', { kind: 'failed', failure: 'build', extra: true }],
  ['extra built field', { kind: 'built', pin: {}, manifest: {}, extra: true }]]) {
  test(`malformed fulfilled ${name} is a durable terminal failure`, async t => {
    let calls = 0;
    const f = databaseFixture(t, readyBuilder(async () => { calls++; return result; })), owner = await f.open();
    const receipt = await owner.request(request('malformed'));
    assert.equal(receipt.job.build.kind, 'failed');
    assert.equal(receipt.job.build.failure, 'qualification');
    assert.equal(receipt.job.promotion.kind, 'not-built');
    assert.deepEqual(await owner.inspect('malformed'), receipt);
    assert.deepEqual(await owner.request(request('malformed')), receipt);
    await assert.rejects(owner.promote('malformed'), /not-built/);
    assert.equal(owner.selection.status().desiredRevision, 0);
    assert.equal(f.replacements(), 0); assert.equal(f.stops(), 0); assert.equal(calls, 1);
    await owner.close();
    const reopened = await f.open();
    assert.equal((await reopened.inspect('malformed')).job.build.failure, 'qualification');
    assert.equal((await reopened.request(request('malformed'))).job.build.failure, 'qualification');
    assert.equal(calls, 1);
  });
}

test('malformed result persistence failure still poisons the owner', async t => {
  const f = databaseFixture(t, readyBuilder(async () => null)), owner = await f.open();
  f.database.exec("CREATE TRIGGER reject_failure BEFORE UPDATE ON host_refresh_jobs BEGIN SELECT RAISE(ABORT, 'PRIVATE'); END");
  await assert.rejects(owner.request(request('malformed')), /unavailable/);
  assert.equal(f.stops(), 1);
  await assert.rejects(owner.request(request('later')), /unavailable/);
  assert.equal(rows(f.database).length, 1);
});

test('extra fields on an otherwise valid built result cannot select its artifact', async t => {
  const f = await realFixture(t);
  f.setRun(async command => ({ ...await f.actual(command), extra: true }));
  const owner = await f.open(), result = await owner.request(request('extra-built', f.first));
  assert.equal(result.job.build.kind, 'failed');
  assert.equal(result.job.build.failure, 'qualification');
  assert.equal(result.job.promotion.kind, 'not-built');
  assert.deepEqual(await owner.request(request('extra-built', f.first)), result);
  assert.equal(owner.selection.status().desiredRevision, 0);
  assert.equal(f.commands.length, 1); assert.equal(f.stops(), 0);
});

test('a malformed late result cannot write after close begins', async t => {
  const started = deferred(), release = deferred();
  const f = databaseFixture(t, readyBuilder(async () => { started.resolve(); return release.promise; })), owner = await f.open();
  const pending = owner.request(request('late'));
  await started.promise;
  const rejected = assert.rejects(pending, /unavailable/), closing = owner.close();
  await new Promise(resolve => setImmediate(resolve));
  const before = rows(f.database);
  release.resolve(null);
  await Promise.all([rejected, closing]);
  assert.deepEqual(rows(f.database), before);
  assert.equal(JSON.parse(before[0].body).build.kind, 'interrupted');
});

for (const mode of ['relative root', 'file root', 'bad identity', 'bad startup pins']) for (const closeFails of [false, true]) {
  test(`failed construction ${mode} closes once when cleanup ${closeFails ? 'rejects' : 'succeeds'}`, async t => {
    const f = databaseFixture(t);
    let closes = 0;
    const builder = readyBuilder(async () => { throw new Error('must not run'); }, async () => { closes++; if (closeFails) throw new Error('cleanup secondary'); });
    if (mode === 'file root') await fs.writeFile(f.artifactRoot, 'file');
    if (mode === 'bad identity') builder.identity.node = 'relative';
    const selection = mode === 'bad startup pins' ? { ...f.selection, entries: [{ kind: 'artifact', directory: '/missing-refresh-artifact', artifactId: 'a'.repeat(64), installations: [] }] } : f.selection;
    await assert.rejects(createRefreshController({ database: f.access, artifactRoot: mode === 'relative root' ? 'relative' : f.artifactRoot, builder, selection }),
      mode === 'bad startup pins' ? /Invalid artifact selection/ : mode === 'file root' ? /EEXIST/ : /Invalid refresh directory/);
    assert.equal(closes, 1);
    assert.deepEqual(f.database.prepare("SELECT name FROM sqlite_schema WHERE name GLOB 'host_refresh_*' OR name GLOB 'service_extension_*'").all(), []);
  });
}
test('successful construction transfers cleanup to one shared close', async t => {
  let closes = 0;
  const f = databaseFixture(t, readyBuilder(async () => ({ kind: 'failed', failure: 'build' }), async () => { closes++; }));
  const owner = await f.open();
  assert.equal(closes, 0);
  assert.equal(owner.close(), owner.close());
  await owner.close(); assert.equal(closes, 1);
});

for (const adopted of [false, true]) for (const [name, damage] of [
  ['view', 'DROP TABLE service_extension_selections; CREATE VIEW service_extension_selections AS SELECT 1'],
  ['missing intent', 'DROP TABLE service_extension_selections; CREATE TABLE service_extension_selections(id TEXT PRIMARY KEY)'],
  ['missing table', 'DROP TABLE service_extension_selections'],
]) test(`${adopted ? 'owned' : 'pre-refresh'} invalid canonical ${name} stays inspectable without writes`, async t => {
  const f = databaseFixture(t);
  const initial = adopted ? (await f.open()).selection : await createServerSelection({ database: f.access, ...f.selection });
  await initial.close();
  f.database.exec(damage);
  const before = snapshot(f.database), changes = f.database.prepare('SELECT total_changes() AS n').get().n;
  const owner = await f.open();
  assert.deepEqual(owner.selection.status(), { kind: 'journal-invalid' });
  await owner.selection.activate();
  await assert.rejects(owner.request(request('refused')), /unavailable/);
  await assert.rejects(owner.promote('refused'), /unavailable/);
  assert.equal(f.replacements(), 0);
  assert.deepEqual(snapshot(f.database), before);
  assert.equal(f.database.prepare('SELECT total_changes() AS n').get().n, changes);
});

test('valid reserved history without refresh ownership cannot be adopted or activated', async t => {
  const f = databaseFixture(t);
  const canonical = await createServerSelection({ database: f.access, ...f.selection,
    refreshOwnership: { recover: () => ({ kind: 'allow' }), admit: () => ({ kind: 'allow' }) } });
  await canonical.select({ id: 'refresh.orphan', expectedRevision: 0, selection: { version: 1, artifacts: [] } });
  await canonical.close(); f.database.exec('DROP TABLE service_extension_refresh_owner');
  const before = snapshot(f.database), changes = f.database.prepare('SELECT total_changes() AS n').get().n;
  await assert.rejects(f.open(), /Invalid refresh selection/);
  assert.deepEqual(snapshot(f.database), before);
  assert.equal(f.database.prepare('SELECT total_changes() AS n').get().n, changes);
  assert.equal(f.replacements(), 0);
});

for (const [name, recover] of [['promise', () => Promise.resolve({ kind: 'allow' })], ['decorated promise', () => Object.assign(Promise.resolve(), { kind: 'allow' })],
  ['undefined', () => undefined], ['extra field', () => ({ kind: 'allow', extra: true })], ['unknown kind', () => ({ kind: 'unknown' })]]) {
  for (const existing of [false, true]) test(`${name} recovery cannot claim ${existing ? 'existing' : 'fresh'} canonical ownership`, async t => {
    const f = databaseFixture(t);
    if (existing) await (await createServerSelection({ database: f.access, ...f.selection })).close();
    const before = snapshot(f.database);
    await assert.rejects(createServerSelection({ database: f.access, ...f.selection, refreshOwnership: { recover, admit: () => ({ kind: 'allow' }) } }));
    assert.deepEqual(snapshot(f.database), before);
    assert.equal(f.replacements(), 0);
  });
}
for (const capability of [null, { recover: () => ({ kind: 'allow' }) }, { admit: () => ({ kind: 'allow' }) }]) {
  test('partial refresh ownership capability is rejected before canonical writes', async t => {
    const f = databaseFixture(t), before = snapshot(f.database);
    await assert.rejects(createServerSelection({ database: f.access, ...f.selection, refreshOwnership: capability }));
    assert.deepEqual(snapshot(f.database), before);
  });
}

for (const name of ['relative', 'unicode-file']) test(`${name} normalization rejects oversize before admission and preserves a usable owner`, async t => {
  let calls = 0;
  const f = databaseFixture(t, readyBuilder(async () => { calls++; return { kind: 'failed', failure: 'build' }; })), owner = await f.open();
  const empty = request('oversize', { ...source, repository: '' });
  const repository = name === 'relative' ? 'a'.repeat(4090 - Buffer.byteLength(canonicalJson(empty))) : 'file:///tmp/' + 'é'.repeat(1000);
  const input = request('oversize', { ...source, repository });
  assert.ok(Buffer.byteLength(canonicalJson(input)) <= 4096);
  const before = snapshot(f.database);
  await assert.rejects(owner.request(input), /Invalid refresh request/);
  assert.deepEqual(snapshot(f.database), before);
  assert.equal(f.stops(), 0); assert.equal(calls, 0);
  assert.equal((await owner.request(request('healthy'))).job.build.kind, 'failed');
  assert.equal(calls, 1);
});
test('accepted normalized requests reparse and replay exactly, including the byte limit and file URI encoding', async t => {
  const f = databaseFixture(t), owner = await f.open();
  const empty = request('limit', { ...source, repository: '/' });
  for (const input of [request('relative', { ...source, repository: './source' }), request('unicode', { ...source, repository: 'file:///tmp/é' }),
    request('limit', { ...source, repository: '/' + 'a'.repeat(4096 - Buffer.byteLength(canonicalJson(empty))) })]) {
    const parsed = parseRefreshRequest(input);
    assert.deepEqual(parseRefreshRequest(parsed), parsed);
    if (input.id === 'limit') assert.equal(Buffer.byteLength(canonicalJson(parsed)), 4096);
    const receipt = await owner.request(input);
    assert.deepEqual(await owner.request(parsed), receipt);
    assert.deepEqual(await owner.inspect(input.id), receipt);
  }
  assert.equal(f.stops(), 0);
});

for (const damage of ['modified', 'deleted']) test(`${damage} built artifact refuses explicit promotion without poisoning healthy selection`, async t => {
  const f = await realFixture(t), owner = await f.open(), select = owner.selection.select;
  owner.selection.select = async () => { throw new SelectionRefusal('busy'); };
  const built = await owner.request(request('damaged', f.first));
  assert.equal(built.job.promotion.reason, 'busy');
  assert.deepEqual(parseRefreshReceipt(JSON.parse(JSON.stringify(built))), built);
  owner.selection.select = select;
  const asset = built.job.build.pin.directory + '/entries.mjs', bytes = await fs.readFile(asset);
  if (damage === 'modified') await fs.appendFile(asset, '\nchanged'); else await fs.unlink(asset);
  const result = await owner.promote('damaged');
  assert.equal(result.job.promotion.kind, 'refused');
  assert.equal(result.job.promotion.reason, 'invalid-artifact');
  assert.deepEqual(parseRefreshReceipt(JSON.parse(JSON.stringify(result))), result);
  assert.deepEqual(result.job.promotion.command, built.job.promotion.command);
  assert.deepEqual(await owner.inspect('damaged'), result);
  assert.deepEqual(await owner.request(request('damaged', f.first)), result);
  assert.equal(f.stops(), 0); assert.equal(f.commands.length, 1);
  assert.equal(owner.selection.status().desiredRevision, 0);
  await assert.rejects(owner.selection.select({ id: 'invalid-manual', expectedRevision: 0, selection: { version: 1, artifacts: [built.job.build.pin] } }),
    error => error instanceof SelectionRefusal && error.reason === 'invalid-artifact' && error.message === 'Invalid artifact selection');
  await fs.writeFile(asset, bytes);
  assert.equal((await owner.promote('damaged')).job.promotion.kind, 'selected');
  await owner.selection.select({ id: 'healthy-manual', expectedRevision: 1, selection: { version: 1, artifacts: [] } });
  assert.equal(owner.selection.status().desired.id, 'healthy-manual');
  assert.equal(f.stops(), 0); assert.equal(f.commands.length, 1);
});
