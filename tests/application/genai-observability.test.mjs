import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { CODEX_RUNTIME } from '@agentui/contracts/compatibility';
import { createAgentObservations } from '../../apps/host/build/tsc/agent-observations.js';
import { readObservabilityConfiguration } from '../../apps/host/build/tsc/observability.js';
import { attributes, receiver } from './support/observability.mjs';
import { exitWithin, launchProcess, startup } from './support/host-process.mjs';

const hostRequire = createRequire(new URL('../../apps/host/package.json', import.meta.url));
const { InMemorySpanExporter, SimpleSpanProcessor, TracerProvider } = await import(hostRequire.resolve('@opentelemetry/sdk-trace'));
const upstreamScope = { name: '@mattsp1290/switchboard', version: '0.0.0' };
const scope = { hostId: 'private-host-3afb50', conversationId: 'private-conversation-a4590e' };
const start = runId => ({ kind: 'run-started', runId });
const end = (runId, outcome) => ({ kind: 'run-ended', runId, outcome });

function observationFixture(t) {
  const exporter = new InMemorySpanExporter();
  const provider = new TracerProvider({ spanProcessors: [new SimpleSpanProcessor({ exporter })] });
  const observations = createAgentObservations(provider);
  t.after(async () => { observations.close(); await provider.shutdown(); });
  return { observations, spans: () => exporter.getFinishedSpans() };
}

function assertAgentSpan(span, source, provider, outcome) {
  assert.equal(span.name, `invoke_agent ${source}`);
  assert.equal(span.kind, 2, 'native agent invocations use CLIENT spans');
  assert.deepEqual(span.attributes, {
    'gen_ai.provider.name': provider, 'gen_ai.agent.name': source,
    'gen_ai.operation.name': 'invoke_agent', 'switchboard.outcome': outcome,
    ...(outcome === 'error' ? { 'error.type': 'unknown-error' } : {}),
  });
  assert.equal(span.status.code, outcome === 'error' ? 2 : 0);
  assert.equal(span.status.message, undefined);
  assert.deepEqual(span.events, []);
  assert.deepEqual(span.links, []);
  assert.deepEqual(span.instrumentationScope, { ...upstreamScope, schemaUrl: undefined });
  assert.equal(span.parentSpanContext, undefined, 'agent spans have no request or native parent');
}

test('native run observations isolate identical IDs across hosts, conversations and sources', t => {
  const { observations: o, spans } = observationFixture(t);
  const sharedRun = 'private-native-run-7ca182';
  const cases = [
    { source: 'codex', provider: 'openai', scope, outcome: 'completed', expected: 'success' },
    { source: 'codex-sdk', provider: 'openai', scope, outcome: 'failed', expected: 'error' },
    { source: 'claude-sdk', provider: 'anthropic', scope: { ...scope, hostId: 'private-other-host' }, outcome: 'interrupted', expected: 'outcome-unknown' },
    { source: 'pi', provider: 'opencode-go', scope: { ...scope, conversationId: 'private-other-conversation' }, outcome: 'connection-lost', expected: 'outcome-unknown' },
    { source: 'codex', provider: 'openai', scope: { ...scope, conversationId: 'private-codex-conversation' }, outcome: 'failed', expected: 'error' },
    { source: 'codex', provider: 'openai', scope: { ...scope, hostId: 'private-codex-host' }, outcome: 'completed', expected: 'success' },
  ];
  for (const item of cases) {
    o.recordOutput(item.source, item.scope, [end(sharedRun, 'completed')]);
    o.recordOutput(item.source, item.scope, [start(sharedRun)]);
    o.recordOutput(item.source, item.scope, [start(sharedRun)]);
  }
  o.recordOutput('codex', scope, [end('private-stale-run', 'failed')]);
  assert.equal(spans().length, 0, 'unmatched ends and duplicate starts never finish a run');
  for (const item of cases.toReversed()) {
    o.recordOutput(item.source, item.scope, [end(sharedRun, item.outcome)]);
    o.recordOutput(item.source, item.scope, [end(sharedRun, 'failed')]);
  }
  assert.equal(spans().length, cases.length);
  for (const [index, item] of cases.toReversed().entries()) {
    assertAgentSpan(spans()[index], item.source, item.provider, item.expected);
  }
  assert.equal(new Set(spans().map(span => span.spanContext().traceId)).size, cases.length);
  const payload = JSON.stringify(spans().map(span => ({ attributes: span.attributes, events: span.events, links: span.links })));
  for (const value of [sharedRun, scope.hostId, scope.conversationId, 'private-other-host', 'private-other-conversation']) {
    assert.equal(payload.includes(value), false, `Private correlation leaked ${value}`);
  }
});

test('native run capacity rejects excess starts, recovers after finish and closes unfinished runs once', t => {
  const { observations: o, spans } = observationFixture(t);
  for (let index = 0; index < 129; index++) o.recordOutput('codex', scope, [start(`run-${index}`)]);
  o.recordOutput('codex', scope, [end('run-128', 'completed')]);
  assert.equal(spans().length, 0, 'the overflow run never acquired a span');
  o.recordOutput('codex', scope, [end('run-0', 'completed')]);
  assert.equal(spans().length, 1);
  o.recordOutput('codex', scope, [start('replacement')]);
  o.recordOutput('codex', scope, [end('replacement', 'failed')]);
  o.close();
  o.close();
  o.recordOutput('codex', scope, [end('run-1', 'completed')]);
  o.recordOutput('codex', scope, [start('after-close')]);
  o.recordOutput('codex', scope, [end('after-close', 'completed')]);
  assert.equal(spans().length, 129, 'capacity was released and closing did not duplicate or reopen spans');
  assertAgentSpan(spans()[0], 'codex', 'openai', 'success');
  assertAgentSpan(spans()[1], 'codex', 'openai', 'error');
  for (const span of spans().slice(2)) assertAgentSpan(span, 'codex', 'openai', 'outcome-unknown');
});

test('native observations tolerate a failing tracer and can observe a later healthy run', async t => {
  const exporter = new InMemorySpanExporter();
  const provider = new TracerProvider({ spanProcessors: [new SimpleSpanProcessor({ exporter })] });
  const real = provider.getTracer(upstreamScope.name, upstreamScope.version);
  let broken = true;
  const observations = createAgentObservations({ getTracer: () => ({ startSpan(...args) {
    if (broken) throw new Error('private-telemetry-failure-2511f7');
    return real.startSpan(...args);
  } }) });
  t.after(async () => { observations.close(); await provider.shutdown(); });
  assert.doesNotThrow(() => observations.recordOutput('codex', scope, [start('same-run')]));
  assert.doesNotThrow(() => observations.recordOutput('codex', scope, [end('same-run', 'failed')]));
  broken = false;
  observations.recordOutput('codex', scope, [start('same-run')]);
  observations.recordOutput('codex', scope, [end('same-run', 'completed')]);
  assert.equal(exporter.getFinishedSpans().length, 1);
  assertAgentSpan(exporter.getFinishedSpans()[0], 'codex', 'openai', 'success');
});

test('Datadog LLM Observability requires an explicit boolean option and stays absent by default', () => {
  const base = { OTEL_TRACES_EXPORTER: 'otlp' };
  const defaults = readObservabilityConfiguration(base);
  assert.equal(defaults.datadogLlmObservability, false);
  assert.deepEqual(readObservabilityConfiguration({ ...base, AGENTUI_DATADOG_LLMOBS: 'false' }), defaults);
  assert.deepEqual(readObservabilityConfiguration({ ...base, AGENTUI_DATADOG_LLMOBS: 'true' }), {
    ...defaults, datadogLlmObservability: true,
  });
  for (const value of ['TRUE', '1', '', 'private-invalid-option']) {
    assert.throws(() => readObservabilityConfiguration({ ...base, AGENTUI_DATADOG_LLMOBS: value }),
      error => value === '' || !error.message.includes(value));
  }
});

async function until(predicate) {
  for (let attempt = 0; attempt < 500; attempt++) {
    const value = predicate();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail('Timed out waiting for persisted native run');
}

test('bundled host exports upstream GenAI spans for persisted native runs with no private content', { timeout: 25_000 }, async t => {
  const collector = await receiver(t);
  const received = collector.received;
  const directory = mkdtempSync(join(tmpdir(), 'agentui-genai-private-'));
  const workspace = join(directory, 'private-workspace-dc13a5');
  const bin = join(directory, 'bin'), data = join(directory, 'data'), log = join(directory, 'native-rpc.jsonl');
  const environmentLog = join(directory, 'native-environment.jsonl');
  mkdirSync(workspace); mkdirSync(bin);
  const fixture = join(directory, 'codex-fixture.mjs');
  copyFileSync(new URL('../host/fixtures/codex-agent.mjs', import.meta.url), fixture);
  writeFileSync(join(bin, 'codex'), `#!${process.execPath}
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
appendFileSync(${JSON.stringify(environmentLog)}, JSON.stringify({ invocation: process.argv[2],
  telemetryKeys: Object.keys(process.env).filter(key => key.startsWith('OTEL_') || key === 'AGENTUI_DATADOG_LLMOBS'),
  providerCredentialPresent: process.env.OPENAI_API_KEY === 'private-native-provider-credential',
  pathPresent: process.env.PATH?.includes(${JSON.stringify(bin)}) === true }) + '\\n');
if (process.argv[2] === '--version') process.stdout.write(${JSON.stringify(`codex-cli ${CODEX_RUNTIME.version}\n`)});
else {
  process.argv = [process.execPath, ${JSON.stringify(fixture)}, ${JSON.stringify(log)}];
  await import(pathToFileURL(${JSON.stringify(fixture)}).href);
}
`, { mode: 0o700 });
  const launch = args => launchProcess(t, ['apps/host/dist/main.js', ...args, '--data-dir', data], {
    PATH: `${bin}:${process.env.PATH ?? ''}`,
    OTEL_TRACES_EXPORTER: 'otlp', OTEL_EXPORTER_OTLP_ENDPOINT: collector.endpoint,
    OTEL_EXPORTER_OTLP_HEADERS: 'x-host-general-token=private-host-general-credential',
    OTEL_EXPORTER_OTLP_TRACES_HEADERS: 'x-host-trace-token=private-host-trace-credential',
    OTEL_RESOURCE_ATTRIBUTES: 'private.resource=private-host-resource',
    OPENAI_API_KEY: 'private-native-provider-credential',
    AGENTUI_DATADOG_LLMOBS: 'true',
  });
  const host = launch(['codex', '--port', '0', '--workspace', workspace]);
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const ready = await startup(host);
  assert.equal(ready.kind, 'ready', host.stderr);
  const invitation = launch(['invite-native']);
  await exitWithin(invitation);
  const code = JSON.parse(invitation.stdout).value.code;
  const call = (path, body, secret) => new Promise((resolve, reject) => {
    const outgoing = request(`${ready.origin}${path}`, { method: 'POST', headers: {
      'Content-Type': 'application/json', ...(secret ? { Authorization: `Bearer ${secret}` } : {}),
    } }, incoming => {
      let text = '';
      incoming.setEncoding('utf8').on('data', chunk => { text += chunk; });
      incoming.once('error', reject);
      incoming.once('end', () => {
        assert.equal(incoming.statusCode, 200, text);
        const response = JSON.parse(text);
        assert.equal(response.ok, true, text);
        resolve(response.value);
      });
    });
    outgoing.once('error', reject);
    outgoing.setTimeout(5000, () => outgoing.destroy(new Error('Native request timed out')));
    outgoing.end(JSON.stringify(body));
  });
  const credentials = await call('/native/v1/pair', { version: 1, hostId: ready.hostId, code });
  const native = body => call('/native/v1', body, credentials.secret);
  const metadata = await native({ op: 'metadata' });
  const conversation = { hostId: ready.hostId, conversationId: 'private-otlp-conversation-d0ae87' };
  await native({ op: 'create', scope: conversation, agentId: metadata.defaultAgentId });
  const db = new DatabaseSync(join(data, 'host.sqlite'), { readOnly: true });
  t.after(() => db.close());
  const events = () => db.prepare('SELECT payload FROM events ORDER BY sequence').all()
    .map(row => JSON.parse(row.payload).event).filter(event => event.kind === 'domain').map(event => event.event);
  const prompt = 'private-prompt-Do-not-export-0915c7';
  const send = async id => {
    const previous = new Set(events().filter(event => event.kind === 'run-started').map(event => event.runId));
    const result = await native({ op: 'submit', command: { version: 1, scope: conversation,
      clientCommandId: id, body: { kind: 'send', text: prompt } } });
    assert.equal(result.receipt.state.kind, 'completed');
    return until(() => events().find(event => event.kind === 'run-started' && !previous.has(event.runId))?.runId).catch(error => {
      throw new Error(`${error.message}. Events ${JSON.stringify(events())}. Host ${host.stderr}`);
    });
  };
  const first = await send('private-command-first');
  writeFileSync(`${log}.complete-${first}`, '');
  await until(() => events().some(event => event.kind === 'run-ended' && event.runId === first && event.outcome === 'completed'));
  const second = await send('private-command-second');
  await native({ op: 'submit', command: { version: 1, scope: conversation,
    clientCommandId: 'private-command-cancel', body: { kind: 'cancel', runId: second } } });
  await until(() => events().some(event => event.kind === 'run-ended' && event.runId === second && event.outcome === 'interrupted'));
  const third = await send('private-command-third');
  host.process.kill('SIGTERM');
  await exitWithin(host);
  const genai = [];
  for (const batch of received) {
    assert.equal(batch.path, '/v1/traces');
    assert.equal(batch.headers['x-host-general-token'], 'private-host-general-credential');
    assert.equal(batch.headers['x-host-trace-token'], 'private-host-trace-credential');
    for (const resource of batch.body.resourceSpans) {
      assert.deepEqual(attributes(resource.resource.attributes), { 'service.name': 'agentui-host', dd_llmobs_enabled: true });
      for (const group of resource.scopeSpans) {
        for (const span of group.spans) {
          if (span.name === 'agentui.host.request') continue;
          assert.deepEqual(group.scope, upstreamScope);
          const values = attributes(span.attributes);
          assert.equal(span.name, 'invoke_agent codex');
          assert.equal(span.kind, 3);
          assert.deepEqual(values, { 'gen_ai.provider.name': 'openai', 'gen_ai.agent.name': 'codex',
            'gen_ai.operation.name': 'invoke_agent', 'switchboard.outcome': values['switchboard.outcome'] });
          assert.ok(!span.parentSpanId);
          assert.deepEqual(span.events ?? [], []);
          assert.deepEqual(span.links ?? [], []);
          assert.equal(span.status?.code ?? 0, 0);
          assert.ok(!span.status?.message);
          assert.ok(BigInt(span.endTimeUnixNano) >= BigInt(span.startTimeUnixNano));
          genai.push(span);
        }
      }
    }
  }
  assert.deepEqual(genai.map(span => attributes(span.attributes)['switchboard.outcome']).sort(),
    ['outcome-unknown', 'outcome-unknown', 'success']);
  assert.equal(new Set(genai.map(span => span.traceId)).size, 3, 'each persisted native run has its own root trace');
  const rpc = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse) : [];
  assert.ok(rpc.some(message => message.method === 'turn/start'), 'the bundled host exercised the native fixture');
  const nativeEnvironments = readFileSync(environmentLog, 'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(nativeEnvironments.some(value => value.invocation === '--version'), 'the compatibility probe ran');
  assert.ok(nativeEnvironments.some(value => value.invocation === 'app-server'), 'the native agent process ran');
  for (const environment of nativeEnvironments) {
    assert.deepEqual(environment.telemetryKeys, [], `${environment.invocation} inherited host telemetry configuration`);
    assert.equal(environment.providerCredentialPresent, true, 'native provider credentials remain available');
    assert.equal(environment.pathPresent, true, 'native executable lookup remains available');
  }
  const payload = JSON.stringify(received.map(batch => batch.body));
  for (const value of [directory, workspace, prompt, ready.hostId, conversation.conversationId, code,
    credentials.secret, credentials.principalId, first, second, third, 'fixture-thread', 'Hello from the fixture.',
    'private-host-general-credential', 'private-host-trace-credential', 'private-native-provider-credential', 'private-host-resource']) {
    assert.equal(payload.includes(value), false, `Private native value leaked ${value}`);
  }
});
