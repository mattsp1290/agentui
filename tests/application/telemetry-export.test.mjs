import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import test from 'node:test';
import { createHostObservability } from '../../apps/host/build/tsc/observability.js';
import { createOtlpExporter } from '../../apps/host/build/tsc/otlp-exporter.js';

const hostRequire = createRequire(new URL('../../apps/host/package.json', import.meta.url));
const { InMemorySpanExporter, SimpleSpanProcessor, TracerProvider } = await import(hostRequire.resolve('@opentelemetry/sdk-trace'));
const { ExportResultCode } = await import(hostRequire.resolve('@opentelemetry/core'));
const { diag } = await import(hostRequire.resolve('@opentelemetry/api'));

async function receiver(t, respond = (_incoming, outgoing) => {
  outgoing.writeHead(200, { 'content-type': 'application/json' });
  outgoing.end('{"partialSuccess":{}}');
}) {
  const received = [];
  const server = createServer((incoming, outgoing) => {
    let body = '';
    incoming.setEncoding('utf8').on('data', chunk => { body += chunk; });
    incoming.once('end', () => {
      received.push({ headers: incoming.headers, body: JSON.parse(body) });
      respond(incoming, outgoing, received.length);
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  return { endpoint: `http://127.0.0.1:${server.address().port}/v1/traces`, received };
}

function observe(t, collector, headers = {}) {
  const observations = createHostObservability({ kind: 'otlp', endpoint: collector.endpoint,
    headers, serviceName: 'agentui-export-test' });
  t.after(() => observations.close());
  return observations;
}

function recordRequests(observations, count) {
  for (let index = 0; index < count; index++) observations.record({ operation: 'metadata',
    credentialClass: 'native', outcome: 'ok', startTime: performance.timeOrigin + performance.now() });
}

async function until(predicate, message) {
  const deadline = performance.now() + 2000;
  while (performance.now() < deadline) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail(message);
}

function spans(collector) {
  return collector.received.flatMap(request => request.body.resourceSpans
    .flatMap(resource => resource.scopeSpans.flatMap(scope => scope.spans)));
}

test('explicit export headers cannot inherit credentials from ambient OTLP configuration', async t => {
  const collector = await receiver(t);
  const keys = ['OTEL_EXPORTER_OTLP_HEADERS', 'OTEL_EXPORTER_OTLP_TRACES_HEADERS'];
  const original = keys.map(key => process.env[key]);
  t.after(() => {
    keys.forEach((key, index) => {
      if (original[index] === undefined) delete process.env[key];
      else process.env[key] = original[index];
    });
  });
  process.env.OTEL_EXPORTER_OTLP_HEADERS = 'x-other-collector-secret=private-general-credential';
  process.env.OTEL_EXPORTER_OTLP_TRACES_HEADERS = 'x-other-trace-secret=private-trace-credential';
  const empty = observe(t, collector);
  recordRequests(empty, 1);
  await empty.close();
  const explicit = observe(t, collector, { 'x-own-collector-token': 'own-credential' });
  recordRequests(explicit, 1);
  await explicit.close();
  assert.equal(collector.received.length, 2);
  for (const request of collector.received) {
    assert.equal(request.headers['x-other-collector-secret'], undefined);
    assert.equal(request.headers['x-other-trace-secret'], undefined);
  }
  assert.equal(collector.received[0].headers['x-own-collector-token'], undefined);
  assert.equal(collector.received[1].headers['x-own-collector-token'], 'own-credential');
});

test('a slow-drip receiver loses its socket and cannot block the next export batch', { timeout: 6000 }, async t => {
  const drips = new Set();
  let firstSocketClosed = false;
  const collector = await receiver(t, (incoming, outgoing, number) => {
    outgoing.writeHead(200, { 'content-type': 'application/json' });
    if (number !== 1) {
      outgoing.end('{"partialSuccess":{}}');
      return;
    }
    outgoing.write(' ');
    const interval = setInterval(() => outgoing.write(' '), 50);
    drips.add(interval);
    incoming.socket.once('close', () => {
      firstSocketClosed = true;
      clearInterval(interval);
      drips.delete(interval);
    });
  });
  t.after(() => { for (const interval of drips) clearInterval(interval); });
  const observations = observe(t, collector);
  recordRequests(observations, 32);
  await until(() => collector.received.length === 1, 'The first batch did not reach the receiver');
  recordRequests(observations, 32);
  await until(() => collector.received.length >= 2,
    'The slow response blocked or discarded the next queued batch for more than two seconds');
  await until(() => firstSocketClosed, 'The exporter left the slow response socket open');
  await observations.close();
  assert.equal(spans(collector).length, 64, 'both batches reached the collector');
});

for (const kind of ['requests', 'unfinished native runs']) {
  for (const count of [1, 31, 32, 33, 64, 65]) {
    test(`shutdown exports all ${count} ${kind}`, async t => {
      const collector = await receiver(t);
      const observations = observe(t, collector);
      if (kind === 'requests') recordRequests(observations, count);
      else {
        const scope = { hostId: 'private-shutdown-host', conversationId: 'private-shutdown-conversation' };
        for (let index = 0; index < count; index++) observations.recordRun('codex', scope,
          { kind: 'run-started', runId: `private-shutdown-run-${index}`, previousRunId: null });
      }
      await observations.close();
      const exported = spans(collector);
      assert.equal(exported.length, count, 'shutdown must deliver every span to a healthy receiver');
      assert.equal(new Set(exported.map(span => span.traceId)).size, count);
      for (const span of exported) {
        assert.equal(span.name, kind === 'requests' ? 'agentui.host.request' : 'invoke_agent codex');
        const outcome = span.attributes.find(attribute => attribute.key ===
          (kind === 'requests' ? 'agentui.outcome' : 'switchboard.outcome'));
        assert.equal(outcome?.value.stringValue, kind === 'requests' ? 'ok' : 'outcome-unknown');
      }
    });
  }
}

function exportOne(exporter, span) {
  return new Promise(resolve => exporter.export([span], resolve));
}

const responses = [
  { name: 'an empty success object', body: '{}', success: true },
  { name: 'an empty partial success object', body: '{"partialSuccess":{}}', success: true },
  { name: 'a null partial success object', body: '{"partialSuccess":null}', success: true },
  { name: 'zero rejected spans', body: '{"partialSuccess":{"rejectedSpans":0}}', success: true },
  { name: 'string zero rejected spans', body: '{"partialSuccess":{"rejectedSpans":"0"}}', success: true },
  { name: 'null rejected spans', body: '{"partialSuccess":{"rejectedSpans":null}}', success: true },
  { name: 'an empty error message', body: '{"partialSuccess":{"errorMessage":""}}', success: true },
  { name: 'unknown response fields', body: '{"unknown":{"value":true},"partialSuccess":{"unknown":[]}}', success: true },
  { name: 'a JSON content type with charset', body: '{}', contentType: 'application/json; charset=utf-8', success: true },
  { name: 'a rejected span', body: '{"partialSuccess":{"rejectedSpans":1}}' },
  { name: 'a rejected span string', body: '{"partialSuccess":{"rejectedSpans":"1"}}' },
  { name: 'a negative rejection count', body: '{"partialSuccess":{"rejectedSpans":-1}}' },
  { name: 'a fractional rejection count', body: '{"partialSuccess":{"rejectedSpans":0.5}}' },
  { name: 'a boolean rejection count', body: '{"partialSuccess":{"rejectedSpans":false}}' },
  { name: 'an object rejection count', body: '{"partialSuccess":{"rejectedSpans":{}}}' },
  { name: 'an invalid rejection string', body: '{"partialSuccess":{"rejectedSpans":"invalid"}}' },
  { name: 'an acceptance warning', body: '{"partialSuccess":{"rejectedSpans":0,"errorMessage":"private-collector-error"}}', success: true, warning: true },
  { name: 'an acceptance warning without a rejection count', body: '{"partialSuccess":{"errorMessage":"private-collector-error"}}', success: true, warning: true },
  { name: 'a malformed error message', body: '{"partialSuccess":{"errorMessage":0}}' },
  { name: 'an array partial success', body: '{"partialSuccess":[]}' },
  { name: 'a string partial success', body: '{"partialSuccess":""}' },
  { name: 'a boolean partial success', body: '{"partialSuccess":false}' },
  { name: 'a JSON array', body: '[]' },
  { name: 'JSON null', body: 'null' },
  { name: 'a JSON scalar', body: '0' },
  { name: 'invalid JSON', body: '{private-collector-error' },
  { name: 'an HTML success page', body: '<html>private-collector-error</html>', contentType: 'text/html' },
  { name: 'a missing content type', body: '{}', contentType: null },
  { name: 'an empty JSON response', body: '' },
  { name: 'an empty 204 response', body: '', status: 204 },
  { name: 'a 201 response', body: '{}', status: 201 },
  { name: 'a 400 response', body: 'private-collector-error', status: 400 },
  { name: 'a 429 response', body: '{}', status: 429 },
  { name: 'a 503 response', body: '{}', status: 503 },
  { name: 'invalid UTF-8 inside JSON', body: Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d]) },
  { name: 'a response exactly 64 KiB', body: `${' '.repeat(65534)}{}`, success: true },
  { name: 'a response over 64 KiB', body: `${' '.repeat(65535)}{}` },
  { name: 'a five MiB response', body: `${' '.repeat(5 * 1024 * 1024)}{}` },
];

for (const response of responses) {
  test(`OTLP response contract handles ${response.name}`, async t => {
    const warnings = [];
    if (response.warning) {
      diag.setLogger({ error() {}, warn(...args) { warnings.push(args); }, info() {}, debug() {}, verbose() {} });
      t.after(() => diag.disable());
    }
    const collector = await receiver(t, (_incoming, outgoing) => {
      const contentType = response.contentType === undefined ? 'application/json' : response.contentType;
      outgoing.writeHead(response.status ?? 200, contentType === null ? {} : { 'content-type': contentType });
      outgoing.end(response.body);
    });
    const memory = new InMemorySpanExporter();
    const provider = new TracerProvider({ spanProcessors: [new SimpleSpanProcessor({ exporter: memory })] });
    t.after(() => provider.shutdown());
    provider.getTracer('otlp-response-test').startSpan('agentui.host.request').end();
    const [span] = memory.getFinishedSpans();
    assert.ok(span, 'the SDK produced a readable span');
    const exporter = createOtlpExporter({ endpoint: collector.endpoint, headers: {} });
    t.after(() => exporter.shutdown());
    let callbacks = 0;
    const result = await new Promise(resolve => exporter.export([span], value => { callbacks++; resolve(value); }));
    await exporter.shutdown();
    assert.deepEqual(result, { code: response.success ? ExportResultCode.SUCCESS : ExportResultCode.FAILED },
      'the callback reports only a generic result and never includes collector text');
    assert.equal(callbacks, 1, 'the attempt completes exactly once');
    if (response.warning) {
      assert.equal(warnings.length, 1, 'an accepted warning produces one diagnostic');
      assert.doesNotMatch(JSON.stringify(warnings), /private-collector-error/,
        'diagnostics must never expose collector text');
    }
    assert.equal(collector.received.length, 1, 'the exporter makes one attempt without retrying');
    const exported = spans(collector);
    assert.equal(exported.length, 1);
    assert.equal(exported[0].name, 'agentui.host.request');
    assert.match(exported[0].traceId, /^[0-9a-f]{32}$/);
    assert.match(exported[0].spanId, /^[0-9a-f]{16}$/);
  });
}

test('exporter shutdown waits for an active healthy response and returns the same promise', async t => {
  let release;
  const collector = await receiver(t, (_incoming, outgoing) => {
    release = () => {
      outgoing.writeHead(200, { 'content-type': 'application/json' });
      outgoing.end('{}');
    };
  });
  const memory = new InMemorySpanExporter();
  const provider = new TracerProvider({ spanProcessors: [new SimpleSpanProcessor({ exporter: memory })] });
  t.after(() => provider.shutdown());
  provider.getTracer('otlp-shutdown-test').startSpan('agentui.host.request').end();
  const exporter = createOtlpExporter({ endpoint: collector.endpoint, headers: {} });
  t.after(() => exporter.shutdown());
  const result = exportOne(exporter, memory.getFinishedSpans()[0]);
  await until(() => release !== undefined, 'the receiver did not receive the active export');
  const shutdown = exporter.shutdown();
  assert.equal(exporter.shutdown(), shutdown, 'repeated shutdown calls share completion');
  let closed = false;
  void shutdown.then(() => { closed = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(closed, false, 'shutdown waits for the active export');
  release();
  assert.deepEqual(await result, { code: ExportResultCode.SUCCESS });
  await shutdown;
  assert.equal(collector.received.length, 1);
});

test('an active response drip cannot extend the 500 ms export deadline', { timeout: 3000 }, async t => {
  let interval;
  let socketClosed = false;
  const collector = await receiver(t, (incoming, outgoing) => {
    incoming.socket.once('close', () => { socketClosed = true; clearInterval(interval); });
    outgoing.writeHead(200, { 'content-type': 'application/json' });
    outgoing.write(' ');
    interval = setInterval(() => outgoing.write(' '), 50);
  });
  t.after(() => clearInterval(interval));
  const memory = new InMemorySpanExporter();
  const provider = new TracerProvider({ spanProcessors: [new SimpleSpanProcessor({ exporter: memory })] });
  t.after(() => provider.shutdown());
  provider.getTracer('otlp-deadline-test').startSpan('agentui.host.request').end();
  const exporter = createOtlpExporter({ endpoint: collector.endpoint, headers: {} });
  t.after(() => exporter.shutdown());
  const started = performance.now();
  const result = await exportOne(exporter, memory.getFinishedSpans()[0]);
  const elapsed = performance.now() - started;
  assert.deepEqual(result, { code: ExportResultCode.FAILED });
  assert.ok(elapsed >= 400 && elapsed < 900, `the 500 ms deadline completed after ${elapsed} ms`);
  await until(() => socketClosed, 'the expired export left its response socket open');
  assert.equal(collector.received.length, 1, 'the expired attempt was not retried');
});
