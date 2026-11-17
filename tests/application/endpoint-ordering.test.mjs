import { NO_OBSERVABILITY } from '../../apps/host/build/tsc/observability.js';
import { recordedInstallation } from '@agentui/host/recorded';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { EXTENSION_SDK_VERSION, RECORDED_RUNTIME } from '@agentui/contracts/compatibility';
import { openRecordedHost } from '@agentui/host/recorded';
import { Access } from '../../apps/host/build/tsc/access.js';
import { openAccessDatabase } from '../../apps/host/build/tsc/access-database.js';
import { createApi } from '../../apps/host/build/tsc/api.js';
import { FeedRegistry } from '../../apps/host/build/tsc/feed-registry.js';
import { serviceEndpoint } from '../../apps/host/build/tsc/service-endpoint.js';

async function fixture(t, credentialClass) {
  const directory = mkdtempSync(join(tmpdir(), 'agentui-admission-'));
  const access = new Access(openAccessDatabase(join(directory, 'host.sqlite')));
  const host = openRecordedHost({ path: join(directory, 'host.sqlite'), backendPath: join(directory, 'recorded.jsonl'), hostId: access.hostId });
  const feeds = new FeedRegistry();
  const compatibility = { wireVersion: 1, extensionSdkVersion: EXTENSION_SDK_VERSION, nativeRuntime: RECORDED_RUNTIME,
    desiredGitRevision: 'test', appliedArtifact: { artifactId: 'test', gitRevision: 'test' } };
  let closing = false;
  let observeGate = () => {};
  const isClosing = () => { observeGate(); return closing; };
  const api = createApi({ host, feeds, agentSelection: { kind: 'native', defaultInstallation: recordedInstallation, agents: [{ installation: recordedInstallation, availability: { kind: 'ready' } }] }, compatibility, isClosing });
  const handler = serviceEndpoint(credentialClass === 'native' ? { observability: NO_OBSERVABILITY, access, api, credentialClass, isClosing }
    : { observability: NO_OBSERVABILITY, access, api, credentialClass, isClosing, files: new Map([['browser.html', Buffer.from('test asset')]]) });
  const server = createServer((req, res) => { void handler(req, res).catch(() => res.destroy()); });
  t.after(async () => {
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    feeds.dispose(); host.close(); await host.drained; access.close();
    rmSync(directory, { recursive: true, force: true });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const headers = credentialClass === 'native' ? {} : { Origin: origin };
  const path = credentialClass === 'native' ? '/native/v1' : '/api/v1';
  const send = (body, extraHeaders = {}, extraPath = path) => fetch(`${origin}${extraPath}`, {
    method: 'POST', headers: { ...headers, 'Content-Type': 'application/json', ...extraHeaders },
    body: typeof body === 'string' ? body : JSON.stringify(body), signal: AbortSignal.timeout(2000),
  });
  return { access, origin, headers, path, send,
    closeGate() { closing = true; },
    reopenGate() { closing = false; },
    nextGate(count = 1) { return new Promise(resolve => { observeGate = () => { if (--count === 0) resolve(); }; }); },
  };
}

for (const credentialClass of ['browser-development', 'native']) {
  test(`${credentialClass} malformed body without credentials is rejected as invalid`, async t => {
    const f = await fixture(t, credentialClass);
    const response = await f.send('{');
    assert.equal(response.status, 400);
  });

  test(`${credentialClass} shutdown during body read refuses the request without running it`, { timeout: 3000 }, async t => {
    const f = await fixture(t, credentialClass);
    const body = JSON.stringify({ op: 'metadata' });
    const admittedHeaders = f.nextGate();
    let outgoing;
    const reply = new Promise((resolve, reject) => {
      outgoing = request(`${f.origin}${f.path}`, {
        method: 'POST', headers: { ...f.headers, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      }, incoming => {
        let text = '';
        incoming.setEncoding('utf8').on('data', part => { text += part; });
        incoming.on('end', () => resolve({ status: incoming.statusCode, body: JSON.parse(text) }));
      });
      outgoing.on('error', reject);
      outgoing.write(body.slice(0, 1));
    });
    await admittedHeaders;
    f.closeGate();
    outgoing.end(body.slice(1));
    assert.deepEqual(await reply, { status: 503, body: { ok: false, error: { kind: 'unavailable', message: 'Host is shutting down' } } });
    f.reopenGate();
    assert.equal((await f.send(body)).status, 200);
  });

  test(`${credentialClass} pairing requests are refused as invalid`, async t => {
    const f = await fixture(t, credentialClass);
    const code = 'A'.repeat(32);
    assert.equal((await f.send({ op: 'pair', code })).status, 400);
    if (credentialClass === 'native') assert.equal((await f.send({ version: 1, hostId: f.access.hostId, code }, {}, '/native/v1/pair')).status, 400);
  });

}

test('browser static assets preserve headers and bypass closing and authentication', async t => {
  const f = await fixture(t, 'browser-development');
  f.closeGate();
  const response = await fetch(f.origin);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'test asset');
  assert.equal(response.headers.get('x-frame-options'), 'DENY');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  const head = await fetch(f.origin, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
});
