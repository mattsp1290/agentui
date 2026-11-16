import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { requestControl } from '../../../apps/host/build/tsc/control.js';
import { ownDirectory } from '../../../apps/host/build/tsc/ownership.js';
import { fixture, packagedHost, secret, service } from './artifact-support.mjs';

test('durable shutdown freezes providers while candidate artifact preflight drains', { timeout: 120000 }, async t => {
  const runtime = await packagedHost(t), f = await fixture(t, runtime);
  const host = await runtime.startBrowserHost({ ...f.options,
    extensions: { kind: 'durable-artifacts', entries: [f.selected(f.first, 'artifact-a')] } });
  const databasePath = await fs.realpath(join(f.options.directory, 'host.sqlite'));
  const old = f.state.modules[0], discoveryEntered = Promise.withResolvers(), finishDiscovery = Promise.withResolvers();
  const preflightEntered = Promise.withResolvers(), finishPreflight = Promise.withResolvers(), disposed = Promise.withResolvers();
  f.state.hooks['artifact-a'] = {
    async discover() { discoveryEntered.resolve(); await finishDiscovery.promise; },
    dispose() { disposed.resolve(); },
  };
  const discovery = host.discoverProviders().then(value => ({ value }), error => ({ error }));
  await discoveryEntered.promise;
  const readFile = fs.readFile, closeDatabase = DatabaseSync.prototype.close, closedDatabases = [];
  const readMock = t.mock.method(fs, 'readFile', async (path, ...args) => {
    if (path === join(f.second.directory, 'customization.json')) {
      preflightEntered.resolve(); await finishPreflight.promise;
    }
    return readFile(path, ...args);
  });
  const closeMock = t.mock.method(DatabaseSync.prototype, 'close', function () {
    if (this.location() === databasePath) closedDatabases.push(this);
    return closeDatabase.call(this);
  });
  syncBuiltinESMExports();
  const selecting = requestControl(join(f.options.directory, 'control.sock'), { op: 'extensions-select', command: {
    id: 'shutdown-candidate', expectedRevision: 0,
    selection: { version: 1, artifacts: [{ directory: f.second.directory, artifactId: f.second.manifest.artifactId }] },
  } });
  let closing;
  try {
    await preflightEntered.promise;
    closing = host.close();
    assert.equal(host.close(), closing);
    assert.deepEqual(host.extensionStatus(), { kind: 'closing' });
    let credentialCallbacks = 0;
    const provisioned = f.provisioned;
    await assert.rejects(old.context.credentials.use({ credential: old.credential, service }, async () => {
      credentialCallbacks++; return secret;
    }), /credential use refused/);
    assert.equal(credentialCallbacks, 0); assert.equal(f.provisioned, provisioned);
    finishDiscovery.resolve();
    assert.match((await discovery).error?.message ?? '', /Provider discovery failed/);
    await disposed.promise;
    assert.equal(f.count(old, 'close'), 1); assert.equal(f.count(old, 'dispose'), 1);
    assert.deepEqual(closedDatabases, []);
    assert.throws(() => ownDirectory(f.options.directory), /Another host owns/);
    finishPreflight.resolve();
    assert.deepEqual(await selecting, { ok: false, error: 'Selection unavailable' });
    await closing;
    assert.deepEqual(host.extensionStatus(), { kind: 'closed' });
    assert.equal(closedDatabases.length, 2);
    for (const database of closedDatabases) assert.throws(() => database.prepare('SELECT 1'), /not open/);
    assert.equal(f.state.modules.length, 1);
    assert.equal(f.count(old, 'close'), 1); assert.equal(f.count(old, 'dispose'), 1);
    ownDirectory(f.options.directory).close();
  } finally {
    finishDiscovery.resolve(); finishPreflight.resolve();
    await Promise.allSettled([discovery, selecting, closing ?? host.close()]);
    readMock.mock.restore(); syncBuiltinESMExports(); closeMock.mock.restore();
  }
  const database = new DatabaseSync(join(f.options.directory, 'host.sqlite'));
  try {
    assert.deepEqual(database.prepare('SELECT id, revision FROM service_extension_selections').all().map(row => ({ ...row })),
      [{ id: 'startup', revision: 0 }]);
  } finally { database.close(); }
});
