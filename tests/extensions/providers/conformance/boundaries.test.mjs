import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { assertPrivateValuesAbsent, receiver } from '../../../application/support/observability.mjs';
import { connect, data } from '../../../examples/mcp/read/support.mjs';
import { assistantTexts, host, runOf, until } from './harness.mjs';
import { providers } from './providers.mjs';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const grep = (...args) => {
  try { return execFileSync('git', ['grep', '-n', '-i', ...args], { cwd: root, encoding: 'utf8' }); }
  catch (error) { if (error.status === 1) return ''; throw error; }
};

// Lexical: a Crew-shaped branch that never names Crew passes. Vendored `.tgz` archives are opaque to git grep and out
// of scope; their declared dependencies are still covered through package-lock.json.
test('core apps, packages, scripts and templates carry no Crew reference and the repository carries no OpenBot code or dependency', () => {
  assert.equal(grep('crew', '--', 'apps', 'packages', 'scripts', 'templates',
    ':(exclude)packages/adapter-tests/tests/types.test.mjs'), '');
  assert.match(grep('crew', '--', 'packages/adapter-tests/tests/types.test.mjs'), /example\.crew/, 'the search finds the one excluded fixture');
  assert.equal(grep('openbot', '--', '.', ':(exclude)docs/extensions/provider-contract.md',
    ':(exclude)tests/extensions/providers/conformance/boundaries.test.mjs'), '');
});

async function converse(f, row, subject, text) {
  const scope = await f.create(subject.namespace), store = await f.store(scope);
  await until(() => subject.subscriptions() === 1, `${row.name} subscription`);
  await store.send(text);
  await until(() => runOf(store)?.kind === 'running', `${row.name} run`);
  return { scope, store };
}

for (const row of providers) test(`${row.name}: provider traffic carries no collector credentials or incoming trace context, and telemetry carries no conversation content`, { timeout: 30_000 }, async t => {
  const collector = await receiver(t), subject = await row.start(t);
  const traceId = '4bf92f3577b34da6a3ce929d0e0e4736', parentId = '00f067aa0ba902b7', collectorToken = 'private collector=token-91d2';
  const prompt = 'PRIVATE_PROMPT_CANARY_7c1e', reply = 'PRIVATE_REPLY_CANARY_0b9a';
  const f = await host(t, [subject.extension()], {
    observability: { kind: 'otlp', endpoint: `${collector.endpoint}/v1/traces`, headers: { 'x-collector-token': collectorToken },
      serviceName: 'agentui-provider-conformance', datadogLlmObservability: false },
    headers: { traceparent: `00-${traceId}-${parentId}-01`, tracestate: `vendor=${parentId}`, baggage: `private=${collectorToken}`,
      'x-collector-token': collectorToken },
  });
  const { store } = await converse(f, row, subject, prompt);
  subject.reply(reply);
  await until(() => runOf(store)?.kind === 'ended', 'run ended');
  assert.deepEqual(assistantTexts(store), [reply]);
  await f.close();
  assert.ok(subject.traffic.some(call => call.headers[subject.credentialHeader]), 'the proxy sees the provider credential header');
  for (const call of subject.traffic) {
    for (const header of ['traceparent', 'tracestate', 'baggage', 'x-collector-token']) assert.equal(call.headers[header], undefined, `${header} on ${call.path}`);
    assert.doesNotMatch(JSON.stringify(call.headers), new RegExp(`${traceId}|${parentId}|token-91d2`));
  }
  await until(() => collector.received.length > 0, 'spans exported');
  const spans = collector.received.flatMap(request => request.body.resourceSpans.flatMap(resource => resource.scopeSpans.flatMap(scope => scope.spans)));
  assert.ok(spans.length > 0);
  assert.deepEqual([...new Set(spans.map(span => span.name))], ['agentui.host.request'], 'no AgentUI agent span is synthesized for a remote run');
  assert.ok(spans.every(span => !span.parentSpanId && span.traceId !== traceId), 'incoming trace context is not adopted');
  const exported = collector.received.map(request => request.body);
  assert.throws(() => assertPrivateValuesAbsent(exported, ['agentui-provider-conformance']), /Private value leaked/,
    'the canary search finds a value that is exported');
  assertPrivateValuesAbsent(exported, [prompt, reply, collectorToken, ...subject.secrets]);
});

test('the generic MCP read example inspects both providers through the host contract without provider effects', { timeout: 30_000 }, async t => {
  const [crewRow, ledgerRow] = providers;
  const crew = await crewRow.start(t), ledger = await ledgerRow.start(t);
  const f = await host(t, [crew.extension(), ledger.extension()]);
  const conversations = [];
  for (const [row, subject] of [[crewRow, crew], [ledgerRow, ledger]]) {
    const { scope, store } = await converse(f, row, subject, `Hello ${subject.namespace}`);
    subject.reply(`Reply from ${subject.namespace}`);
    await until(() => runOf(store)?.kind === 'ended', `${row.name} ended`);
    conversations.push({ subject, scope });
  }
  const effects = conversations.map(({ subject }) => subject.effects()), traffic = conversations.map(({ subject }) => subject.traffic.length);
  const mcp = await connect(t, f.running.origin);
  const call = (name, args = {}) => mcp.client.callTool({ name, arguments: args });
  const agents = data(await call('agentui_agents')).agents.filter(agent => agent.kind === 'provider');
  assert.deepEqual(agents.map(agent => [agent.namespace, agent.availability.kind, agent.commands]).toSorted(),
    [['crew', 'ready', ['send', 'cancel', 'approve']], ['ledger', 'ready', ['send', 'cancel', 'approve']]]);
  for (const { scope } of conversations) {
    const inspected = data(await call('agentui_inspect', { conversationId: scope.conversationId }));
    assert.equal(inspected.currentRun.kind, 'ended');
    assert.equal(inspected.currentRun.outcome, 'completed');
    assert.equal(Object.values(inspected.receipts).length, 1);
  }
  assert.deepEqual(conversations.map(({ subject }) => subject.effects()), effects);
  assert.deepEqual(conversations.map(({ subject }) => subject.traffic.length), traffic);
  assert.deepEqual(conversations.map(({ subject }) => subject.subscriptions()), [1, 1]);
  assert.equal(mcp.stderr, '');
});
