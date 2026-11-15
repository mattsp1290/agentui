import { NO_OBSERVABILITY } from '../../apps/host/build/tsc/observability.js';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Access } from '../../apps/host/build/tsc/access.js';
import { openAccessDatabase } from '../../apps/host/build/tsc/access-database.js';
import { serviceEndpoint } from '../../apps/host/build/tsc/service-endpoint.js';

const diagnostic = 'INJECTED_PAIR_SUCCESS_WRITE_DIAGNOSTIC';

for (const credentialClass of ['browser-development', 'native']) {
  test(`${credentialClass} pairing reply failure preserves committed device and reports unavailable`, { timeout: 5000 }, async t => {
    const directory = mkdtempSync(join(tmpdir(), 'agentui-pair-reply-'));
    const databasePath = join(directory, 'access.sqlite');
    const access = new Access(openAccessDatabase(databasePath));
    const code = access.invite(credentialClass);
    let injections = 0;
    let committedAtFailure = false;
    const handler = serviceEndpoint({ observability: NO_OBSERVABILITY,
      access, credentialClass, files: new Map(), isClosing: () => false,
      api: async () => { assert.fail('Pairing must not dispatch the service API'); },
    });
    const server = createServer((request, response) => {
      assert.ok(response instanceof ServerResponse);
      const writeHead = response.writeHead;
      response.writeHead = function (status, ...args) {
        if (status === 200 && injections === 0) {
          injections++;
          assert.equal(access.devices().length, 1);
          assert.throws(() => access.pair(code, credentialClass), /Invalid or expired pairing invitation/);
          committedAtFailure = true;
          throw new Error(diagnostic);
        }
        return writeHead.call(this, status, ...args);
      };
      void handler(request, response).catch(error => response.destroy(error));
    });
    t.after(async () => {
      await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
      access.close();
      rmSync(directory, { recursive: true, force: true });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const native = credentialClass === 'native';
    const send = () => fetch(`${origin}${native ? '/native/v1/pair' : '/api/v1'}`, {
      method: 'POST', signal: AbortSignal.timeout(2000),
      headers: { 'Content-Type': 'application/json', ...(native ? {} : { Origin: origin }) },
      body: JSON.stringify(native ? { version: 1, hostId: access.hostId, code } : { op: 'pair', code }),
    });
    const response = await send();
    const raw = await response.text();
    assert.equal(injections, 1);
    assert.equal(committedAtFailure, true);
    assert.equal(response.status, 503);
    assert.equal(response.headers.get('set-cookie'), null);
    assert.deepEqual(JSON.parse(raw), { ok: false, error: { kind: 'unavailable', message: 'Host request did not complete' } });
    assert.ok(!raw.includes(diagnostic));
    for (const [, value] of response.headers) assert.ok(!value.includes(diagnostic));
    const persisted = new Access(openAccessDatabase(databasePath));
    try {
      assert.deepEqual(persisted.devices(), access.devices());
      assert.equal(persisted.devices().length, 1);
      assert.equal(persisted.devices()[0].active, true);
    } finally { persisted.close(); }
    const retry = await send();
    assert.equal(retry.status, 401);
    assert.equal((await retry.json()).error.kind, 'unauthorized');
    assert.equal(access.devices().length, 1);

  });
}
