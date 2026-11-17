import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import test from 'node:test';
import { Access } from '../../apps/host/build/tsc/access.js';
import { openAccessDatabase } from '../../apps/host/build/tsc/access-database.js';
const openAccess = path => new Access(openAccessDatabase(path));
import { ownDirectory } from '../../apps/host/build/tsc/ownership.js';

function directory(t) {
  const directory = mkdtempSync(join(tmpdir(), 'agentui-service-access-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}
test('every credential class resolves to the fixed owner principal on this host only', t => {
  const access = openAccess(join(directory(t), 'host.sqlite'));
  t.after(() => access.close());
  for (const credentialClass of ['browser-development', 'native']) {
    assert.deepEqual(access.owner(credentialClass), { id: 'trusted-owner', hostId: access.hostId, credentialClass });
  }
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
