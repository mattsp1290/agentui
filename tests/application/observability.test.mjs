import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import test from 'node:test';

const root = new URL('../../', import.meta.url);
const baseEnvironment = Object.fromEntries(Object.entries(process.env)
  .filter(([key]) => !key.startsWith('OTEL_') && key !== 'AGENTUI_DATADOG_LLMOBS'));

async function exitWithin(child, milliseconds = 5000) {
  let forced = false;
  const deadline = setTimeout(() => { forced = true; child.process.kill('SIGKILL'); }, milliseconds);
  try {
    const result = await child.exited;
    assert.equal(forced, false, `Host required SIGKILL. ${child.stderr}`);
    assert.deepEqual(result, { code: 0, signal: null }, child.stderr);
  } finally { clearTimeout(deadline); }
}

async function receiver(t, mode = 'ok') {
  const received = [];
  let first;
  const firstRequest = new Promise(resolve => { first = resolve; });
  const server = createServer((incoming, outgoing) => {
    let body = '';
    incoming.setEncoding('utf8').on('data', chunk => { body += chunk; });
    incoming.once('end', () => {
      const value = { path: incoming.url, headers: incoming.headers, body: JSON.parse(body) };
      received.push(value);
      first(value);
      if (mode === 'blackhole') return;
      outgoing.writeHead(mode === 'failure' ? 500 : 200, { 'content-type': 'application/json' });
      outgoing.end(mode === 'failure' ? '{}' : '{"partialSuccess":{}}');
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  return { endpoint, received, firstRequest };
}

async function fixture(t, environment = {}, direct = false) {
  const directory = mkdtempSync(join(tmpdir(), 'agentui-observability-'));
  const children = [];
  const launch = (args, env = environment) => {
    const process = spawn(globalThis.process.execPath, args, {
      cwd: root, env: { ...baseEnvironment, ...env }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    process.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    const exited = new Promise(resolve => process.once('exit', (code, signal) => resolve({ code, signal })));
    const child = { process, exited, get stderr() { return stderr; } };
    children.push(child);
    return child;
  };
  t.after(async () => {
    await Promise.all(children.map(async child => {
      if (child.process.exitCode !== null || child.process.signalCode !== null) return;
      child.process.kill('SIGTERM');
      const deadline = setTimeout(() => child.process.kill('SIGKILL'), 2000);
      try { await child.exited; } finally { clearTimeout(deadline); }
    }));
    rmSync(directory, { recursive: true, force: true });
  });
  const cli = (args, env) => launch(['apps/host/dist/main.js', ...args, '--data-dir', directory], env);
  const host = direct ? launch(['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { registerHooks } from 'node:module';
    import { fileURLToPath } from 'node:url';
    const artifact = new URL('./apps/host/build/tsc/artifact.js', import.meta.url).href;
    const installed = fileURLToPath(new URL('./apps/host/dist/', import.meta.url));
    registerHooks({ resolve(specifier, context, next) {
      if (specifier === './artifact.js' && context.parentURL?.endsWith('/server.js')) {
        const source = 'export * from ' + JSON.stringify(artifact) + '; import { readInstalledArtifact as read } from ' +
          JSON.stringify(artifact) + '; export function readInstalledArtifact() { return read(' + JSON.stringify(installed) + '); }';
        return { url: 'data:text/javascript,' + encodeURIComponent(source), shortCircuit: true };
      }
      return next(specifier, context);
    } });
    const { startBrowserHost } = await import('./apps/host/build/tsc/server.js');
    const options = { directory: process.argv[1], port: 0,
      assetsDirectory: fileURLToPath(new URL('./apps/desktop/web-dist-browser/', import.meta.url)) };
    if (process.argv[2] === 'lifecycle') {
      const { readObservabilityConfiguration } = await import('./apps/host/build/tsc/observability.js');
      options.observability = readObservabilityConfiguration(process.env);
      await assert.rejects(startBrowserHost({ ...options, assetsDirectory: process.argv[1] + '/missing-assets' }));
    }
    const host = await startBrowserHost(options);
    process.stdout.write(JSON.stringify({ origin: host.origin, hostId: host.hostId }) + '\\n');
    process.once('SIGTERM', () => {
      const closing = host.close();
      assert.equal(host.close(), closing, 'close must retain its original promise');
      void closing.catch(() => { process.exitCode = 1; });
    });
  `, directory, direct === 'lifecycle' ? 'lifecycle' : 'disabled']) : cli(['browser-dev', '--port', '0']);
  const lines = createInterface({ input: host.process.stdout });
  const ready = new Promise((resolve, reject) => {
    host.process.once('error', reject);
    lines.once('line', line => {
      try { resolve(JSON.parse(line)); } catch (error) { reject(error); }
    });
    void host.exited.then(result => reject(new Error(`Host exited before readiness ${JSON.stringify(result)} ${host.stderr}`)));
  });
  const deadline = setTimeout(() => host.process.kill('SIGKILL'), 8000);
  let address;
  try { address = await ready; } finally { clearTimeout(deadline); lines.close(); }
  const control = async (op, env) => {
    const child = cli([op], env);
    let stdout = '';
    child.process.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
    await exitWithin(child);
    const response = JSON.parse(stdout);
    assert.equal(response.ok, true);
    return response.value;
  };
  const call = (path, body, headers = {}, method = 'POST') => new Promise((resolve, reject) => {
    const outgoing = request(`${address.origin}${path}`, { method, headers: { 'Content-Type': 'application/json', ...headers } }, incoming => {
      let text = '';
      incoming.setEncoding('utf8').on('data', chunk => { text += chunk; });
      incoming.once('error', reject);
      incoming.once('end', () => {
        let body;
        try { body = JSON.parse(text); } catch { body = text; }
        resolve({ status: incoming.statusCode, headers: incoming.headers, body });
      });
    });
    outgoing.once('error', reject);
    outgoing.setTimeout(5000, () => outgoing.destroy(new Error('Host request deadline exceeded')));
    outgoing.end(body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body));
  });
  const browser = (body, cookie = '', headers = {}) => call('/api/v1', body, {
    Origin: address.origin, ...(cookie ? { Cookie: cookie } : {}), ...headers,
  });
  const pair = async () => {
    const invitation = await control('invite');
    const response = await browser({ op: 'pair', code: invitation.code });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const cookie = response.headers['set-cookie'][0].split(';')[0];
    return { code: invitation.code, cookie };
  };
  return { ...address, host, control, call, browser, pair,
    stop: async () => { host.process.kill('SIGTERM'); await exitWithin(host); } };
}

function attributes(values = []) {
  return Object.fromEntries(values.map(({ key, value }) => [key, value.stringValue ?? Number(value.intValue)]));
}

test('host OTLP export contains only bounded request facts and ignores incoming trace context and resource metadata', { timeout: 25_000 }, async t => {
  const collector = await receiver(t);
  const canaries = ['private-search-486c8d', 'private-header-0cad47', 'private-resource-f22b1c',
    'private-url-c7d9b1', 'private-body-2f7934', 'private-service-name-decoy-a121a3',
    '11111111111111111111111111111111', '2222222222222222'];
  const f = await fixture(t, {
    OTEL_TRACES_EXPORTER: 'otlp', OTEL_EXPORTER_OTLP_ENDPOINT: collector.endpoint,
    OTEL_EXPORTER_OTLP_HEADERS: 'x-collector-token=general,x-general-token=general%20token',
    OTEL_EXPORTER_OTLP_TRACES_HEADERS: 'x-collector-token=collector%20token%3Dvalue',
    OTEL_SERVICE_NAME: 'agentui-observability-test',
    OTEL_RESOURCE_ATTRIBUTES: `private.resource=${canaries[2]},service.name=${canaries[5]}`,
  });
  canaries.push(f.hostId);
  const headers = { 'X-Private': canaries[1], baggage: `private=${canaries[1]}`,
    traceparent: `00-${canaries[6]}-${canaries[7]}-01` };
  const expected = [];
  const check = (response, operation, credential, outcome, status) => {
    assert.equal(response.status, status, JSON.stringify(response.body));
    expected.push({ 'agentui.operation': operation, 'agentui.credential_class': credential,
      'agentui.outcome': outcome, 'http.response.status_code': status });
    return response;
  };
  check(await f.browser({ op: 'metadata' }, '', headers), 'admission', 'browser-development', 'unauthorized', 401);
  const browser = await f.pair();
  canaries.push(browser.code, browser.cookie, browser.cookie.slice(browser.cookie.indexOf('=') + 1));
  expected.push({ 'agentui.operation': 'pair', 'agentui.credential_class': 'browser-development',
    'agentui.outcome': 'ok', 'http.response.status_code': 200 });
  const metadata = check(await f.browser({ op: 'metadata' }, browser.cookie, headers), 'metadata', 'browser-development', 'ok', 200);
  canaries.push(metadata.body.value.principalId);
  check(await f.browser({ op: 'search', query: canaries[0], after: null }, browser.cookie, headers), 'search', 'browser-development', 'ok', 200);
  check(await f.browser({ op: canaries[4] }, browser.cookie, headers), 'admission', 'browser-development', 'invalid', 400);
  check(await f.browser('{', browser.cookie, headers), 'admission', 'browser-development', 'invalid', 400);
  check(await f.browser(`{"private":"${canaries[4]}${'x'.repeat(410_000)}"}`, browser.cookie, headers), 'admission', 'browser-development', 'invalid', 400);
  const invitation = await f.control('invite-native', { OTEL_TRACES_EXPORTER: 'invalid-control-command-ignored' });
  canaries.push(invitation.code);
  const native = check(await f.call('/native/v1/pair', { version: 1, hostId: f.hostId, code: invitation.code }, headers), 'pair', 'native', 'ok', 200);
  const credential = native.body.value;
  canaries.push(credential.principalId, credential.secret);
  const authorization = { ...headers, Authorization: `Bearer ${credential.secret}` };
  check(await f.call('/native/v1', { op: 'metadata' }, authorization), 'metadata', 'native', 'ok', 200);
  check(await f.call('/native/v1', { op: 'metadata' }, headers), 'admission', 'native', 'unauthorized', 401);
  check(await f.call(`/native/v1?private=${canaries[3]}`, { op: 'metadata' }, authorization), 'admission', 'native', 'invalid', 400);
  await f.call(`/?private=${canaries[3]}`, undefined, {}, 'GET');
  await f.stop();
  assert.ok(collector.received.length > 0, 'SIGTERM flushes request spans to the receiver');
  const spans = [];
  for (const request of collector.received) {
    assert.equal(request.path, '/v1/traces');
    assert.match(request.headers['content-type'], /^application\/json/);
    assert.equal(request.headers['x-collector-token'], 'collector token=value');
    assert.equal(request.headers['x-general-token'], 'general token');
    for (const resource of request.body.resourceSpans) {
      assert.deepEqual(attributes(resource.resource.attributes), { 'service.name': 'agentui-observability-test' });
      for (const scope of resource.scopeSpans) spans.push(...scope.spans);
    }
  }
  assert.equal(spans.length, expected.length, 'static assets and control commands do not create request spans');
  for (const span of spans) {
    assert.equal(span.name, 'agentui.host.request');
    assert.equal(span.kind, 2);
    assert.ok(BigInt(span.endTimeUnixNano) > BigInt(span.startTimeUnixNano),
      `span duration includes request handling ${span.startTimeUnixNano} -> ${span.endTimeUnixNano}`);
    assert.ok(span.parentSpanId === undefined || span.parentSpanId === '', 'request spans are roots');
    assert.deepEqual(span.events ?? [], []);
    assert.deepEqual(span.links ?? [], []);
    const values = attributes(span.attributes);
    assert.deepEqual(Object.keys(values).sort(), ['agentui.credential_class', 'agentui.operation', 'agentui.outcome', 'http.response.status_code']);
    assert.equal(span.status?.code ?? 0, values['agentui.outcome'] === 'ok' ? 0 : 2);
    assert.ok(!span.status?.message);
  }
  const byValue = values => values.map(value => JSON.stringify(value, Object.keys(value).sort())).sort();
  assert.deepEqual(byValue(spans.map(span => attributes(span.attributes))), byValue(expected));
  const payload = JSON.stringify(collector.received.map(value => value.body));
  for (const canary of canaries) assert.equal(payload.includes(canary), false, `Private value leaked ${canary}`);
});

test('signal-specific OTLP endpoint is used verbatim with the default service identity', { timeout: 15_000 }, async t => {
  const collector = await receiver(t);
  const f = await fixture(t, {
    OTEL_TRACES_EXPORTER: 'otlp', OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:1/ignored',
    OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: `${collector.endpoint}/custom/trace-intake`,
  });
  assert.equal((await f.browser({ op: 'metadata' })).status, 401);
  await f.stop();
  assert.equal(collector.received.length, 1);
  assert.equal(collector.received[0].path, '/custom/trace-intake');
  assert.deepEqual(attributes(collector.received[0].body.resourceSpans[0].resource.attributes), { 'service.name': 'agentui-host' });
});

test('enabled tracing releases failed startup and memoizes successful host shutdown', { timeout: 15_000 }, async t => {
  const collector = await receiver(t);
  const f = await fixture(t, { OTEL_TRACES_EXPORTER: 'otlp', OTEL_EXPORTER_OTLP_ENDPOINT: collector.endpoint }, 'lifecycle');
  assert.equal((await f.browser({ op: 'metadata' })).status, 401);
  await f.stop();
  assert.equal(collector.received.length, 1);
  const spans = collector.received.flatMap(value => value.body.resourceSpans.flatMap(resource => resource.scopeSpans.flatMap(scope => scope.spans)));
  assert.equal(spans.length, 1, 'repeated shutdown neither drops nor duplicates export');
});

test('response serialization failure exports a sanitized unavailable outcome after admission', { timeout: 15_000 }, async t => {
  const collector = await receiver(t);
  const [{ Access }, { openAccessDatabase }, { serviceEndpoint }, { createHostObservability }, { SERVICE_MAX_RESPONSE_BYTES }] = await Promise.all([
    import('../../apps/host/build/tsc/access.js'), import('../../apps/host/build/tsc/access-database.js'),
    import('../../apps/host/build/tsc/service-endpoint.js'), import('../../apps/host/build/tsc/observability.js'),
    import('@agentui/contracts/service'),
  ]);
  const directory = mkdtempSync(join(tmpdir(), 'agentui-observability-framing-'));
  const access = new Access(openAccessDatabase(join(directory, 'host.sqlite')));
  const paired = access.pair(access.invite('native'), 'native');
  const privateDiagnostic = 'private-serialization-diagnostic-e88e24';
  const observability = createHostObservability({ kind: 'otlp', endpoint: `${collector.endpoint}/v1/traces`, headers: {}, serviceName: 'agentui-host' });
  const handler = serviceEndpoint({ credentialClass: 'native', access, observability, isClosing: () => false,
    api: async () => ({ diagnostic: privateDiagnostic.padEnd(SERVICE_MAX_RESPONSE_BYTES, 'x') }) });
  const server = createServer((incoming, outgoing) => { void handler(incoming, outgoing).catch(() => outgoing.destroy()); });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await observability.close();
    access.close();
    rmSync(directory, { recursive: true, force: true });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/native/v1`, {
    method: 'POST', signal: AbortSignal.timeout(5000), headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${paired.secret}` },
    body: JSON.stringify({ op: 'metadata' }),
  });
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { ok: false, error: { kind: 'unavailable', message: 'Host request did not complete' } });
  const closing = observability.close();
  assert.equal(observability.close(), closing);
  await closing;
  const spans = collector.received.flatMap(value => value.body.resourceSpans.flatMap(resource => resource.scopeSpans.flatMap(scope => scope.spans)));
  assert.equal(spans.length, 1);
  assert.deepEqual(attributes(spans[0].attributes), { 'agentui.operation': 'metadata', 'agentui.credential_class': 'native',
    'agentui.outcome': 'unavailable', 'http.response.status_code': 503 });
  assert.equal(spans[0].status.code, 2);
  for (const privateValue of [privateDiagnostic, paired.secret, paired.principal.id, access.hostId]) {
    assert.equal(JSON.stringify(collector.received).includes(privateValue), false);
  }
});

test('tracing stays disabled by default, by explicit opt out and for direct host callers', { timeout: 30_000 }, async t => {
  const collector = await receiver(t);
  for (const [name, environment, direct] of [
    ['default', {}, false],
    ['none', { OTEL_TRACES_EXPORTER: 'none' }, false],
    ['SDK disabled', { OTEL_TRACES_EXPORTER: 'otlp', OTEL_SDK_DISABLED: 'true' }, false],
    ['direct caller', { OTEL_TRACES_EXPORTER: 'otlp' }, true],
  ]) {
    await t.test(name, async t => {
      const f = await fixture(t, { ...environment, OTEL_EXPORTER_OTLP_ENDPOINT: collector.endpoint }, direct);
      const paired = await f.pair();
      assert.equal((await f.browser({ op: 'metadata' }, paired.cookie)).status, 200);
      await f.stop();
      assert.deepEqual(collector.received, []);
    });
  }
});

for (const mode of ['failure', 'blackhole']) {
  test(`a ${mode} OTLP receiver cannot fail requests or retain the host process`, { timeout: 20_000 }, async t => {
    const collector = await receiver(t, mode);
    const f = await fixture(t, { OTEL_TRACES_EXPORTER: 'otlp', OTEL_EXPORTER_OTLP_ENDPOINT: collector.endpoint });
    const paired = await f.pair();
    assert.equal((await f.browser({ op: 'metadata' }, paired.cookie)).status, 200);
    const deadline = setTimeout(() => f.host.process.kill('SIGKILL'), 6000);
    try {
      await Promise.race([collector.firstRequest, f.host.exited.then(() => {
        throw new Error(`Host exited before attempting export. ${f.host.stderr}`);
      })]);
    } finally { clearTimeout(deadline); }
    assert.equal((await f.browser({ op: 'metadata' }, paired.cookie)).status, 200);
    await f.stop();
    assert.ok(collector.received.length > 0, 'the failing receiver was reached before shutdown');
  });
}

test('observability configuration selects explicit HTTP JSON traces and validates collector boundaries', async () => {
  const { readObservabilityConfiguration: read } = await import('../../apps/host/build/tsc/observability.js');
  for (const environment of [{}, { OTEL_TRACES_EXPORTER: 'none', OTEL_EXPORTER_OTLP_ENDPOINT: 'invalid' },
    { OTEL_TRACES_EXPORTER: 'invalid', OTEL_SDK_DISABLED: 'true', OTEL_EXPORTER_OTLP_HEADERS: 'invalid' }]) {
    assert.deepEqual(read(environment), { kind: 'disabled' });
  }
  const defaults = { kind: 'otlp', endpoint: 'http://127.0.0.1:4318/v1/traces', headers: {}, serviceName: 'agentui-host' };
  assert.deepEqual(read({ OTEL_TRACES_EXPORTER: 'otlp' }), defaults);
  assert.deepEqual(read({ OTEL_TRACES_EXPORTER: 'otlp', OTEL_EXPORTER_OTLP_ENDPOINT: 'https://collector.example/otlp/' }),
    { ...defaults, endpoint: 'https://collector.example/otlp/v1/traces' });
  assert.deepEqual(read({ OTEL_TRACES_EXPORTER: 'otlp', OTEL_EXPORTER_OTLP_ENDPOINT: 'https://ignored.example',
    OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'https://collector.example/custom', OTEL_SERVICE_NAME: 'my-host',
    OTEL_EXPORTER_OTLP_PROTOCOL: 'grpc', OTEL_EXPORTER_OTLP_TRACES_PROTOCOL: 'http/json',
    OTEL_EXPORTER_OTLP_HEADERS: 'x-general=value,x-token=general', OTEL_EXPORTER_OTLP_TRACES_HEADERS: 'x-token=a%3Db,x-team=two%20words' }),
  { kind: 'otlp', endpoint: 'https://collector.example/custom', serviceName: 'my-host',
    headers: { 'x-general': 'value', 'x-token': 'a=b', 'x-team': 'two words' } });
  for (const endpoint of ['file:///tmp/traces', 'http://user:secret@collector.example', 'http://collector.example?secret=x',
    'http://collector.example/#fragment', 'not a URL']) {
    assert.throws(() => read({ OTEL_TRACES_EXPORTER: 'otlp', OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: endpoint }));
  }
  for (const configuration of [
    { OTEL_TRACES_EXPORTER: 'console' }, { OTEL_TRACES_EXPORTER: 'otlp,console' },
    { OTEL_TRACES_EXPORTER: 'otlp', OTEL_EXPORTER_OTLP_PROTOCOL: 'grpc' },
    { OTEL_TRACES_EXPORTER: 'otlp', OTEL_EXPORTER_OTLP_TRACES_PROTOCOL: 'http/protobuf' },
    { OTEL_TRACES_EXPORTER: 'otlp', OTEL_EXPORTER_OTLP_HEADERS: 'missing-equals' },
    { OTEL_TRACES_EXPORTER: 'otlp', OTEL_EXPORTER_OTLP_HEADERS: 'x-token=%0d%0ainjected' },
    { OTEL_TRACES_EXPORTER: 'otlp', OTEL_EXPORTER_OTLP_HEADERS: 'x-token=%0d%0ainjected', OTEL_EXPORTER_OTLP_TRACES_HEADERS: 'x-token=valid' },
  ]) assert.throws(() => read(configuration));
  const canary = 'private-configuration-canary-e392c4';
  for (const configuration of [
    { OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: `http://${canary}:secret@collector.example` },
    { OTEL_EXPORTER_OTLP_HEADERS: `x-token=${canary}%0d%0a` },
    { OTEL_SERVICE_NAME: `${canary}\n` + 'invalid' },
  ]) assert.throws(() => read({ OTEL_TRACES_EXPORTER: 'otlp', ...configuration }), error => !error.message.includes(canary));
});
