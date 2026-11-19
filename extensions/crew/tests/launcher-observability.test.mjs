import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { assertBoundedRequestSpans, receiver } from '../../../tests/application/support/observability.mjs';
import { browserRequest, exitWithin, launchProcess, startup } from '../../../tests/application/support/host-process.mjs';

const token = 'private-launcher-crew-token-718dad';

async function listen(t, handler) {
  const server = createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  return `http://127.0.0.1:${server.address().port}`;
}

async function fixture(t, collector, settings) {
  const calls = [];
  const memberId = randomUUID();
  const service = await listen(t, (request, response) => {
    calls.push({ path: request.url, headers: request.headers });
    const json = body => { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(body)); };
    if (request.url === '/v1/capabilities') return json({ apiVersion: '1', requestContract: 'sql-admission-temporal-queue-v1',
      observation: { protocol: 'AG-UI', mode: 'snapshot-and-bounded-tail' }, initiatorKinds: ['owner'] });
    if (request.url === '/v1/members') return json({ apiVersion: '1', members: [{ memberId, engine: 'codex', profile: 'private-remote-profile-7f83' }], next: null });
    response.writeHead(404); response.end();
  });
  const directory = await mkdtemp(join(tmpdir(), 'agentui-crew-launcher-'));
  const hostDirectory = join(directory, 'host'), tokenFile = join(directory, 'private-token');
  const configFile = join(directory, 'crew-provider.json');
  const installationId = 'private-installation-4bac', generation = 'private-generation-d1cb';
  await writeFile(tokenFile, token, { mode: 0o600 });
  await writeFile(configFile, JSON.stringify({ service, memberId, installationId, generation,
    credentialRevision: 'private-revision-c4e2', tokenFile, directory: hostDirectory, port: 0 }), { mode: 0o600 });
  const environment = { OTEL_EXPORTER_OTLP_ENDPOINT: collector.endpoint, ...settings };
  const host = launchProcess(t, ['extensions/crew/run.mjs', configFile], environment);
  t.after(() => rm(directory, { recursive: true, force: true }));
  const started = startup(host, line => {
    const match = /^AgentUI with Crew is ready at (http:\/\/[^/]+)\/browser\.html$/.exec(line);
    return match && { origin: match[1] };
  });
  return { calls, host, started, environment,
    secrets: [token, directory, hostDirectory, tokenFile, installationId, generation, memberId, 'private-remote-profile-7f83'] };
}

test('Crew launcher exports bounded request spans and keeps collector credentials and private values out of Crew traffic and spans', { timeout: 25_000 }, async t => {
  const privateSearch = 'private-crew-search-495c', privateHeader = 'private-crew-header-0eac';
  const resourceCanary = 'private-crew-resource-51e7';
  const traceId = '11111111111111111111111111111111', parentId = '2222222222222222';
  const collector = await receiver(t);
  const f = await fixture(t, collector, { OTEL_TRACES_EXPORTER: 'otlp', OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json',
    OTEL_SERVICE_NAME: 'agentui-crew-launcher-test', OTEL_RESOURCE_ATTRIBUTES: `private.resource=${resourceCanary}`,
    OTEL_EXPORTER_OTLP_HEADERS: 'x-collector-token=general,x-general-token=general%20token',
    OTEL_EXPORTER_OTLP_TRACES_HEADERS: 'x-collector-token=private%20collector%3Dtoken' });
  const ready = await f.started;
  assert.equal(ready.kind, 'ready', f.host.stderr);
  assert.ok(f.calls.some(call => call.path === '/v1/capabilities'), 'launcher activates Crew discovery');
  assert.ok(f.calls.some(call => call.path === '/v1/members'), 'launcher discovers the configured Crew member');
  const browser = (body, headers) => browserRequest(ready.origin, body, '', headers);
  const headers = { 'x-private': privateHeader, baggage: `private=${privateHeader}`, traceparent: `00-${traceId}-${parentId}-01` };
  const metadata = await browser({ op: 'metadata' }, headers);
  assert.equal(metadata.status, 200, JSON.stringify(metadata.body));
  assert.ok(metadata.body.value.agents.some(agent => agent.kind === 'provider'), 'metadata exposes the Crew provider');
  assert.equal((await browser({ op: 'search', query: privateSearch, after: null }, headers)).status, 200);
  f.host.process.kill('SIGTERM');
  await exitWithin(f.host);
  assertBoundedRequestSpans(collector.received, {
    serviceName: 'agentui-crew-launcher-test',
    collectorHeaders: { 'x-collector-token': 'private collector=token', 'x-general-token': 'general token' },
    expected: ['metadata', 'search'].map(operation => ({ 'agentui.operation': operation,
      'agentui.credential_class': 'browser-development', 'agentui.outcome': 'ok', 'http.response.status_code': 200 })),
    canaries: [...f.secrets, metadata.body.value.hostId, metadata.body.value.principalId, privateSearch, privateHeader, resourceCanary,
      traceId, parentId, 'private collector=token', 'general token'],
  });
  for (const call of f.calls) {
    assert.equal(call.headers.authorization, `Bearer ${token}`);
    for (const header of ['x-collector-token', 'x-general-token', 'traceparent', 'baggage']) assert.equal(call.headers[header], undefined);
  }
});

test('Crew launcher keeps tracing disabled by default', { timeout: 20_000 }, async t => {
  const collector = await receiver(t);
  const f = await fixture(t, collector, {});
  const ready = await f.started;
  assert.equal(ready.kind, 'ready', f.host.stderr);
  assert.ok(f.calls.some(call => call.path === '/v1/capabilities'), 'launcher activates Crew discovery');
  assert.ok(f.calls.some(call => call.path === '/v1/members'), 'launcher discovers the configured Crew member');
  assert.equal((await browserRequest(ready.origin, { op: 'metadata' })).status, 200);
  f.host.process.kill('SIGTERM');
  await exitWithin(f.host);
  assert.deepEqual(collector.received, []);
});

test('Crew launcher rejects invalid headers before Crew discovery with a sanitized diagnostic', { timeout: 15_000 }, async t => {
  const collector = await receiver(t);
  const f = await fixture(t, collector, { OTEL_TRACES_EXPORTER: 'otlp',
    OTEL_EXPORTER_OTLP_HEADERS: 'x-token=private-invalid-header-a7dd%0d%0a' });
  const result = await f.started;
  assert.equal(result.kind, 'exit', 'invalid telemetry must fail before launcher readiness');
  assert.notEqual(result.code, 0);
  assert.equal(result.signal, null);
  assert.match(f.host.stderr, /valid URL-encoded OTLP headers/);
  assert.doesNotMatch(f.host.stderr, /private-invalid-/);
  assert.doesNotMatch(f.host.stdout, /is ready/);
  assert.deepEqual(f.calls, [], 'invalid configuration must not allocate Crew connections');
  assert.deepEqual(collector.received, []);
});
