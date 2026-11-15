import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import test from 'node:test';
import { directCodexEnvironment } from '../../../apps/host/build/tsc/native-environment.js';

const root = new URL('../../../', import.meta.url);
const environment = directCodexEnvironment();
const token = 'private-launcher-crew-token-718dad';

async function within(promise, description, milliseconds = 8000) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${description} deadline exceeded`)), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}

async function listen(t, handler) {
  const server = createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  return `http://127.0.0.1:${server.address().port}`;
}

async function fixture(t, settings = {}) {
  const received = [], calls = [];
  const memberId = randomUUID();
  const endpoint = await listen(t, async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    received.push({ path: request.url, headers: request.headers, body: JSON.parse(body) });
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end('{"partialSuccess":{}}');
  });
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
  const children = [];
  const launch = args => {
    const child = spawn(process.execPath, args, {
      cwd: root, env: { ...environment, OTEL_EXPORTER_OTLP_ENDPOINT: endpoint, ...settings }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    const exited = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => resolve({ code, signal }));
    });
    const result = { child, exited, get stdout() { return stdout; }, get stderr() { return stderr; } };
    children.push(result);
    return result;
  };
  t.after(async () => {
    for (const { child, exited } of children) {
      if (child.exitCode !== null || child.signalCode !== null) continue;
      child.kill('SIGTERM');
      const timer = setTimeout(() => child.kill('SIGKILL'), 2000);
      try { await exited; } finally { clearTimeout(timer); }
    }
    await rm(directory, { recursive: true, force: true });
  });
  const host = launch(['examples/crew/run.mjs', configFile]);
  const lines = createInterface({ input: host.child.stdout });
  const readiness = new Promise(resolve => {
    lines.on('line', line => {
      const match = /^AgentUI with Crew is ready at (http:\/\/[^/]+)\/browser\.html$/.exec(line);
      if (match) resolve({ kind: 'ready', origin: match[1] });
    });
  });
  const startup = within(Promise.race([readiness, host.exited.then(result => ({ kind: 'exit', ...result }))]), 'Crew launcher startup')
    .finally(() => lines.close());
  const stop = async () => {
    host.child.kill('SIGTERM');
    assert.deepEqual(await within(host.exited, 'Crew launcher shutdown'), { code: 0, signal: null }, host.stderr);
  };
  const start = async () => {
    const result = await startup;
    assert.equal(result.kind, 'ready', host.stderr);
    assert.ok(calls.some(call => call.path === '/v1/capabilities'), 'launcher activates Crew discovery');
    assert.ok(calls.some(call => call.path === '/v1/members'), 'launcher discovers the configured Crew member');
    const browser = async (body, cookie = '', headers = {}) => {
      const response = await fetch(`${result.origin}/api/v1`, { method: 'POST', signal: AbortSignal.timeout(5000),
        headers: { 'content-type': 'application/json', Origin: result.origin, ...(cookie ? { Cookie: cookie } : {}), ...headers },
        body: JSON.stringify(body) });
      return { status: response.status, headers: response.headers, body: await response.json() };
    };
    const invitation = launch(['apps/host/dist/main.js', 'invite', '--data-dir', hostDirectory]);
    assert.deepEqual(await within(invitation.exited, 'Crew invitation'), { code: 0, signal: null }, invitation.stderr);
    const invited = JSON.parse(invitation.stdout);
    assert.equal(invited.ok, true);
    const paired = await browser({ op: 'pair', code: invited.value.code });
    assert.equal(paired.status, 200, JSON.stringify(paired.body));
    const cookie = paired.headers.get('set-cookie').split(';')[0];
    return { browser: (body, headers) => browser(body, cookie, headers),
      secrets: [invited.value.code, cookie, cookie.slice(cookie.indexOf('=') + 1)] };
  };
  return { received, calls, host, startup, start, stop,
    secrets: [token, directory, hostDirectory, tokenFile, installationId, generation, memberId, 'private-remote-profile-7f83'] };
}

function attributes(values = []) {
  return Object.fromEntries(values.map(({ key, value }) => [key, value.stringValue ?? Number(value.intValue)]));
}

test('Crew launcher exports bounded request spans and keeps collector credentials and private values out of Crew traffic and spans', { timeout: 25_000 }, async t => {
  const privateSearch = 'private-crew-search-495c', privateHeader = 'private-crew-header-0eac';
  const resourceCanary = 'private-crew-resource-51e7';
  const traceId = '11111111111111111111111111111111', parentId = '2222222222222222';
  const f = await fixture(t, { OTEL_TRACES_EXPORTER: 'otlp', OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json',
    OTEL_SERVICE_NAME: 'agentui-crew-launcher-test', OTEL_RESOURCE_ATTRIBUTES: `private.resource=${resourceCanary}`,
    OTEL_EXPORTER_OTLP_HEADERS: 'x-collector-token=general,x-general-token=general%20token',
    OTEL_EXPORTER_OTLP_TRACES_HEADERS: 'x-collector-token=private%20collector%3Dtoken' });
  const browser = await f.start();
  const headers = { 'x-private': privateHeader, baggage: `private=${privateHeader}`, traceparent: `00-${traceId}-${parentId}-01` };
  const metadata = await browser.browser({ op: 'metadata' }, headers);
  assert.equal(metadata.status, 200, JSON.stringify(metadata.body));
  assert.ok(metadata.body.value.agents.some(agent => agent.kind === 'provider'), 'metadata exposes the Crew provider');
  assert.equal((await browser.browser({ op: 'search', query: privateSearch, after: null }, headers)).status, 200);
  await f.stop();
  assert.ok(f.received.length > 0, 'graceful launcher shutdown flushes OTLP spans');
  const spans = [];
  for (const request of f.received) {
    assert.equal(request.path, '/v1/traces');
    assert.match(request.headers['content-type'], /^application\/json/);
    assert.equal(request.headers['x-collector-token'], 'private collector=token');
    assert.equal(request.headers['x-general-token'], 'general token');
    for (const resource of request.body.resourceSpans) {
      assert.deepEqual(attributes(resource.resource.attributes), { 'service.name': 'agentui-crew-launcher-test' });
      for (const scope of resource.scopeSpans) spans.push(...scope.spans);
    }
  }
  assert.equal(spans.length, 3, 'pair, metadata and search each export once without remote invocation spans');
  assert.deepEqual(spans.map(span => attributes(span.attributes)['agentui.operation']).sort(), ['metadata', 'pair', 'search']);
  for (const span of spans) {
    assert.equal(span.name, 'agentui.host.request');
    assert.equal(span.kind, 2);
    const operation = attributes(span.attributes)['agentui.operation'];
    assert.deepEqual(attributes(span.attributes), { 'agentui.operation': operation,
      'agentui.credential_class': 'browser-development', 'agentui.outcome': 'ok', 'http.response.status_code': 200 });
    assert.ok(!span.parentSpanId, 'incoming trace context does not parent request spans');
    assert.deepEqual(span.events ?? [], []);
    assert.deepEqual(span.links ?? [], []);
  }
  const payload = JSON.stringify(f.received.map(request => request.body));
  for (const secret of [...f.secrets, ...browser.secrets, metadata.body.value.hostId, metadata.body.value.principalId,
    privateSearch, privateHeader, resourceCanary, traceId, parentId, 'private collector=token', 'general token']) {
    assert.equal(payload.includes(secret), false, `Private value leaked into OTLP spans: ${secret}`);
  }
  for (const call of f.calls) {
    assert.equal(call.headers.authorization, `Bearer ${token}`);
    for (const header of ['x-collector-token', 'x-general-token', 'traceparent', 'baggage']) assert.equal(call.headers[header], undefined);
  }
});

for (const [name, settings] of [
  ['no exporter', {}], ['none', { OTEL_TRACES_EXPORTER: 'none' }],
  ['SDK disabled', { OTEL_TRACES_EXPORTER: 'otlp', OTEL_SDK_DISABLED: 'true' }],
]) test(`Crew launcher keeps tracing disabled with ${name}`, { timeout: 20_000 }, async t => {
  const f = await fixture(t, settings), browser = await f.start();
  assert.equal((await browser.browser({ op: 'metadata' })).status, 200);
  await f.stop();
  assert.deepEqual(f.received, []);
});

for (const [name, settings, diagnostic] of [
  ['exporter', { OTEL_TRACES_EXPORTER: 'private-invalid-exporter-a7dd' }, /Set OTEL_TRACES_EXPORTER to otlp or none/],
  ['endpoint', { OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'http://private-invalid-endpoint-a7dd:secret@127.0.0.1:1' }, /valid HTTP or HTTPS OTLP endpoint/],
  ['protocol', { OTEL_EXPORTER_OTLP_TRACES_PROTOCOL: 'private-invalid-protocol-a7dd' }, /requires OTLP protocol http\/json/],
  ['headers', { OTEL_EXPORTER_OTLP_HEADERS: 'x-token=private-invalid-header-a7dd%0d%0a' }, /valid URL-encoded OTLP headers/],
  ['Datadog', { AGENTUI_DATADOG_LLMOBS: 'private-invalid-datadog-a7dd' }, /Set AGENTUI_DATADOG_LLMOBS to true or false/],
]) test(`Crew launcher rejects invalid ${name} before Crew discovery with a sanitized diagnostic`, { timeout: 15_000 }, async t => {
  const f = await fixture(t, { OTEL_TRACES_EXPORTER: 'otlp', ...settings });
  const result = await f.startup;
  assert.equal(result.kind, 'exit', 'invalid telemetry must fail before launcher readiness');
  assert.notEqual(result.code, 0);
  assert.equal(result.signal, null);
  assert.match(f.host.stderr, diagnostic);
  assert.doesNotMatch(f.host.stderr, /private-invalid-/);
  assert.doesNotMatch(f.host.stdout, /is ready/);
  assert.deepEqual(f.calls, [], 'invalid configuration must not allocate Crew connections');
  assert.deepEqual(f.received, []);
});
