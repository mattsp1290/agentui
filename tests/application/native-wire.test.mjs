import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Access } from '../../apps/host/build/tsc/access.js';
import { openAccessDatabase } from '../../apps/host/build/tsc/access-database.js';
import { requestControl } from '../../apps/host/build/tsc/control.js';
import { parseNativeCredential, parseNativePairRequest } from '../../apps/host/build/tsc/native-wire.js';

test('generated invitations and credentials round-trip through the native pairing contract', t => {
  const directory = mkdtempSync(join(tmpdir(), 'agentui-wire-'));
  const access = new Access(openAccessDatabase(join(directory, 'host.sqlite')));
  t.after(() => { access.close(); rmSync(directory, { recursive: true, force: true }); });
  for (const credentialClass of ['browser-development', 'native']) {
    const request = { version: 1, hostId: access.hostId, code: access.invite(credentialClass) };
    assert.deepEqual(parseNativePairRequest(request), request);
    const paired = access.pair(request.code, credentialClass);
    const credential = { hostId: paired.principal.hostId, principalId: paired.principal.id, secret: paired.secret };
    assert.deepEqual(parseNativeCredential(credential), credential);
  }
});

test('native pair and credential parsers reject malformed or extended wire values', () => {
  const request = { version: 1, hostId: 'host', code: 'A'.repeat(32) };
  for (const value of [null, [], { ...request, version: 2 }, { ...request, extra: true },
    { ...request, hostId: '' }, { ...request, code: 'A'.repeat(31) }, { ...request, code: 'A'.repeat(33) },
    { ...request, code: '!'.repeat(32) }, { ...request, code: 'A'.repeat(32) + '\n' }, { ...request, code: 32 }]) {
    assert.throws(() => parseNativePairRequest(value));
  }
  const credential = { hostId: 'host', principalId: 'device', secret: 'A'.repeat(43) };
  for (const value of [null, [], { ...credential, extra: true }, { ...credential, hostId: '' },
    { ...credential, principalId: '' }, { ...credential, secret: 'A'.repeat(42) },
    { ...credential, secret: 'A'.repeat(44) }, { ...credential, secret: '!'.repeat(43) },
    { ...credential, secret: 'A'.repeat(43) + '\n' }, { ...credential, secret: 43 }]) {
    assert.throws(() => parseNativeCredential(value));
  }
});

test('native invitation control replies reject malformed invitation codes', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'agentui-wire-control-'));
  const path = join(directory, 'control.sock');
  const server = createServer(socket => {
    socket.once('data', () => socket.end(JSON.stringify({ ok: true, value: { hostId: 'host', code: 'A'.repeat(31) } }) + '\n'));
  });
  await new Promise(resolve => server.listen(path, resolve));
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    rmSync(directory, { recursive: true, force: true });
  });
  await assert.rejects(requestControl(path, { op: 'invite-native' }));
});
