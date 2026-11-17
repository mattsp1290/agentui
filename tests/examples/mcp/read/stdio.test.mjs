import assert from 'node:assert/strict';
import test from 'node:test';
import { cli, compatibility as foreignCompatibility, connect, data, fixture, listen, tools } from './support.mjs';

test('official SDK stdio tools preserve recorded uncertainty and leave durable state and providers untouched', { timeout: 20_000 }, async t => {
  const f = await fixture(t), mcp = await connect(t, f.origin);
  const listed = await mcp.client.listTools();
  assert.deepEqual(listed.tools.map(tool => tool.name).sort(), tools.toSorted());
  assert.ok(listed.tools.every(tool => tool.annotations.readOnlyHint && !tool.annotations.destructiveHint));
  const before = f.durable(), counts = { ...f.counts };
  const call = (name, args = {}) => mcp.client.callTool({ name, arguments: args });
  const agents = data(await call('agentui_agents'));
  assert.deepEqual(agents.agents[0].commands, ['send', 'approve']);
  assert.equal(agents.agents[0].availability.kind, 'ready');
  assert.equal(agents.agents[1].availability.kind, 'unavailable');
  const first = data(await call('agentui_conversations', { limit: 1 }));
  assert.equal(first.items.length, 1);
  assert.equal(first.after, f.scope.conversationId);
  assert.equal(data(await call('agentui_conversations', { after: first.after, limit: 1 })).items[0].scope.conversationId, 'conversation-b');
  assert.equal(data(await call('agentui_conversations', { after: 'conversation-b', limit: 1 })).after, null);
  assert.deepEqual(f.durable(), before);
  for (const kind of ['running', 'stopping', 'ended']) {
    if (kind === 'stopping') f.host.append(f.scope, { events: [{ kind: 'run-stop-requested', runId: 'run-a', clientCommandId: 'stop-original' }], runs: [], decisions: [] });
    if (kind === 'ended') f.host.append(f.scope, { events: [{ kind: 'run-ended', runId: 'run-a', outcome: 'completed' }], runs: [], decisions: [] });
    const phaseBefore = f.durable();
    for (let repeat = 0; repeat < 2; repeat++) {
      const inspected = data(await call('agentui_inspect', { conversationId: f.scope.conversationId }));
      assert.equal(inspected.currentRun.kind, kind);
      assert.equal(inspected.receipts['uncertain-original'].state.kind, 'uncertain');
      assert.equal(inspected.receipts['uncertain-original'].state.reason, 'provider-outcome-unknown');
      assert.equal(inspected.receipts['completed-original'].state.kind, 'completed');
      assert.equal(inspected.receipts['accepted-original'].state.kind, 'accepted');
      assert.equal(inspected.receipts['pending-original'].state.kind, 'pending');
      assert.equal(inspected.decisions['question-a'].runId, 'run-a');
      assert.equal(inspected.activities[0].output, undefined);
      assert.equal(inspected.activities[0].status.kind, 'completed');
      assert.ok(Number.isSafeInteger(inspected.cursor));
    }
    assert.deepEqual(f.durable(), phaseBefore);
  }
  const beforeReceipts = f.durable();
  const receipt = data(await call('agentui_receipt', { conversationId: f.scope.conversationId, clientCommandId: 'uncertain-original' }));
  assert.equal(receipt.receipt.clientCommandId, 'uncertain-original');
  assert.equal(receipt.receipt.state.kind, 'uncertain');
  assert.equal(data(await call('agentui_receipt', { conversationId: f.scope.conversationId, clientCommandId: 'never-recorded' })).receipt, null);
  assert.deepEqual(f.durable(), beforeReceipts);
  assert.deepEqual(f.counts, counts);
  assert.ok(f.operations.every(op => ['metadata', 'catalog', 'conversation-agent', 'watch', 'pull', 'close', 'receipt'].includes(op)));
  assert.equal(f.operations.filter(op => op === 'watch').length, f.operations.filter(op => op === 'close').length);
  const receiptRows = f.durable().commands;
  assert.deepEqual(receiptRows, before.commands);
  assert.equal((await f.host.reconcile(f.scope, 'uncertain-original')).state.kind, 'completed');
  assert.equal(f.counts.lookup, counts.lookup + 1);
  assert.equal(mcp.stderr, '');
});

test('live data tool inputs cannot select mutations or another host', { timeout: 15_000 }, async t => {
  const f = await fixture(t), mcp = await connect(t, f.origin);
  for (const [name, args] of [
    ['agentui_agents', { op: 'reconcile' }], ['agentui_conversations', { limit: 0 }],
    ['agentui_inspect', { conversationId: '', hostId: 'other' }],
    ['agentui_receipt', { conversationId: f.scope.conversationId, clientCommandId: 'x', secret: 'sentinel' }],
  ]) assert.equal((await mcp.client.callTool({ name, arguments: args })).isError, true);
  assert.equal((await mcp.client.callTool({ name: 'reconcile', arguments: {} })).isError, true);
  assert.equal(mcp.stderr, '');
});

test('startup refuses invalid origins, unreachable hosts, extra arguments and the removed pair command', { timeout: 20_000 }, async t => {
  const f = await fixture(t);
  const closed = await listen(t, (_, response) => response.destroy());
  const unreachable = `http://127.0.0.1:${Number(new URL(f.origin).port) === 65535 ? 65534 : 65535}`;
  const cases = [[], ['serve'], ['serve', f.origin, 'extra'], ['serve', 'https://127.0.0.1:7140'], ['serve', 'http://localhost:7140'],
    ['serve', `${f.origin}/`], ['serve', 'http://user@127.0.0.1:7140'], ['serve', `${f.origin}?x=1`], ['serve', `${f.origin}#x`],
    ['serve', 'http://127.0.0.1:0'], ['serve', 'http://127.0.0.1:99999'], ['serve', '/some/profile.json'], ['serve', unreachable], ['serve', closed],
    ['pair', f.origin], ['pair', f.origin, '/tmp/profile.json']];
  for (const args of cases) {
    const result = await cli(args);
    assert.equal(result.code, 1, args.join(' '));
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /^AgentUI MCP startup failed\./u);
  }
});

test('a host answering a different host identity after startup fails tool calls', { timeout: 15_000 }, async t => {
  const f = await fixture(t);
  let foreign = false;
  const origin = await listen(t, async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const input = JSON.parse(Buffer.concat(chunks).toString());
    if (!foreign) {
      const forward = await fetch(`${f.origin}/native/v1`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) });
      response.end(await forward.text());
    } else response.end(JSON.stringify({ ok: true, value: { hostId: 'foreign', principalId: 'trusted-owner', compatibility: foreignCompatibility, agents: [], defaultAgentId: null } }));
  });
  const mcp = await connect(t, origin);
  data(await mcp.client.callTool({ name: 'agentui_agents', arguments: {} }));
  foreign = true;
  for (const [name, args] of [['agentui_agents', {}], ['agentui_conversations', {}],
    ['agentui_inspect', { conversationId: f.scope.conversationId }], ['agentui_receipt', { conversationId: f.scope.conversationId, clientCommandId: 'x' }]]) {
    const result = await mcp.client.callTool({ name, arguments: args });
    assert.equal(result.isError, true, name);
    assert.equal(result.structuredContent, undefined);
    assert.match(result.content[0].text, /Host identity changed/u);
  }
});
