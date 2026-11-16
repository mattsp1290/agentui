import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { createProviderRegistry } from '@agentui/host';
import { fixture, scope } from '../host/fixture.mjs';
import { actualInput, aguiExtension, offered, send } from './provider-send-fixture.mjs';

const actor = (id = 'owner', authorized = () => true, platform = 'desktop') => ({ id, platform, authorized });
async function local(t, kind, options = {}, hostOptions = {}) {
  const a = aguiExtension({ agui: kind !== 'generic', request: text => ({ ...actualInput(text), runId: `run-${text}` }),
    submit: (operation, { effect }) => effect(operation, 'accepted', operation.request.runId), ...options });
  const registry = createProviderRegistry([{ ...a.value, authority: { credentials: {},
    issue: () => ({ credential: null, expectedAuthority: 'remote-provider', assertAuthorized() {} }), async close() {} } }]);
  await registry.activate(); t.after(() => registry.close());
  const [discovered] = await registry.discover();
  const target = { kind: 'provider', contributionId: discovered.contributionId, instance: discovered.instance, agent: discovered.agents[0],
    presentationVersion: 1, expectedAuthority: discovered.expectedAuthority };
  const f = fixture(t), host = f.open({ providers: registry, ...hostOptions });
  await host.createProviderConversation(scope, target, registry);
  const inspect = action => { const db = new DatabaseSync(f.path); try { return action(db); } finally { db.close(); } };
  const rows = () => inspect(db => ({ commands: db.prepare('SELECT * FROM commands ORDER BY rowid').all(),
    owners: db.prepare('SELECT * FROM frontend_sends ORDER BY rowid').all() }));
  return { a, host, inspect, rows, command: kind === 'offered' ? offered(scope) : send(scope, 'original') };
}
const corrupt = (f, column, value) => f.inspect(db => {
  db.exec('PRAGMA ignore_check_constraints=ON');
  db.prepare(`UPDATE frontend_sends SET ${column}=?`).run(value);
});

for (const kind of ['generic', 'tagged-v1', 'offered']) for (const validity of ['valid', 'revoked', 'platform', 'identifier']) {
  test(`dispatch authority ${kind} ${validity} is checked after input decoding`, async t => {
    let decodes = 0, allowed = true, requester = actor();
    const f = await local(t, kind, { decode(value) {
      if (++decodes === 2) {
        if (validity === 'revoked') allowed = false;
        if (validity === 'platform') requester.platform = 'ios';
        if (validity === 'identifier') requester.id = '';
      }
      return value;
    } });
    requester.authorized = () => allowed;
    const submitted = f.host.conversation(scope, requester).submit(f.command);
    if (kind === 'offered' && validity !== 'valid') await assert.rejects(submitted);
    else assert.equal((await submitted).receipt.state.kind, validity === 'valid' ? 'accepted' : 'not-dispatched');
    const saved = f.rows();
    assert.equal(saved.commands.length, 1);
    assert.equal(JSON.parse(saved.commands[0].receipt).state.kind, validity === 'valid' ? 'accepted' : 'not-dispatched');
    assert.equal(saved.owners.length, kind === 'offered' ? 1 : 0);
    assert.equal(f.a.calls.submits.length, validity === 'valid' ? 1 : 0);
    assert.equal(f.a.calls.reconciles.length, 0);
  });
}

for (const state of ['available', 'released', 'other', 'revoked', 'platform', 'identifier', 'missing', 'wrong-key']) {
  test(`owner-evidence offered ${state} preserves public access and durable bytes`, async t => {
    const f = await local(t, 'offered'), owner = actor();
    await f.host.conversation(scope, owner).submit(f.command);
    if (state === 'released') corrupt(f, 'state', 'unavailable');
    if (state === 'missing') f.inspect(db => db.exec('DELETE FROM frontend_sends'));
    if (state === 'wrong-key') corrupt(f, 'run_id', 'different-run');
    const reader = state === 'other' ? actor('other') : state === 'revoked' ? actor('owner', () => false)
      : state === 'platform' ? actor('owner', () => true, 'ios') : state === 'identifier' ? actor('') : owner;
    const before = f.rows();
    if (state === 'available' || state === 'released') {
      assert.equal((await f.host.conversation(scope, reader).receipt('offered')).state.kind, 'accepted');
      assert.equal((await f.host.reconcile(scope, 'offered', reader)).state.kind, 'completed');
      const after = f.rows();
      assert.equal(after.commands[0].intent, before.commands[0].intent);
      assert.equal(after.commands[0].target, before.commands[0].target);
      assert.deepEqual(after.owners, before.owners);
      assert.deepEqual(f.a.calls.reconciles, f.a.calls.submits);
    } else {
      await assert.rejects(f.host.conversation(scope, reader).receipt('offered'));
      await assert.rejects(f.host.reconcile(scope, 'offered', reader));
      assert.deepEqual(f.rows(), before);
      assert.equal(f.a.calls.reconciles.length, 0);
    }
    assert.equal(f.a.calls.submits.length, 1);
  });
}

for (const state of ['other', 'released', 'revoked-owner', 'revoked-requester', 'platform', 'identifier', 'missing', 'wrong-key']) {
  test(`private-settler offered ${state} never transfers original ownership`, async t => {
    const f = await local(t, 'offered'); let ownerAuthorized = true;
    await f.host.conversation(scope, actor('owner', () => ownerAuthorized)).submit(f.command);
    if (state === 'released') corrupt(f, 'state', 'unavailable');
    if (state === 'revoked-owner') ownerAuthorized = false;
    if (state === 'missing') f.inspect(db => db.exec('DELETE FROM frontend_sends'));
    if (state === 'wrong-key') corrupt(f, 'thread_id', 'different-thread');
    const requester = state === 'revoked-requester' ? actor('other', () => false)
      : state === 'platform' ? actor('other', () => true, 'ios') : state === 'identifier' ? actor('') : actor('other');
    const before = f.rows(), permitted = ['other', 'released', 'revoked-owner'].includes(state);
    const result = await f.host.conversation(scope, requester).submit(send(scope, 'next', 'Next'));
    assert.equal(result.receipt?.state.kind ?? result.reason, permitted ? 'accepted' : 'send-awaiting-confirmation');
    const after = f.rows();
    assert.equal(after.commands.length, permitted ? 2 : 1);
    assert.equal(JSON.parse(after.commands[0].receipt).state.kind, permitted ? 'completed' : 'accepted');
    assert.equal(after.commands[0].intent, before.commands[0].intent);
    assert.equal(after.commands[0].target, before.commands[0].target);
    assert.deepEqual(after.owners, before.owners);
    assert.equal(f.a.calls.submits.length, permitted ? 2 : 1);
    assert.equal(f.a.calls.reconciles.length, permitted ? 1 : 0);
    await assert.rejects(f.host.conversation(scope, actor('other')).receipt('offered'), /frontend-owner/);
  });
}

for (const kind of ['generic', 'tagged-v1']) for (const validity of ['absent', 'valid', 'revoked', 'platform', 'identifier']) {
  test(`private-settler ${kind} ${validity} retains generic actor semantics`, async t => {
    const f = await local(t, kind);
    await f.host.conversation(scope).submit(f.command);
    const requester = validity === 'absent' ? undefined : validity === 'revoked' ? actor('other', () => false)
      : validity === 'platform' ? actor('other', () => true, 'ios') : validity === 'identifier' ? actor('') : actor('other');
    assert.equal((await f.host.conversation(scope, requester).receipt('original')).state.kind, 'accepted');
    const before = f.rows();
    const settled = validity !== 'revoked', admitted = validity === 'absent' || validity === 'valid';
    const submitted = f.host.conversation(scope, requester).submit(send(scope, 'next', 'Next'));
    if (validity === 'platform' || validity === 'identifier') await assert.rejects(submitted);
    else {
      const result = await submitted;
      assert.equal(result.receipt?.state.kind ?? result.reason, admitted ? 'accepted' : 'send-awaiting-confirmation');
    }
    const after = f.rows();
    assert.equal(after.commands.length, admitted ? 2 : 1);
    assert.equal(JSON.parse(after.commands[0].receipt).state.kind, settled ? 'completed' : 'accepted');
    assert.equal(after.commands[0].target, before.commands[0].target);
    assert.equal(after.commands[0].intent, before.commands[0].intent);
    assert.deepEqual(after.owners, []);
    assert.equal(f.a.calls.reconciles.length, settled ? 1 : 0);
    assert.equal(f.a.calls.submits.length, admitted ? 2 : 1);
    if (!settled) assert.deepEqual(after, before);
  });
}

for (const kind of ['generic', 'tagged-v1']) test(`owner-evidence ${kind} does not recheck scope or actor after lookup`, async t => {
  let authorized = true;
  const f = await local(t, kind, { reconcile(operation, { effect }) {
    authorized = false;
    return effect(operation, 'completed', operation.request.runId);
  } }, { authorize: () => authorized });
  await f.host.conversation(scope).submit(f.command);
  const requester = actor('', () => false, 'ios');
  assert.equal((await f.host.conversation(scope, requester).receipt('original')).state.kind, 'accepted');
  assert.equal((await f.host.reconcile(scope, 'original', requester)).state.kind, 'completed');
  assert.equal(authorized, false);
});
