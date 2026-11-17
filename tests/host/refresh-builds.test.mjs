import { canonicalJson } from '@agentui/contracts';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { createRefreshController, parseRefreshReceipt } from '../../apps/host/build/tsc/refresh-jobs.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import { realFixture, request, deferred, verificationBarrier, assertSelected, rows } from './refresh-support.mjs';

test('two distinct committed builds retain their own outputs and latest source wins during actual selection verification', async t => {
  const f = await realFixture(t), owner = await f.open(), newer = deferred(), secondStarted = deferred();
  let verifyingId = '/not-an-attempt/';
  const barrier = verificationBarrier(t, () => verifyingId);
  f.setRun(async command => {
    const result = await f.actual(command);
    if (command.requestId === 'old') verifyingId = command.id;
    else { secondStarted.resolve(); await newer.promise; }
    return result;
  });
  const old = owner.request(request('old', f.first));
  await Promise.race([barrier.entered, old.then(value => { barrier.release(); throw new Error(JSON.stringify(value)); })]);
  const during = await owner.inspect('old');
  assert.equal(during.job.promotion.kind, 'unconfirmed');
  assert.deepEqual(parseRefreshReceipt(JSON.parse(JSON.stringify(during))), during);
  assert.equal(during.selectionStatus.desiredRevision, 0);
  const next = owner.request(request('new', f.second));
  await secondStarted.promise;
  assert.equal((await owner.inspect('old')).latestRequestId, 'new');
  const building = await owner.inspect('new');
  assert.equal(building.job.build.kind, 'building');
  assert.deepEqual(parseRefreshReceipt(JSON.parse(JSON.stringify(building))), building);
  barrier.release();
  const stale = await old;
  assert.equal(stale.job.promotion.kind, 'refused');
  assert.equal(stale.job.promotion.reason, 'source-superseded');
  assert.equal(f.stops(), 0);
  assert.equal(owner.selection.status().desiredRevision, 0);
  newer.resolve();
  const selected = await next;
  assertSelected(selected, 'new');
  assert.notEqual(stale.job.build.pin.artifactId, selected.job.build.pin.artifactId);
  assert.notEqual(stale.job.build.pin.directory, selected.job.build.pin.directory);
  for (const [receipt, reference] of [[stale, f.first], [selected, f.second]]) {
    assert.deepEqual(parseRefreshReceipt(JSON.parse(JSON.stringify(receipt))), receipt);
    assert.equal(receipt.job.build.pin.directory, receipt.job.build.command.directory);
    assert.deepEqual(receipt.job.promotion.command.selection.artifacts, [receipt.job.build.pin]);
    const manifest = JSON.parse(await fs.readFile(receipt.job.build.pin.directory + '/customization.json', 'utf8'));
    assert.equal(manifest.packages[0].identity, manifest.root);
    assert.equal(manifest.packages[0].commit, reference.commit);
    assert.equal(manifest.packages[0].subdirectory, 'server');
    assert.deepEqual(manifest.builder, f.builder.identity.builder);
    assert.ok(!JSON.stringify(manifest).includes('dirty bytes'));
  }
  assert.equal(f.commands.length, 2);
  assert.equal(f.replacements(), 0);
});

test('two active real builders refuse new admission while exact request replay remains available', async t => {
  const f = await realFixture(t), owner = await f.open(), release = deferred(), both = deferred();
  let completed = 0;
  f.setRun(async command => {
    const result = await f.actual(command);
    if (++completed === 2) both.resolve();
    await release.promise;
    return result;
  });
  const first = owner.request(request('one', f.first)), second = owner.request(request('two', f.second));
  await both.promise;
  const before = rows(f.database);
  await assert.rejects(owner.request(request('three', f.first)), /busy/);
  assert.deepEqual(rows(f.database), before);
  assert.equal((await owner.request(request('one', f.first))).job.build.kind, 'building');
  await assert.rejects(owner.request(request('one', f.second)), /id-conflict/);
  release.resolve();
  await Promise.all([first, second]);
  assert.equal(f.commands.length, 2);
  assert.equal(rows(f.database).length, 2);
});

test('lookup stays unconfirmed while current selection is in flight and observes its later exact effect', async t => {
  const f = await realFixture(t), owner = await f.open();
  let id = '/not-an-attempt/';
  const barrier = verificationBarrier(t, () => id);
  f.setRun(async command => { const result = await f.actual(command); id = command.id; return result; });
  const pending = owner.request(request('current', f.first));
  await barrier.entered;
  const before = rows(f.database);
  for (let i = 0; i < 3; i++) assert.equal((await owner.inspect('current')).job.promotion.kind, 'unconfirmed');
  assert.deepEqual(rows(f.database), before);
  assert.equal(f.database.prepare('SELECT count(*) AS n FROM service_extension_selections').get().n, 1);
  barrier.release();
  assertSelected(await pending, 'current');
  assertSelected(await owner.inspect('current'), 'current');
});

test('lost selection acknowledgement reconciles exact historical receipt after newer selection and reopen', async t => {
  const f = await realFixture(t);
  let owner = await f.open();
  const original = owner.selection.select;
  owner.selection.select = async command => { await original(command); throw new Error('lost acknowledgement'); };
  await assert.rejects(owner.request(request('first', f.first)), /unavailable/);
  await owner.close();
  owner = await f.open();
  const first = await owner.inspect('first');
  assertSelected(first, 'first');
  const next = await owner.request(request('second', f.second, 1));
  assertSelected(next, 'second');
  await owner.close();
  const reopened = await f.open(), before = rows(f.database);
  const historical = await reopened.inspect('first');
  assertSelected(historical, 'first');
  assert.equal(historical.job.promotion.operation.outcome.kind, 'superseded');
  assert.deepEqual(parseRefreshReceipt(JSON.parse(JSON.stringify(historical))), historical);
  assert.equal(historical.selectionStatus.desired.id, next.job.promotion.command.id);
  assert.equal(historical.job.promotion.operation.receiptDigest, first.job.promotion.operation.receiptDigest);
  await reopened.promote('first');
  await reopened.request(request('first', f.first));
  assert.equal(reopened.selection.status().desiredRevision, 2);
  assert.deepEqual(rows(f.database), before);
  assert.equal(f.commands.length, 2);
  await reopened.selection.activate();
  const applied = await reopened.inspect('second');
  assert.equal(applied.job.promotion.operation.outcome.kind, 'applied-empty');
  assert.equal(typeof applied.job.promotion.operation.attemptId, 'string');
  assert.equal(applied.selectionStatus.runtime.kind, 'applied-empty');
  assert.deepEqual(parseRefreshReceipt(JSON.parse(JSON.stringify(applied))), applied);
  const afterApplication = await reopened.inspect('first');
  assert.deepEqual(parseRefreshReceipt(JSON.parse(JSON.stringify(afterApplication))), afterApplication);
});

test('explicit promotion reuses saved pins and identity, preserves external selection CAS and never rebuilds', async t => {
  const f = await realFixture(t);
  let owner = await f.open();
  owner.selection.select = async () => { throw new Error('handoff lost before selection'); };
  await assert.rejects(owner.request(request('retry', f.first)), /unavailable/);
  await owner.close();
  owner = await f.open();
  const built = await owner.inspect('retry');
  assert.equal(built.job.promotion.kind, 'unconfirmed');
  assert.deepEqual(parseRefreshReceipt(JSON.parse(JSON.stringify(built))), built);
  const command = built.job.promotion.command;
  const promoted = await owner.promote('retry');
  assertSelected(promoted, 'retry');
  assert.deepEqual(promoted.job.promotion.command, command);
  owner.selection.select = async () => { throw new Error('handoff lost before selection'); };
  await assert.rejects(owner.request(request('external-cas', f.second, 1)), /unavailable/);
  await owner.close();
  owner = await f.open();
  const later = await owner.inspect('external-cas');
  await owner.selection.select({ id: 'external-manual', expectedRevision: 1, selection: { version: 1, artifacts: [] } });
  const refused = await owner.promote('external-cas');
  assert.equal(refused.job.promotion.kind, 'refused');
  assert.equal(refused.job.promotion.reason, 'revision-conflict');
  assert.deepEqual(parseRefreshReceipt(JSON.parse(JSON.stringify(refused))), refused);
  assert.deepEqual(refused.job.promotion.command, later.job.promotion.command);
  assert.equal(owner.selection.status().desired.id, 'external-manual');
  assert.equal(f.commands.length, 2);
  assert.equal(f.stops(), 2);
});

for (const mismatch of ['commit', 'directory', 'builder', 'esbuild', 'asset']) test(`owned build rejects wrong ${mismatch} before recording built evidence`, async t => {
  const f = await realFixture(t);
  if (mismatch === 'esbuild') f.builder.identity.builder = { ...f.builder.identity.builder, esbuildVersion: 'wrong' };
  if (mismatch === 'builder') f.builder.identity.builder = { ...f.builder.identity.builder, identity: 'a'.repeat(64) };
  f.setRun(async command => {
    const result = await f.actual(mismatch === 'commit' ? { ...command, source: f.first } : command);
    if (mismatch === 'directory') return { ...result, pin: { ...result.pin, directory: f.seed.directory } };
    if (mismatch === 'asset') await fs.appendFile(result.pin.directory + '/entries.mjs', '\nmodified');
    return result;
  });
  const owner = await f.open(), result = await owner.request(request('mismatch', f.second));
  assert.equal(result.job.build.kind, 'failed');
  assert.equal(result.job.build.failure, 'qualification');
  assert.deepEqual(parseRefreshReceipt(JSON.parse(JSON.stringify(result))), result);
  assert.equal(result.job.promotion.kind, 'not-built');
  assert.equal(owner.selection.status().desiredRevision, 0);
  assert.equal(f.stops(), 0);
  const stored = JSON.parse(rows(f.database)[0].body);
  assert.equal(stored.build.manifest, undefined);
});

test('verified manifest and saved promotion command roll back as one result on SQL failure', async t => {
  const f = await realFixture(t), owner = await f.open();
  f.database.exec(`CREATE TRIGGER reject_result BEFORE UPDATE ON host_refresh_jobs
    WHEN json_extract(NEW.body, '$.build.kind')='built' BEGIN SELECT RAISE(ABORT, 'PRIVATE_RESULT'); END`);
  await assert.rejects(owner.request(request('atomic', f.first)), /^Error: Refresh unavailable$/);
  const stored = JSON.parse(rows(f.database)[0].body);
  assert.equal(stored.build.kind, 'building');
  assert.deepEqual(stored.promotion, { kind: 'not-built' });
  assert.equal(stored.build.manifest, undefined);
  assert.equal(owner.selection.status().desiredRevision, 0);
  assert.equal(f.stops(), 1);
  f.database.exec('DROP TRIGGER reject_result');
  await owner.close();
  const reopened = await f.open();
  assert.equal((await reopened.inspect('atomic')).job.build.kind, 'interrupted');
  assert.equal(f.commands.length, 1);
});

test('canonical selection SQL failure preserves the saved unconfirmed command and earlier selection', async t => {
  const f = await realFixture(t), owner = await f.open();
  f.database.exec("CREATE TRIGGER reject_selection BEFORE INSERT ON service_extension_selections BEGIN SELECT RAISE(ABORT, 'PRIVATE_SELECTION'); END");
  await assert.rejects(owner.request(request('sql', f.first)), /unavailable/);
  const saved = JSON.parse(rows(f.database)[0].body);
  assert.equal(saved.build.kind, 'built');
  assert.equal(saved.promotion.kind, 'unconfirmed');
  assert.equal(owner.selection.status().desiredRevision, 0);
  assert.equal(f.stops(), 1);
  assert.equal(f.database.prepare('SELECT count(*) AS n FROM service_extension_selections').get().n, 1);
});

test('process termination after real build leaves an interrupted attempt without implicit retry or orphan adoption', async t => {
  const f = await realFixture(t);
  const path = join(f.seed.directory, '..', 'crash.sqlite');
  const child = spawn(process.execPath, [fileURLToPath(new URL('./fixtures/refresh-crash-child.mjs', import.meta.url)), path, f.artifactRoot,
    JSON.stringify({ identity: f.builder.identity, request: request('crashed', f.first) })], {
    env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const exited = once(child, 'exit');
  let stderr = '';
  child.stderr.setEncoding('utf8'); child.stderr.on('data', chunk => { stderr += chunk; });
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM'); await exited; });
  const output = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error('Build child did not reach owned output: ' + stderr)); }, 15000);
    let bytes = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      bytes += chunk;
      if (bytes.includes('\n')) { clearTimeout(timer); resolve(JSON.parse(bytes.trim())); }
    });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', () => { clearTimeout(timer); if (!bytes.includes('\n')) reject(new Error('Build child exited: ' + stderr)); });
  });
  assert.equal(output.pid, child.pid);
  child.kill('SIGTERM');
  assert.deepEqual(await exited, [null, 'SIGTERM']);
  t.diagnostic('Owned crash child ' + child.pid + ' exited with SIGTERM after real build publication.');
  const database = new DatabaseSync(path);
  const before = JSON.parse(database.prepare('SELECT body FROM host_refresh_jobs').get().body);
  assert.equal(before.build.kind, 'building');
  const owner = await createRefreshController({ database: { database, hostId: f.access.hostId }, artifactRoot: f.artifactRoot, builder: f.builder, selection: f.selection });
  try {
    const receipt = await owner.inspect('crashed');
    assert.equal(receipt.job.build.kind, 'interrupted');
    assert.deepEqual(parseRefreshReceipt(JSON.parse(JSON.stringify(receipt))), receipt);
    assert.equal(receipt.job.build.command.directory, output.directory);
    assert.equal((await owner.request(request('crashed', f.first))).job.build.kind, 'interrupted');
    assert.equal(f.commands.length, 0);
    assert.equal(owner.selection.status().desiredRevision, 0);
    assert.equal(JSON.parse(await fs.readFile(output.directory + '/customization.json', 'utf8')).artifactId, output.artifactId);
  } finally { await owner.close(); database.close(); }
});

test('an external revision committed during actual verification still defeats refresh selection CAS', async t => {
  const f = await realFixture(t), owner = await f.open();
  let id = '/not-an-attempt/';
  const barrier = verificationBarrier(t, () => id);
  f.setRun(async command => { const result = await f.actual(command); id = command.id; return result; });
  const pending = owner.request(request('external-gap', f.first));
  await barrier.entered;
  const original = f.database.prepare('SELECT * FROM service_extension_selections WHERE revision=0').get();
  const intent = canonicalJson({ id: 'external', expectedRevision: 0, selection: { version: 1, artifacts: [] } });
  f.database.prepare('INSERT INTO service_extension_selections VALUES(?,?,?,?,?)').run('external', 1, intent, original.receipt, original.digest);
  barrier.release();
  const result = await pending;
  assert.equal(result.job.promotion.kind, 'refused');
  assert.equal(result.job.promotion.reason, 'revision-conflict');
  assert.equal(f.database.prepare('SELECT id FROM service_extension_selections ORDER BY revision DESC LIMIT 1').get().id, 'external');
  assert.equal(f.stops(), 0);
});

test('a reserved command must match its saved intent exactly and ordinary refusal leaves manual selection available', async t => {
  const f = await realFixture(t);
  let owner = await f.open();
  owner.selection.select = async () => { throw new Error('unconfirmed handoff'); };
  await assert.rejects(owner.request(request('exact-command', f.first)), /unavailable/);
  await owner.close();
  owner = await f.open();
  const built = await owner.inspect('exact-command');
  await assert.rejects(owner.selection.select({ ...built.job.promotion.command, selection: { version: 1, artifacts: [] } }), /refresh-intent-conflict/);
  assert.equal(f.stops(), 1);
  await owner.selection.select({ id: 'manual-after-refusal', expectedRevision: 0, selection: { version: 1, artifacts: [] } });
  assert.equal(owner.selection.status().desired.id, 'manual-after-refusal');
});

test('a poisoned canonical selector prevents any later refresh admission or builder effect', async t => {
  const f = await realFixture(t), owner = await f.open();
  f.database.exec("CREATE TRIGGER reject_lifetime BEFORE INSERT ON service_extension_selections BEGIN SELECT RAISE(ABORT, 'PRIVATE_SELECTION'); END");
  const first = await owner.request(request('fatal-first', f.first)).catch(error => error);
  const second = await owner.request(request('must-not-build', f.second)).catch(error => error);
  assert.equal(f.commands.length, 1);
  assert.equal(rows(f.database).length, 1);
  assert.match(first.message, /unavailable/);
  assert.match(second.message, /unavailable/);
  assert.equal(JSON.parse(rows(f.database)[0].body).promotion.kind, 'unconfirmed');
});

test('a fatal manual selection also disables refresh before any request admission', async t => {
  const f = await realFixture(t), owner = await f.open();
  f.database.exec("CREATE TRIGGER reject_manual BEFORE INSERT ON service_extension_selections BEGIN SELECT RAISE(ABORT, 'PRIVATE_SELECTION'); END");
  await assert.rejects(owner.selection.select({ id: 'manual-fatal', expectedRevision: 0, selection: { version: 1, artifacts: [] } }), /unavailable/);
  await assert.rejects(owner.request(request('must-not-run', f.first)), /unavailable/);
  assert.equal(f.commands.length, 0);
  assert.equal(rows(f.database).length, 0);
  assert.equal(f.stops(), 1);
});
