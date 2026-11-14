import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import test from 'node:test';
import { Access } from '../../apps/host/dist/access.js';
import { ownDirectory } from '../../apps/host/dist/ownership.js';

function directory(t) {
  const directory = mkdtempSync(join(tmpdir(), 'agentui-service-access-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}
test('pairing invitations are one use, expire, remain process-local and never store device secrets', t => {
  const path = join(directory(t), 'host.sqlite');
  let access = new Access(path);
  const hostId = access.hostId;
  const code = access.invite('browser-development', 1000);
  const { principal, secret } = access.pair(code, 'browser-development', 1000);
  assert.deepEqual(access.authenticate(secret, 'browser-development', 1000), principal);
  assert.equal(access.authorized({ ...principal, hostId: 'other-host' }, 'browser-development', 1000), false);
  assert.equal(access.authenticate(secret, 'native', 1000), null);
  assert.equal(access.authenticate(secret, 'browser-development', 3601000), null);
  assert.throws(() => access.pair(code, 'browser-development', 1001));
  const expired = access.invite('browser-development', 1000);
  assert.throws(() => access.pair(expired, 'browser-development', 301000));
  const old = access.invite('browser-development');
  access.close();
  const bytes = readFileSync(path);
  assert.equal(bytes.includes(Buffer.from(secret)), false);
  assert.equal(bytes.includes(Buffer.from(code)), false);
  assert.equal(statSync(path).mode & 0o077, 0);
  access = new Access(path);
  t.after(() => access.close());
  assert.equal(access.hostId, hostId);
  assert.deepEqual(access.authenticate(secret, 'browser-development', 1000), principal);
  assert.throws(() => access.pair(old, 'browser-development'));
  access.revoke(principal.id);
  assert.equal(access.authenticate(secret, 'browser-development', 1000), null);
  assert.equal(access.authorized(principal, 'browser-development', 1000), false);
  assert.deepEqual(access.devices(), [{ id: principal.id, revoked: true, expires: 3601000, active: false }]);
});
test('invitations and failed attempts are bounded', t => {
  const access = new Access(join(directory(t), 'host.sqlite'));
  t.after(() => access.close());
  for (let i = 0; i < 32; i++) access.invite('browser-development', 1000);
  assert.throws(() => access.invite('browser-development', 1000), /limit/);
  assert.equal(typeof access.invite('browser-development', 301001), 'string');
  for (let i = 0; i < 20; i++) assert.throws(() => access.pair('wrong', 'browser-development', 1000), /Invalid/);
  assert.throws(() => access.pair('wrong', 'browser-development', 1000), /attempt limit/);
  const valid = access.invite('browser-development', 1000);
  assert.equal(access.pair(valid, 'browser-development', 1000).principal.hostId, access.hostId);
  assert.throws(() => access.pair('wrong', 'browser-development', 1000, 'another-source'), /Invalid/);
  assert.throws(() => access.pair('wrong', 'browser-development', 61001), /Invalid/);
});
test('exclusive directory ownership recovers after a killed process without stale PID handling', { timeout: 10000 }, async t => {
  const path = directory(t);
  const module = new URL('../../apps/host/dist/ownership.js', import.meta.url).href;
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
