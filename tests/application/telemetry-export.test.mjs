import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { createHostObservability } from '../../apps/host/build/tsc/observability.js';

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

test('shutdown exports all 65 unfinished native runs across multiple batches', async t => {
  const collector = await receiver(t);
  const observations = observe(t, collector);
  const scope = { hostId: 'private-shutdown-host', conversationId: 'private-shutdown-conversation' };
  for (let index = 0; index < 65; index++) observations.recordRun('codex', scope,
    { kind: 'run-started', runId: `private-shutdown-run-${index}`, previousRunId: null });
  await observations.close();
  const exported = spans(collector);
  assert.equal(exported.length, 65, 'normal shutdown must not discard batches after the first 32 runs');
  assert.equal(new Set(exported.map(span => span.traceId)).size, 65);
  for (const span of exported) {
    assert.equal(span.name, 'invoke_agent codex');
    const outcome = span.attributes.find(attribute => attribute.key === 'switchboard.outcome');
    assert.equal(outcome?.value.stringValue, 'outcome-unknown');
  }
});
