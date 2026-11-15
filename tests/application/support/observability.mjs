import assert from 'node:assert/strict';
import { createServer } from 'node:http';

export async function receiver(t, respond = (_incoming, outgoing) => {
  outgoing.writeHead(200, { 'content-type': 'application/json' });
  outgoing.end('{"partialSuccess":{}}');
}) {
  const received = [];
  let first;
  const firstRequest = new Promise(resolve => { first = resolve; });
  const server = createServer((incoming, outgoing) => {
    let body = '';
    incoming.setEncoding('utf8').on('data', chunk => { body += chunk; });
    incoming.once('end', () => {
      const record = { path: incoming.url, headers: incoming.headers, body: JSON.parse(body) };
      received.push(record);
      first(record);
      respond(incoming, outgoing, received.length);
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  return { endpoint: `http://127.0.0.1:${server.address().port}`, received, firstRequest };
}

export function attributes(values = []) {
  return Object.fromEntries(values.map(({ key, value }) => [key, value.stringValue ?? value.boolValue ?? Number(value.intValue)]));
}

export function assertPrivateValuesAbsent(payload, canaries) {
  const text = JSON.stringify(payload);
  for (const canary of canaries) assert.equal(text.includes(canary), false, `Private value leaked ${canary}`);
}

export function assertRequestSpan(span, expected) {
  assert.equal(span.name, 'agentui.host.request');
  assert.equal(span.kind, 2);
  assert.ok(BigInt(span.endTimeUnixNano) > BigInt(span.startTimeUnixNano),
    `span duration includes request handling ${span.startTimeUnixNano} -> ${span.endTimeUnixNano}`);
  assert.ok(span.parentSpanId === undefined || span.parentSpanId === '', 'request spans are roots');
  assert.deepEqual(span.events ?? [], []);
  assert.deepEqual(span.links ?? [], []);
  assert.deepEqual(attributes(span.attributes), expected);
  assert.equal(span.status?.code ?? 0, expected['agentui.outcome'] === 'ok' ? 0 : 2);
  assert.ok(!span.status?.message);
}

export function assertBoundedRequestSpans(received, { serviceName, collectorHeaders, expected, canaries }) {
  assert.ok(received.length > 0, 'graceful shutdown flushes request spans to the receiver');
  const spans = [];
  for (const request of received) {
    assert.equal(request.path, '/v1/traces');
    assert.match(request.headers['content-type'], /^application\/json/);
    for (const [key, value] of Object.entries(collectorHeaders)) assert.equal(request.headers[key], value);
    for (const resource of request.body.resourceSpans) {
      assert.deepEqual(attributes(resource.resource.attributes), { 'service.name': serviceName });
      for (const scope of resource.scopeSpans) spans.push(...scope.spans);
    }
  }
  assert.equal(spans.length, expected.length, 'only the expected requests export spans, once each');
  for (const span of spans) {
    const values = attributes(span.attributes);
    assert.deepEqual(Object.keys(values).sort(), ['agentui.credential_class', 'agentui.operation', 'agentui.outcome', 'http.response.status_code']);
    assertRequestSpan(span, values);
  }
  const byValue = values => values.map(value => JSON.stringify(value, Object.keys(value).sort())).sort();
  assert.deepEqual(byValue(spans.map(span => attributes(span.attributes))), byValue(expected));
  assertPrivateValuesAbsent(received.map(request => request.body), canaries);
}
