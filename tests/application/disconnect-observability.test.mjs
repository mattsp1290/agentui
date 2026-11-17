import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { assertPrivateValuesAbsent, assertRequestSpan, attributes, receiver } from './support/observability.mjs';
import { Access } from '../../apps/host/build/tsc/access.js';
import { openAccessDatabase } from '../../apps/host/build/tsc/access-database.js';
import { createHostObservability } from '../../apps/host/build/tsc/observability.js';
import { serviceEndpoint } from '../../apps/host/build/tsc/service-endpoint.js';

const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};

async function fixture(t, credentialClass, api) {
  const collector = await receiver(t);
  const exports = collector.received;
  const directory = mkdtempSync(join(tmpdir(), 'agentui-observability-disconnect-'));
  const access = new Access(openAccessDatabase(join(directory, 'host.sqlite')));
  const observability = createHostObservability({ kind: 'otlp',
    endpoint: `${collector.endpoint}/v1/traces`, headers: {},
    serviceName: 'agentui-host', datadogLlmObservability: false });
  const handler = serviceEndpoint({ credentialClass, access, api, observability,
    isClosing: () => false, ...(credentialClass === 'browser-development' ? { files: new Map() } : {}) });
  const receipts = [];
  const received = deferred();
  const server = createServer((incoming, outgoing) => {
    const bodyStarted = deferred();
    const closed = deferred();
    const receipt = { response: outgoing, bodyStarted: bodyStarted.promise, closed: closed.promise };
    receipts.push(receipt);
    incoming.once('data', bodyStarted.resolve);
    outgoing.once('close', closed.resolve);
    receipt.handled = handler(incoming, outgoing);
    received.resolve(receipt);
  });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await observability.close();
    access.close();
    rmSync(directory, { recursive: true, force: true });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const headers = { 'Content-Type': 'application/json', ...(credentialClass === 'native' ? {} : { Origin: origin }) };
  const endpoint = `${origin}${credentialClass === 'native' ? '/native/v1' : '/api/v1'}`;
  return { exports, receipts, received: received.promise, headers, endpoint,
    privateValues: [access.hostId],
    flush: async () => {
      await Promise.all(receipts.map(receipt => receipt.handled));
      await observability.close();
      return exports.flatMap(value => {
        assert.equal(value.path, '/v1/traces');
        return value.body.resourceSpans.flatMap(resource => {
          assert.deepEqual(attributes(resource.resource.attributes), { 'service.name': 'agentui-host' });
          return resource.scopeSpans.flatMap(scope => scope.spans);
        });
      });
    } };
}

function checkSpan(span, expected, privateValues, exports) {
  assertRequestSpan(span, expected);
  assertPrivateValuesAbsent(exports, privateValues);
}

test('a browser body disconnect exports invalid admission without inventing an HTTP response status', { timeout: 15_000 }, async t => {
  let apiCalls = 0;
  const f = await fixture(t, 'browser-development', async () => { apiCalls += 1; return null; });
  const privateBody = 'private-partial-body-8f16f0';
  const privateHeader = 'private-disconnect-header-a70ac5';
  let responseCount = 0;
  const client = request(f.endpoint, { method: 'POST', headers: { ...f.headers,
    'Content-Length': '1000', 'X-Private': privateHeader } }, () => { responseCount += 1; });
  client.on('error', () => {});
  t.after(() => client.destroy());
  client.write(`{"op":"search","query":"${privateBody}`);
  const receipt = await f.received;
  await receipt.bodyStarted;
  client.destroy();
  await receipt.closed;
  const spans = await f.flush();
  assert.equal(apiCalls, 0);
  assert.equal(responseCount, 0, 'the client received no HTTP response headers');
  assert.equal(receipt.response.headersSent, false, 'the host emitted no HTTP response headers');
  assert.equal(spans.length, 1);
  checkSpan(spans[0], { 'agentui.operation': 'admission', 'agentui.credential_class': 'browser-development',
    'agentui.outcome': 'invalid' }, [...f.privateValues, privateBody, privateHeader], f.exports);
});

test('a native disconnect during an admitted operation exports success without inventing an HTTP response status', { timeout: 15_000 }, async t => {
  const entered = deferred();
  const release = deferred();
  t.after(release.resolve);
  const privateBody = 'private-completed-operation-result-2d11e1';
  const f = await fixture(t, 'native', async () => {
    entered.resolve();
    await release.promise;
    return { private: privateBody };
  });
  let responseCount = 0;
  const client = request(f.endpoint, { method: 'POST', headers: f.headers }, () => { responseCount += 1; });
  client.on('error', () => {});
  t.after(() => client.destroy());
  client.end(JSON.stringify({ op: 'metadata' }));
  const receipt = await f.received;
  await entered.promise;
  client.destroy();
  await receipt.closed;
  assert.equal(receipt.response.headersSent, false, 'disconnect happened before the operation returned');
  release.resolve();
  const spans = await f.flush();
  assert.equal(responseCount, 0, 'the client received no HTTP response headers');
  assert.equal(receipt.response.headersSent, false, 'completion must not write headers to a destroyed response');
  assert.equal(spans.length, 1);
  checkSpan(spans[0], { 'agentui.operation': 'metadata', 'agentui.credential_class': 'native',
    'agentui.outcome': 'ok' }, [...f.privateValues, privateBody], f.exports);
});

test('written success and admission failure export their actual HTTP response statuses', { timeout: 15_000 }, async t => {
  const f = await fixture(t, 'native', async () => ({ private: 'private-normal-result-15ced3' }));
  const success = await fetch(f.endpoint, { method: 'POST', headers: f.headers,
    body: JSON.stringify({ op: 'metadata' }), signal: AbortSignal.timeout(5000) });
  assert.equal(success.status, 200);
  assert.deepEqual(await success.json(), { ok: true, value: { private: 'private-normal-result-15ced3' } });
  const failure = await fetch(f.endpoint, { method: 'POST', headers: f.headers,
    body: '{', signal: AbortSignal.timeout(5000) });
  assert.equal(failure.status, 400);
  assert.equal((await failure.json()).error.kind, 'invalid');
  const spans = await f.flush();
  assert.equal(spans.length, 2);
  assert.ok(f.receipts.every(receipt => receipt.response.headersSent));
  for (const [index, expected] of [
    { 'agentui.operation': 'metadata', 'agentui.credential_class': 'native', 'agentui.outcome': 'ok', 'http.response.status_code': 200 },
    { 'agentui.operation': 'admission', 'agentui.credential_class': 'native', 'agentui.outcome': 'invalid', 'http.response.status_code': 400 },
  ].entries()) checkSpan(spans[index], expected, [...f.privateValues, 'private-normal-result-15ced3'], f.exports);
});
