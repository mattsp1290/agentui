import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { createConnection } from 'node:net';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import { requestControl } from '../../../apps/host/build/tsc/control.js';
import { ownDirectory } from '../../../apps/host/build/tsc/ownership.js';
import { api, fixture, packagedHost, secret, service } from './artifact-support.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const main = join(root, 'apps/host/dist/main.js'), exec = promisify(execFile);
async function liveFixture(t) {
  const runtime = await packagedHost(t), f = await fixture(t, runtime, { stableIdentity: true, liveFeeds: true });
  const options = { ...f.options, extensions: { kind: 'durable-artifacts', entries: [f.selected(f.first, 'artifact-a')] } };
  let host = await runtime.startBrowserHost(options);
  t.after(() => host.close().catch(() => {}));
  const socket = join(options.directory, 'control.sock');
  const cli = async (command, flags = []) => JSON.parse((await exec(process.execPath, [main, command, '--data-dir', options.directory, ...flags], { timeout: 15000 })).stdout).value;
  const select = async (id = 'build-b', revision = 0, artifact = f.second) => {
    const file = join(f.root, id + '.json');
    await fs.writeFile(file, JSON.stringify({ version: 1, artifacts: artifact ? [{ directory: artifact.directory, artifactId: artifact.manifest.artifactId }] : [] }));
    return cli('extensions-select', ['--operation', id, '--expected-revision', String(revision), '--selection', file]);
  };
  const apply = (requestId = 'apply-b', selectionId = 'build-b', expectedRevision = 1) => ({ op: 'extensions-apply', request: { kind: 'apply', requestId, selectionId, expectedRevision } });
  const retry = (requestId, afterAttemptId = 'apply-b') => ({ op: 'extensions-retry', request: { kind: 'retry', requestId, selectionId: 'build-b', expectedRevision: 1, afterAttemptId } });
  const send = request => requestControl(socket, request);
  const database = action => { const db = new DatabaseSync(join(options.directory, 'host.sqlite')); try { return action(db); } finally { db.close(); } };
  return { ...f, options, runtime, socket, cli, select, apply, retry, send, database, get host() { return host; },
    async restart(next = options) { await host.close(); host = await runtime.startBrowserHost(next); return host; } };
}
async function saved(f, count) {
  const call = api(f.host), metadata = (await call({ op: 'metadata' })).value;
  for (let i = 0; i < count; i++) {
    const scope = { hostId: f.host.hostId, conversationId: `saved-${String(i).padStart(4, '0')}` };
    assert.deepEqual((await call({ op: 'create', scope, agentId: metadata.defaultAgentId })).value, scope);
  }
}
async function dropped(f, request, entered) {
  const socket = createConnection(f.socket); await once(socket, 'connect');
  socket.write(JSON.stringify(request) + '\n');
  await entered;
  socket.destroy();
}

test('packaged apply observes every saved page, recovers lost replies and explicitly applies empty', { timeout: 120000 }, async t => {
  const f = await liveFixture(t);
  await saved(f, 101);
  f.database(db => db.exec('DELETE FROM provider_checkpoints'));
  const staged = await f.select();
  assert.equal((await f.host.discoverProviders())[0].agents[0].name, 'artifact-a');
  const entered = Promise.withResolvers(), finish = Promise.withResolvers();
  let observations = 0;
  f.state.hooks['artifact-b'] = { async snapshot() { if (++observations === 101) { entered.resolve(); await finish.promise; } } };
  const request = f.apply();
  const lost = dropped(f, request, entered.promise);
  try {
    await entered.promise; await lost;
    assert.equal((await f.send(request)).value.outcome.kind, 'applying');
    assert.equal((await f.cli('extensions-status', ['--attempt', 'apply-b'])).operation.outcome.kind, 'applying');
    assert.deepEqual(await f.send(f.apply('other')), { ok: false, error: 'Selection busy' });
    await assert.rejects(f.select('late', 1), /busy/);
    const during = await f.cli('extensions-status');
    assert.equal(during.runtime.id, 'startup');
    finish.resolve();
    const applied = await f.cli('extensions-apply', ['--operation', 'build-b', '--expected-revision', '1', '--request', 'apply-b']);
    assert.equal(applied.outcome.kind, 'applied'); assert.equal(applied.receiptDigest, staged.receiptDigest);
    assert.equal(observations, 101); assert.equal(f.count(f.state.modules[1], 'observe'), 101);
    assert.equal(f.state.modules[0].feeds.length, 101); assert.ok(f.state.modules[0].feeds.every(feed => feed.closes === 1));
    assert.equal(f.state.modules[1].feeds.length, 101); assert.ok(f.state.modules[1].feeds.every(feed => feed.closes === 0));
    assert.equal(f.state.modules.length, 2); assert.equal(f.count(f.state.modules[0], 'dispose'), 1);
    assert.equal((await f.host.discoverProviders())[0].agents[0].name, 'artifact-b');
    await f.select('disable', 1, null);
    assert.deepEqual((await f.send(request)).value, applied);
    const empty = await f.cli('extensions-apply', ['--operation', 'disable', '--expected-revision', '2', '--request', 'apply-empty']);
    assert.equal(empty.outcome.kind, 'applied-empty');
    assert.equal((await f.cli('extensions-status', ['--attempt', 'apply-b'])).operation.outcome.kind, 'applied');
    await f.restart();
    assert.equal((await f.cli('extensions-status')).runtime.kind, 'applied-empty');
    assert.deepEqual((await f.send(request)).value, applied);
    assert.equal(f.state.modules.length, 2);
    assert.ok(!JSON.stringify(f.database(db => db.prepare('SELECT * FROM service_extension_attempts').all())).includes(secret));
  } finally { finish.resolve(); await lost; }
});

test('real active work persists deferred without reads, restart withholds, explicit retry recovers its lost reply', { timeout: 120000 }, async t => {
  const f = await liveFixture(t); await f.select();
  const entered = Promise.withResolvers(), finish = Promise.withResolvers();
  f.state.hooks['artifact-a'] = { async discover() { entered.resolve(); await finish.promise; } };
  const discovery = f.host.discoverProviders(); await entered.promise;
  const original = fs.readFile, reads = [];
  const mock = t.mock.method(fs, 'readFile', async (path, ...args) => { if (String(path).startsWith(f.second.directory + '/')) reads.push(path); return original(path, ...args); });
  syncBuiltinESMExports();
  try {
    assert.deepEqual((await f.send(f.apply())).value.outcome, { kind: 'deferred', reason: 'active-work' });
    assert.deepEqual(reads, []); assert.equal(f.state.modules.length, 1);
  } finally { mock.mock.restore(); syncBuiltinESMExports(); finish.resolve(); await discovery; }
  assert.equal(f.state.modules.length, 1);
  await f.restart();
  assert.equal(f.state.modules.length, 1); assert.deepEqual(f.host.extensionStatus(), { kind: 'empty' });
  const preflight = Promise.withResolvers(), release = Promise.withResolvers();
  const readMock = t.mock.method(fs, 'readFile', async (path, ...args) => {
    if (path === join(f.second.directory, 'customization.json')) { preflight.resolve(); await release.promise; }
    return original(path, ...args);
  }); syncBuiltinESMExports();
  const request = f.retry('retry-b'), lost = dropped(f, request, preflight.promise);
  try {
    await preflight.promise; await lost;
    assert.equal((await f.send(request)).value.outcome.kind, 'applying');
    assert.deepEqual(await f.send(f.retry('competing-retry')), { ok: false, error: 'Selection busy' });
    assert.deepEqual(await f.send(f.apply('build-b')), { ok: false, error: 'Selection id-conflict' });
    assert.deepEqual(await f.send({ ...request, request: { ...request.request, afterAttemptId: 'different' } }), { ok: false, error: 'Selection id-conflict' });
    release.resolve();
    const result = await f.cli('extensions-retry', ['--operation', 'build-b', '--expected-revision', '1', '--request', 'retry-b', '--after-attempt', 'apply-b']);
    assert.equal(result.outcome.kind, 'applied');
    assert.deepEqual((await f.send(request)).value, result);
    assert.deepEqual((await f.send(f.apply())).value.outcome, { kind: 'deferred', reason: 'active-work' });
    assert.equal(f.state.modules.length, 2);
    assert.equal((await f.send(f.retry('stale-retry'))).ok, false);
    await f.select('supersede', 1, null);
    assert.deepEqual((await f.send(request)).value, result);
    assert.equal((await f.send(f.retry('superseded', 'retry-b'))).ok, false);
    await f.restart();
    assert.deepEqual((await f.send(request)).value, result);
  } finally { release.resolve(); readMock.mock.restore(); syncBuiltinESMExports(); await lost; }
});

for (const fault of ['final-write', 'desired-cas', 'observation']) test(`${fault} after replacement never reports applied and promptly freezes credentials without a shutdown cycle`, { timeout: 120000 }, async t => {
  const f = await liveFixture(t); await saved(f, 3); await f.select();
  f.database(db => db.exec('DELETE FROM provider_checkpoints'));
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  let observations = 0;
  f.state.hooks['artifact-b'] = { async snapshot() {
    observations++;
    if (observations === 2) {
      if (fault === 'final-write') f.database(db => db.exec(`CREATE TRIGGER fail_final BEFORE UPDATE ON service_extension_attempts WHEN json_extract(NEW.outcome,'$.kind')='applied' BEGIN SELECT RAISE(ABORT,'PRIVATE_FINAL_FAILURE'); END`));
      if (fault === 'desired-cas') f.database(db => db.exec(`UPDATE service_extension_selections SET revision=revision+1 WHERE id='build-b'`));
      if (fault === 'observation') f.database(db => db.exec("UPDATE conversations SET installation='PRIVATE_BAD_OBSERVATION' WHERE conversation='saved-0002'"));
    }
  }, async close() { entered.resolve(); await release.promise; } };
  const applying = f.send(f.apply());
  try {
    await entered.promise;
    const current = f.state.modules[1];
    let calls = 0;
    await assert.rejects(current.context.credentials.use({ credential: current.credential, service }, async () => { calls++; return secret; }), /credential use refused/);
    assert.equal(calls, 0);
    assert.throws(() => ownDirectory(f.options.directory), /Another host owns/);
    const response = await applying;
    assert.deepEqual(response, { ok: false, error: 'Selection uncertain' });
    const outcome = f.database(db => JSON.parse(db.prepare("SELECT outcome FROM service_extension_attempts WHERE id='apply-b'").get().outcome));
    assert.equal(outcome.kind, fault === 'observation' ? 'failed' : 'applying');
    assert.equal(f.count(current, 'observe') >= 1, true);
    release.resolve(); await f.host.close();
    ownDirectory(f.options.directory).close();
    if (fault !== 'observation') {
      if (fault === 'desired-cas') f.database(db => db.exec("UPDATE service_extension_selections SET revision=1 WHERE id='build-b'"));
      await f.restart();
      assert.equal((await f.cli('extensions-status')).desired.outcome.kind, 'interrupted');
      assert.equal(f.state.modules.length, 2);
    }
  } finally { release.resolve(); await applying; }
});

test('one reservation covers provider activation and competing retry predecessors admit one effect', { timeout: 120000 }, async t => {
  const f = await liveFixture(t); await f.select();
  const discoveryEntered = Promise.withResolvers(), discoveryRelease = Promise.withResolvers();
  f.state.hooks['artifact-a'] = { async discover() { discoveryEntered.resolve(); await discoveryRelease.promise; } };
  const discovery = f.host.discoverProviders(); await discoveryEntered.promise;
  assert.equal((await f.send(f.apply())).value.outcome.kind, 'deferred');
  discoveryRelease.resolve(); await discovery;
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  f.state.hooks['artifact-b'] = { async activate() { entered.resolve(); await release.promise; } };
  const first = f.send(f.retry('winner'));
  try {
    await entered.promise;
    assert.deepEqual(await f.send(f.retry('loser')), { ok: false, error: 'Selection busy' });
    await assert.rejects(f.select('late-selection', 1), /busy/);
    assert.deepEqual(await f.send(f.apply('fresh-apply')), { ok: false, error: 'Selection busy' });
    assert.deepEqual(await f.send(f.apply('winner')), { ok: false, error: 'Selection id-conflict' });
    assert.deepEqual(await f.send({ ...f.retry('winner'), request: { ...f.retry('winner').request, selectionId: 'startup' } }), { ok: false, error: 'Selection id-conflict' });
    const boot = (await f.cli('extensions-status', ['--operation', 'startup'])).operation.attemptId;
    assert.deepEqual(await f.send(f.apply(boot)), { ok: false, error: 'Selection id-conflict' });
    release.resolve(); assert.equal((await first).value.outcome.kind, 'applied');
    assert.equal((await f.send(f.retry('loser'))).ok, false); assert.equal(f.state.modules.length, 2);
  } finally { release.resolve(); await first; }
});

test('matching saved identity and cursor resume exactly one feed while handled unavailability stays a conversation result', { timeout: 120000 }, async t => {
  const f = await liveFixture(t); await saved(f, 1); await f.select();
  const original = f.state.modules[0], cursor = original.feeds[0].request.after;
  assert.equal((await f.send(f.apply())).value.outcome.kind, 'applied');
  const current = f.state.modules[1];
  assert.equal(original.feeds[0].closes, 1); assert.equal(current.feeds.length, 1); assert.equal(current.feeds[0].closes, 0);
  assert.deepEqual(current.feeds[0].request.after, cursor);
  const scope = { hostId: f.host.hostId, conversationId: 'saved-0000' };
  assert.equal((await api(f.host)({ op: 'provider-observation', scope, action: 'read' })).value.kind, 'observing');
  await f.select('unavailable', 1, f.first);
  f.database(db => db.exec('DELETE FROM provider_checkpoints'));
  f.state.hooks['artifact-a'] = { snapshot() { throw new Error('PRIVATE_REMOTE_UNAVAILABLE'); } };
  assert.equal((await f.send(f.apply('apply-unavailable', 'unavailable', 2))).value.outcome.kind, 'applied');
  const status = (await api(f.host)({ op: 'provider-observation', scope, action: 'read' })).value;
  assert.equal(status.kind, 'stopped'); assert.equal(f.host.extensionStatus().kind, 'active');
});

test('closing a live preflight freezes credentials and retains ownership until the interrupted attempt commits', { timeout: 120000 }, async t => {
  const f = await liveFixture(t); await f.select();
  const entered = Promise.withResolvers(), release = Promise.withResolvers(), original = fs.readFile;
  const mock = t.mock.method(fs, 'readFile', async (path, ...args) => {
    if (path === join(f.second.directory, 'customization.json')) { entered.resolve(); await release.promise; }
    return original(path, ...args);
  }); syncBuiltinESMExports();
  const applying = f.send(f.apply());
  let closing;
  try {
    await entered.promise; closing = f.host.close();
    assert.equal(f.host.extensionStatus().kind, 'closing'); assert.throws(() => ownDirectory(f.options.directory), /Another host owns/);
    const old = f.state.modules[0]; let calls = 0;
    await assert.rejects(old.context.credentials.use({ credential: old.credential, service }, async () => { calls++; return secret; }), /credential use refused/);
    assert.equal(calls, 0);
    assert.equal(f.database(db => JSON.parse(db.prepare("SELECT outcome FROM service_extension_attempts WHERE id='apply-b'").get().outcome)).kind, 'applying');
    release.resolve();
    assert.equal((await applying).value.outcome.kind, 'interrupted'); await closing;
    assert.equal(f.state.modules.length, 2); assert.equal(f.count(f.state.modules[1], 'activate'), 0);
    assert.equal(f.host.extensionStatus().kind, 'closed');
    ownDirectory(f.options.directory).close();
    assert.equal(f.database(db => JSON.parse(db.prepare("SELECT outcome FROM service_extension_attempts WHERE id='apply-b'").get().outcome)).kind, 'interrupted');
  } finally { release.resolve(); await applying; await closing; mock.mock.restore(); syncBuiltinESMExports(); }
});

test('live loader failure preserves the immutable receipt and explicit retry verifies the original pins again', { timeout: 120000 }, async t => {
  const f = await liveFixture(t), staged = await f.select();
  const path = join(f.second.directory, 'entries.mjs'), bytes = await fs.readFile(path);
  await fs.writeFile(path, Buffer.concat([bytes, Buffer.from('\nPRIVATE_CHANGED_ARTIFACT')]));
  const failed = (await f.send(f.apply())).value;
  assert.deepEqual(failed.outcome, { kind: 'failed', failure: 'load', recovery: 'replace' });
  assert.equal(failed.receiptDigest, staged.receiptDigest); assert.equal(f.state.modules.length, 1);
  const status = await f.cli('extensions-status');
  assert.equal(status.runtime.kind, 'withheld'); assert.equal(status.lastApplied.id, 'startup');
  await fs.writeFile(path, bytes);
  const retried = (await f.send(f.retry('retry-original'))).value;
  assert.equal(retried.outcome.kind, 'applied'); assert.equal(retried.receiptDigest, staged.receiptDigest); assert.equal(f.state.modules.length, 2);
  assert.deepEqual((await f.send(f.apply())).value, failed);
});
