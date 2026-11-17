import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { assertBoundedRequestSpans, attributes, receiver } from './support/observability.mjs';
import { browserRequest, control, exitWithin, hostRequest, launchProcess, startup, within } from './support/host-process.mjs';

async function fixture(t, environment = {}, direct = false) {
  const directory = mkdtempSync(join(tmpdir(), 'agentui-observability-'));
  const launch = (args, env = environment) => launchProcess(t, args, env);
  const cliArgs = args => ['apps/host/dist/main.js', ...args, '--data-dir', directory];
  const cli = (args, env) => launch(cliArgs(args), env);
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
      await assert.rejects(startBrowserHost({ agentStartup: { kind: 'recorded' }, ...options, assetsDirectory: process.argv[1] + '/missing-assets' }));
    }
    const host = await startBrowserHost({ ...options, agentStartup: { kind: 'recorded' } });
    process.stdout.write(JSON.stringify({ origin: host.origin, hostId: host.hostId }) + '\\n');
    process.once('SIGTERM', () => {
      const closing = host.close();
      assert.equal(host.close(), closing, 'close must retain its original promise');
      void closing.catch(() => { process.exitCode = 1; });
    });
  `, directory, direct === 'lifecycle' ? 'lifecycle' : 'disabled']) : cli(['browser-dev', '--port', '0']);
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const address = await startup(host);
  assert.equal(address.kind, 'ready', host.stderr);
  const call = (path, body, headers, method) => hostRequest(address.origin, path, body, headers, method);
  const browser = (body, cookie, headers) => browserRequest(address.origin, body, cookie, headers);
  return { ...address, host, call, browser,
    control: (op, env = environment) => control(t, cliArgs([op]), env),
    stop: async () => { host.process.kill('SIGTERM'); await exitWithin(host); } };
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
  const metadata = check(await f.browser({ op: 'metadata' }, '', headers), 'metadata', 'browser-development', 'ok', 200);
  canaries.push(metadata.body.value.principalId);
  check(await f.browser({ op: 'search', query: canaries[0], after: null }, '', headers), 'search', 'browser-development', 'ok', 200);
  check(await f.browser({ op: canaries[4] }, '', headers), 'admission', 'browser-development', 'invalid', 400);
  check(await f.browser('{', '', headers), 'admission', 'browser-development', 'invalid', 400);
  check(await f.browser(`{"private":"${canaries[4]}${'x'.repeat(410_000)}"}`, '', headers), 'admission', 'browser-development', 'invalid', 400);
  check(await f.call('/native/v1', { op: 'metadata' }, headers), 'metadata', 'native', 'ok', 200);
  check(await f.call('/native/v1', { op: 'metadata' }, { ...headers, Origin: f.origin }), 'admission', 'native', 'invalid', 400);
  check(await f.call(`/native/v1?private=${canaries[3]}`, { op: 'metadata' }, headers), 'admission', 'native', 'invalid', 400);
  await f.call(`/?private=${canaries[3]}`, undefined, {}, 'GET');
  assert.equal((await f.call('/favicon.ico', undefined, { Host: 'wrong-host.invalid' }, 'GET')).status, 400);
  await f.stop();
  assertBoundedRequestSpans(collector.received, {
    serviceName: 'agentui-observability-test',
    collectorHeaders: { 'x-collector-token': 'collector token=value', 'x-general-token': 'general token' },
    expected, canaries,
  });
});

test('signal-specific OTLP endpoint is used verbatim with the default service identity', { timeout: 15_000 }, async t => {
  const collector = await receiver(t);
  const f = await fixture(t, {
    OTEL_TRACES_EXPORTER: 'otlp', OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:1/ignored',
    OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: `${collector.endpoint}/custom/trace-intake`,
  });
  assert.equal((await f.browser({ op: 'metadata' })).status, 200);
  await f.stop();
  assert.equal(collector.received.length, 1);
  assert.equal(collector.received[0].path, '/custom/trace-intake');
  assert.deepEqual(attributes(collector.received[0].body.resourceSpans[0].resource.attributes), { 'service.name': 'agentui-host' });
});

test('enabled tracing releases failed startup and memoizes successful host shutdown', { timeout: 15_000 }, async t => {
  const collector = await receiver(t);
  const f = await fixture(t, { OTEL_TRACES_EXPORTER: 'otlp', OTEL_EXPORTER_OTLP_ENDPOINT: collector.endpoint }, 'lifecycle');
  assert.equal((await f.browser({ op: 'metadata' })).status, 200);
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
  const privateDiagnostic = 'private-serialization-diagnostic-e88e24';
  const observability = createHostObservability({ kind: 'otlp', endpoint: `${collector.endpoint}/v1/traces`, headers: {}, serviceName: 'agentui-host', datadogLlmObservability: false });
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
    method: 'POST', signal: AbortSignal.timeout(5000), headers: { 'Content-Type': 'application/json' },
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
  for (const privateValue of [privateDiagnostic, 'trusted-owner', access.hostId]) {
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
      assert.equal((await f.browser({ op: 'metadata' })).status, 200);
      await f.stop();
      assert.deepEqual(collector.received, []);
    });
  }
});

for (const [mode, respond] of [
  ['failure', (_incoming, outgoing) => { outgoing.writeHead(500, { 'content-type': 'application/json' }); outgoing.end('{}'); }],
  ['blackhole', () => {}],
]) {
  test(`a ${mode} OTLP receiver cannot fail requests or retain the host process`, { timeout: 20_000 }, async t => {
    const collector = await receiver(t, respond);
    const f = await fixture(t, { OTEL_TRACES_EXPORTER: 'otlp', OTEL_EXPORTER_OTLP_ENDPOINT: collector.endpoint });
    assert.equal((await f.browser({ op: 'metadata' })).status, 200);
    await within(Promise.race([collector.firstRequest, f.host.exited.then(() => {
      throw new Error(`Host exited before attempting export. ${f.host.stderr}`);
    })]), 'First export', 6000, () => f.host.process.kill('SIGKILL'));
    assert.equal((await f.browser({ op: 'metadata' })).status, 200);
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
  const defaults = { kind: 'otlp', endpoint: 'http://127.0.0.1:4318/v1/traces', headers: {}, serviceName: 'agentui-host', datadogLlmObservability: false };
  assert.deepEqual(read({ OTEL_TRACES_EXPORTER: 'otlp' }), defaults);
  assert.deepEqual(read({ OTEL_TRACES_EXPORTER: 'otlp', OTEL_EXPORTER_OTLP_ENDPOINT: 'https://collector.example/otlp/' }),
    { ...defaults, endpoint: 'https://collector.example/otlp/v1/traces' });
  assert.deepEqual(read({ OTEL_TRACES_EXPORTER: 'otlp', OTEL_EXPORTER_OTLP_ENDPOINT: 'https://ignored.example',
    OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'https://collector.example/custom', OTEL_SERVICE_NAME: 'my-host',
    OTEL_EXPORTER_OTLP_PROTOCOL: 'grpc', OTEL_EXPORTER_OTLP_TRACES_PROTOCOL: 'http/json',
    OTEL_EXPORTER_OTLP_HEADERS: 'x-general=value,x-token=general', OTEL_EXPORTER_OTLP_TRACES_HEADERS: 'x-token=a%3Db,x-team=two%20words' }),
  { kind: 'otlp', endpoint: 'https://collector.example/custom', serviceName: 'my-host', datadogLlmObservability: false,
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
