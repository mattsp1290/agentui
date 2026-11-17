import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { openAccessDatabase } from '../../apps/host/build/tsc/access-database.js';
import { ownerPrincipal } from '../../apps/host/build/tsc/principal.js';
import { ownDirectory } from '../../apps/host/build/tsc/ownership.js';

function directory(t) {
  const directory = mkdtempSync(join(tmpdir(), 'agentui-service-access-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}
test('every request resolves to the fixed owner principal on this host only', t => {
  const access = openAccessDatabase(join(directory(t), 'host.sqlite'));
  t.after(() => access.database.close());
  assert.deepEqual(ownerPrincipal(access.hostId), { id: 'trusted-owner', hostId: access.hostId });
});
test('a pre-existing host database with paired devices opens, drops the device table and keeps its identity', t => {
  const path = join(directory(t), 'host.sqlite');
  const legacy = new DatabaseSync(path);
  legacy.exec(`CREATE TABLE service_schema (singleton INTEGER PRIMARY KEY CHECK(singleton=1), version INTEGER NOT NULL);
    INSERT INTO service_schema VALUES(1,1);
    CREATE TABLE service_identity (singleton INTEGER PRIMARY KEY CHECK(singleton=1), host TEXT NOT NULL);
    INSERT INTO service_identity VALUES(1,'legacy-host');
    CREATE TABLE service_devices (id TEXT PRIMARY KEY, digest TEXT NOT NULL UNIQUE, host TEXT NOT NULL,
      credential_class TEXT NOT NULL CHECK(credential_class IN ('browser-development','native')), expires INTEGER NOT NULL,
      policy TEXT NOT NULL CHECK(policy='owner'), revoked INTEGER NOT NULL CHECK(revoked IN (0,1)));
    INSERT INTO service_devices VALUES('device','digest','legacy-host','native',9999999999999,'owner',0);
    CREATE TABLE service_provider_credentials (handle TEXT PRIMARY KEY, host TEXT NOT NULL,
      namespace TEXT NOT NULL, contribution TEXT NOT NULL, installation TEXT NOT NULL, generation TEXT NOT NULL,
      protocol TEXT NOT NULL, service TEXT NOT NULL, revision TEXT NOT NULL, revoked INTEGER NOT NULL CHECK(revoked IN (0,1)),
      UNIQUE(host,namespace,contribution,installation,generation,protocol,service,revision));
    INSERT INTO service_provider_credentials VALUES('handle','legacy-host','ns','contribution','installation','generation','protocol','service','revision',0);`);
  legacy.close();
  const tables = db => db.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all().map(row => row.name);
  for (let open = 0; open < 2; open++) {
    const state = openAccessDatabase(path);
    try {
      assert.equal(state.hostId, 'legacy-host');
      assert.deepEqual(tables(state.database), ['service_identity', 'service_provider_credentials', 'service_schema']);
      assert.equal(state.database.prepare('SELECT version FROM service_schema').get().version, 2);
      assert.equal(state.database.prepare('SELECT handle FROM service_provider_credentials').get().handle, 'handle');
    } finally { state.database.close(); }
  }
  assert.equal(statSync(path).mode & 0o077, 0);
});
test('a fresh host database has no device table and an unknown access schema version is refused', t => {
  const path = join(directory(t), 'host.sqlite');
  const state = openAccessDatabase(path);
  assert.equal(state.database.prepare("SELECT 1 FROM sqlite_schema WHERE name='service_devices'").get(), undefined);
  assert.equal(state.database.prepare('SELECT version FROM service_schema').get().version, 2);
  state.database.exec('UPDATE service_schema SET version=3');
  state.database.close();
  assert.throws(() => openAccessDatabase(path), /Unsupported host access schema/);
});
test('exclusive directory ownership recovers after a killed process without stale PID handling', { timeout: 10000 }, async t => {
  const path = directory(t);
  const module = new URL('../../apps/host/build/tsc/ownership.js', import.meta.url).href;
  const child = spawn(process.execPath, ['--input-type=module', '-e',
    `import { ownDirectory } from ${JSON.stringify(module)}; ownDirectory(${JSON.stringify(path)}); process.stdout.write('owned\\n'); setInterval(()=>{},1000);`], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => child.kill('SIGKILL'));
  await once(child.stdout, 'data');
  assert.throws(() => ownDirectory(path), /Another host owns/);
  const exited = once(child, 'exit');
  child.kill('SIGKILL');
  await exited;
  const owner = ownDirectory(path);
  owner.close();
  owner.close();
  const again = ownDirectory(path);
  again.close();
});


test('a control socket path that exceeds the portable limit is rejected before creating a directory', t => {
  const path = join(directory(t), 'x'.repeat(110));
  assert.throws(() => ownDirectory(path), /--data-dir path is too long/);
});
