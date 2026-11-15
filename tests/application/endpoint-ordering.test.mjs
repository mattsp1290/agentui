import { NO_OBSERVABILITY } from '../../apps/host/build/tsc/observability.js';
import { describeAgent } from '../../apps/host/build/tsc/agents.js';
import { recordedInstallation } from '@agentui/host/recorded';
const recordedAgentId = describeAgent(recordedInstallation, { kind: 'ready' }).id;
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
  const api = createApi({ access, host, feeds, compatibility, credentialClass, isClosing });
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
  const enroll = () => access.pair(access.invite(credentialClass), credentialClass);
  const auth = secret => credentialClass === 'native' ? { Authorization: `Bearer ${secret}` }
    : { Cookie: `agentui_device_${access.hostId}=${secret}` };
  return { access, feeds, origin, headers, path, send, enroll, auth,
    closeGate() { closing = true; },
    reopenGate() { closing = false; },
    nextGate(count = 1) { return new Promise(resolve => { observeGate = () => { if (--count === 0) resolve(); }; }); },
  };
}

test('native unauthenticated service responds before any body arrives', { timeout: 3000 }, async t => {
  const f = await fixture(t, 'native');
  const result = await new Promise((resolve, reject) => {
    const outgoing = request(`${f.origin}${f.path}`, { method: 'POST', headers: {
      'Content-Type': 'application/json', 'Content-Length': 100,
    } }, incoming => {
      let text = '';
      incoming.setEncoding('utf8').on('data', part => { text += part; });
      incoming.on('end', () => { resolve({ status: incoming.statusCode, body: JSON.parse(text) }); outgoing.destroy(); });
    });
    outgoing.on('error', reject);
    outgoing.setTimeout(1500, () => outgoing.destroy(new Error('Handler consumed an unauthenticated body')));
    outgoing.flushHeaders();
  });
  assert.equal(result.status, 401);
  assert.equal(result.body.error.kind, 'unauthorized');
});

for (const credentialClass of ['browser-development', 'native']) {
  test(`${credentialClass} malformed unauthenticated body preserves class ordering`, async t => {
    const f = await fixture(t, credentialClass);
    const response = await f.send('{');
    assert.equal(response.status, credentialClass === 'native' ? 401 : 400);
  });

  test(`${credentialClass} shutdown during pairing body read leaves invitation usable`, { timeout: 3000 }, async t => {
    const f = await fixture(t, credentialClass);
    const code = f.access.invite(credentialClass);
    const body = JSON.stringify(credentialClass === 'native' ? { version: 1, hostId: f.access.hostId, code } : { op: 'pair', code });
    const admittedHeaders = f.nextGate();
    let outgoing;
    const reply = new Promise((resolve, reject) => {
      outgoing = request(`${f.origin}${credentialClass === 'native' ? '/native/v1/pair' : f.path}`, {
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
    const path = credentialClass === 'native' ? '/native/v1/pair' : f.path;
    assert.equal((await f.send(body, {}, path)).status, 200);
    assert.equal((await f.send(body, {}, path)).status, 401);
  });

  test(`${credentialClass} real API revocation check runs after an admitted pull`, { timeout: 3000 }, async t => {
    const f = await fixture(t, credentialClass);
    const { principal, secret } = f.enroll(), auth = f.auth(secret);
    const scope = { hostId: f.access.hostId, conversationId: 'revoked-admitted-pull' };
    assert.equal((await f.send({ op: 'create', agentId: recordedAgentId, scope }, auth)).status, 200);
    const { value: { feedId } } = await (await f.send({ op: 'watch', scope, after: null, projectionVersion: 2 }, auth)).json();
    const { value: page } = await (await f.send({ op: 'pull', feedId, ack: null }, auth)).json();
    const started = f.nextGate(2);
    const pending = f.send({ op: 'pull', feedId, ack: page.page }, auth);
    await started;
    f.access.revoke(principal.id);
    f.feeds.closePrincipal(principal.id);
    const response = await pending;
    assert.equal(response.status, 401);
    assert.equal((await response.json()).error.message, 'Device access was revoked');
    assert.equal((await f.send({ op: 'metadata' }, auth)).status, 401);
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

test('native pairing uses its own 4096 byte bound and keeps the invitation on refusal', async t => {
  const f = await fixture(t, 'native');
  const code = f.access.invite('native');
  const pairing = JSON.stringify({ version: 1, hostId: f.access.hostId, code });
  const response = await f.send(pairing.padEnd(4097, ' '), {}, '/native/v1/pair');
  assert.equal(response.status, 400);
  assert.equal((await f.send(pairing, {}, '/native/v1/pair')).status, 200);
});
