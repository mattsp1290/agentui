import assert from 'node:assert/strict';
import { chmodSync, readFileSync, statSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { cli, connect, data, fixture, privateDirectory, tools, writeProfile } from './support.mjs';

test('official SDK stdio tools preserve recorded uncertainty and leave durable state and providers untouched', { timeout: 20_000 }, async t => {
  const f = await fixture(t), paired = await f.pair(), mcp = await connect(t, paired.path);
  assert.equal(statSync(paired.path).mode & 0o777, 0o600);
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
  const f = await fixture(t), paired = await f.pair(), mcp = await connect(t, paired.path);
  for (const [name, args] of [
    ['agentui_agents', { op: 'reconcile' }], ['agentui_conversations', { limit: 0 }],
    ['agentui_inspect', { conversationId: '', hostId: 'other' }],
    ['agentui_receipt', { conversationId: f.scope.conversationId, clientCommandId: 'x', secret: 'sentinel' }],
  ]) assert.equal((await mcp.client.callTool({ name, arguments: args })).isError, true);
  assert.equal((await mcp.client.callTool({ name: 'reconcile', arguments: {} })).isError, true);
  assert.ok(!mcp.stderr.includes(paired.record.secret));
});

test('startup refuses missing, malformed, insecure, symlinked and host-mismatched profiles without secret output', { timeout: 20_000 }, async t => {
  const f = await fixture(t), paired = await f.pair(), privateDir = privateDirectory(t);
  const profiles = [join(privateDir, 'missing'), writeProfile(privateDir, { ...paired.record, hostId: 'other' }, 'host'),
    writeProfile(privateDir, { ...paired.record, unexpected: true }, 'malformed')];
  const insecure = writeProfile(privateDir, paired.record, 'insecure');
  chmodSync(insecure, 0o644); profiles.push(insecure);
  const link = join(privateDir, 'link'); symlinkSync(paired.path, link); profiles.push(link);
  for (const path of profiles) {
    const result = await cli(['serve', path]);
    assert.equal(result.code, 1);
    assert.equal(result.stdout, '');
    assert.ok(!result.stderr.includes(paired.record.secret));
  }
  const original = readFileSync(paired.path, 'utf8');
  assert.equal((await cli(['pair', f.origin, paired.path], f.invitation())).code, 1);
  assert.equal(readFileSync(paired.path, 'utf8'), original);
});
