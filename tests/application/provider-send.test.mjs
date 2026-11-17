import { canonicalJson } from '@agentui/contracts';
import { transcriptProjection } from '@agentui/contracts/conversation';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { createProviderRegistry } from '@agentui/host';
import { frontendToolsFor } from '@agentui/host/frontend-tools';
import { createServerExtensions } from '@agentui/host/extensions';
import { entry } from '../host/extensions/fixtures.mjs';
import { fixture as hostFixture, scope as hostScope, snapshot } from '../host/fixture.mjs';
import { SERVICE_WIRE_VERSION } from '@agentui/contracts/compatibility';
import { extension, fixture, create, stored, send, unavailable, actualInput, offered, aguiExtension, secret, selected } from './provider-send-fixture.mjs';

test('authenticated send commits exact target before HTTP effect, persists accepted runs for distinct typed models, and emits receipts only', async t => {
  let f;
  const remote = createServer(async (request, response) => {
    assert.equal(request.headers.authorization, `Bearer ${secret}`);
    let body = ''; for await (const part of request) body += part;
    const operation = JSON.parse(body), row = stored(f, operation.binding.creation.scope.conversationId);
    assert.deepEqual(JSON.parse(row.target).operation, operation);
    assert.equal(JSON.parse(row.receipt).state.kind, 'pending');
    response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(a.effect(operation)));
  });
  await new Promise(resolve => remote.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => remote.close(resolve)));
  const service = `http://127.0.0.1:${remote.address().port}`;
  const a = extension({ service, submit: (operation, { context, credential }) => context.credentials.use({ credential, service }, async token => {
    return (await fetch(service, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: JSON.stringify(operation) })).json();
  }) }), b = extension({ native: true, submit: (operation, { effect }) => effect(operation, 'completed') });
  f = await fixture(t, [a, b]);
  const metadata = await f.client.metadata(); assert.equal(metadata.compatibility.wireVersion, SERVICE_WIRE_VERSION);
  for (const agent of metadata.agents.filter(agent => agent.kind === 'provider')) assert.deepEqual(agent.commands, agent.label === 'Local provider' ? ['send', 'cancel', 'approve'] : ['send', 'approve']);
  const scope = await create(f, 'remote'), local = await create(f, 'local', 'Local provider');
  const native = f.scope('native'); await f.client.create(native, metadata.defaultAgentId);
  const nativeBytes = f.inspect(db => db.prepare("SELECT installation,document FROM conversations WHERE conversation='native'").get());
  assert.equal((await f.client.conversation(scope).submit(send(scope))).receipt.state.kind, 'accepted');
  assert.equal((await f.client.conversation(local).submit(send(local))).receipt.state.kind, 'completed');
  assert.deepEqual(a.calls.submits[0].request, { member: 'research', text: 'Hello' });
  assert.deepEqual(b.calls.submits[0].request, { input: [{ role: 'user', content: 'Hello' }] });
  const runs = f.inspect(db => db.prepare('SELECT conversation,data FROM runs ORDER BY conversation').all());
  assert.equal(runs.length, 2);
  assert.deepEqual(runs.map(row => JSON.parse(row.data).identity.runId), ['same-run', 'same-run']);
  assert.deepEqual(runs.map(row => JSON.parse(row.data).identity.authority.kind), ['agentui-host', 'remote-provider']);
  assert.equal(f.inspect(db => db.prepare("SELECT COUNT(*) AS n FROM events WHERE json_extract(payload,'$.event.kind')<>'receipt'").get().n), 0);
  assert.equal((await f.client.conversation(scope).submit(send(scope, 'next'))).reason, 'send-awaiting-confirmation');
  for (const body of [{ kind: 'cancel', runId: 'same-run' }, { kind: 'approve', pendingId: 'same-decision', choiceId: 'same-choice' }]) {
    assert.equal((await f.client.conversation(scope).submit({ ...send(scope, body.kind), body })).kind, 'rejected');
  }
  await f.restart([]);
  assert.deepEqual(await f.client.conversation(scope).submit(send(scope)), { kind: 'receipt', receipt: JSON.parse(stored(f, 'remote').receipt) });
  assert.equal((await f.client.reconcile(scope, 'send')).state.kind, 'accepted');
  assert.deepEqual(f.inspect(db => db.prepare('SELECT conversation,data FROM runs ORDER BY conversation').all()), runs);
  assert.deepEqual(f.inspect(db => db.prepare("SELECT installation,document FROM conversations WHERE conversation='native'").get()), nativeBytes);
});

test('follow-up retains refusal for unresolved, failed and mismatched original lookups', async t => {
  const a = extension(), f = await fixture(t, [a]), scope = await create(f);
  const first = await f.client.conversation(scope).submit(send(scope)), bytes = stored(f, 'chat');
  for (const reconcile of [
    operation => a.effect(operation),
    () => ({ kind: 'pending', evidence: { queued: true } }),
    () => ({ kind: 'uncertain', evidence: null }),
    () => ({ kind: 'unavailable', reason: 'missing' }),
    () => { throw new Error('Read failed'); },
    operation => a.effect(operation, 'completed', 'foreign-run'),
  ]) {
    a.connected.reconcileCommand = reconcile;
    assert.deepEqual(await f.client.conversation(scope).submit(send(scope, 'next')), { kind: 'rejected', reason: 'send-awaiting-confirmation' });
    assert.deepEqual(await f.client.conversation(scope).receipt('send'), first.receipt);
    assert.equal(await f.client.conversation(scope).receipt('next'), null);
    assert.equal(stored(f, 'chat').target, bytes.target);
    assert.equal(a.calls.submits.length, 1);
  }
});

test('pending send blocks follow-up without lookup, while confirmed rejection admits it', async t => {
  const a = extension({ submit: () => ({ kind: 'pending', evidence: { queued: true } }),
    reconcile: () => ({ kind: 'rejected', reason: 'Declined', evidence: { rejected: true } }) });
  const f = await fixture(t, [a]), scope = await create(f), port = f.client.conversation(scope);
  assert.equal((await port.submit(send(scope))).receipt.state.kind, 'pending');
  assert.equal((await port.submit(send(scope, 'next'))).reason, 'send-awaiting-confirmation');
  assert.equal(a.calls.reconciles.length, 0);
  a.connected.reconcileCommand = async operation => a.effect(operation);
  await f.client.reconcile(scope, 'send');
  a.connected.reconcileCommand = async () => ({ kind: 'rejected', reason: 'Declined', evidence: { rejected: true } });
  assert.equal((await port.submit(send(scope, 'next'))).receipt.state.kind, 'pending');
  assert.equal((await port.receipt('send')).state.kind, 'rejected');
  assert.equal(a.calls.submits.length, 2);
});

for (const duplicate of [false, true]) {
  test(`racing ${duplicate ? 'duplicate' : 'distinct'} follow-ups admit one new send after original confirmation`, { timeout: 5000 }, async t => {
    const entered = Promise.withResolvers(), release = Promise.withResolvers();
    const a = extension({ submit: (operation, { effect }) => effect(operation),
      async reconcile(operation, { effect }) {
        if (a.calls.reconciles.length === 2) entered.resolve();
        await release.promise;
        return effect(operation, 'completed');
      } });
    const f = await fixture(t, [a]), scope = await create(f), port = f.client.conversation(scope);
    await port.submit(send(scope));
    a.connected.submit = async operation => { a.calls.submits.push(operation); return { kind: 'pending', evidence: { queued: true } }; };
    const left = port.submit(send(scope, 'left')), right = port.submit(send(scope, duplicate ? 'left' : 'right'));
    await entered.promise;
    release.resolve();
    const results = await Promise.all([left, right]);
    assert.equal(results.filter(result => result.kind === 'receipt').length, duplicate ? 2 : 1);
    if (duplicate) assert.equal(results[0].receipt.hostOperationId, results[1].receipt.hostOperationId);
    else assert.equal(results.find(result => result.kind === 'rejected').reason, 'send-awaiting-confirmation');
    assert.deepEqual(a.calls.reconciles, [a.calls.submits[0], a.calls.submits[0]]);
    assert.equal(a.calls.submits.length, 2);
    assert.equal(f.inspect(db => db.prepare('SELECT COUNT(*) AS n FROM commands').get().n), 2);
    assert.equal((await port.receipt('send')).state.kind, 'completed');
  });
}

test('follow-up refuses completion returned after the original provider credential is revoked', async t => {
  const a = extension({ reconcile(operation, { effect }) {
    f.inspect(db => db.exec('UPDATE service_provider_credentials SET revoked=1'));
    return effect(operation, 'completed');
  } });
  const f = await fixture(t, [a]), scope = await create(f), port = f.client.conversation(scope);
  const first = await port.submit(send(scope));
  assert.equal((await port.submit(send(scope, 'next'))).reason, 'send-awaiting-confirmation');
  assert.deepEqual(await port.receipt('send'), first.receipt);
  assert.equal(await port.receipt('next'), null);
  assert.equal(a.calls.submits.length, 1);
});

test('follow-up rechecks local authority after original confirmation', async t => {
  let authorized = true;
  const a = extension({ reconcile(operation, { effect }) { authorized = false; return effect(operation, 'completed'); } });
  const registry = createProviderRegistry([{ ...a.value, authority: { credentials: {},
    issue: () => ({ credential: null, expectedAuthority: 'remote-provider', assertAuthorized() {} }), async close() {} } }]);
  await registry.activate(); t.after(() => registry.close());
  const [discovered] = await registry.discover();
  const target = { kind: 'provider', contributionId: discovered.contributionId, instance: discovered.instance, agent: discovered.agents[0],
    presentationVersion: 1, expectedAuthority: discovered.expectedAuthority };
  const f = hostFixture(t), host = f.open({ providers: registry, authorize: () => authorized });
  await host.createProviderConversation(hostScope, target, registry);
  const port = host.conversation(hostScope);
  await port.submit(send(hostScope));
  await assert.rejects(port.submit(send(hostScope, 'next')), /Unauthorized scope/);
  authorized = true;
  assert.equal(await port.receipt('next'), null);
  assert.equal(a.calls.submits.length, 1);
  assert.equal((await port.receipt('send')).state.kind, 'completed');
});

test('lost response and restart retry never translate or submit; explicit lookup receives original bytes and rejects a changed run', async t => {
  const a = extension({ submit() { throw new Error('Reply lost'); } }), f = await fixture(t, [a]), scope = await create(f);
  const original = await f.client.conversation(scope).submit(send(scope));
  assert.equal(original.receipt.state.kind, 'uncertain'); assert.equal(a.calls.translations, 1);
  const target = stored(f, 'chat').target;
  const b = extension({ request() { assert.fail('Retry must not translate'); } }); await f.restart([b]);
  assert.deepEqual(await f.client.conversation(scope).submit(send(scope)), original);
  assert.equal((await f.client.conversation(scope).submit(send(scope, 'send', 'different'))).reason, 'command-id-conflict');
  assert.equal(b.calls.translations + b.calls.submits.length + b.calls.reconciles.length, 0);
  const accepted = await f.client.reconcile(scope, 'send'); assert.equal(accepted.state.kind, 'accepted');
  assert.deepEqual(b.calls.reconciles, a.calls.submits); assert.equal(stored(f, 'chat').target, target);
  const run = f.inspect(db => db.prepare('SELECT data FROM runs').get().data);
  b.connected.reconcileCommand = async operation => b.effect(operation, 'completed', 'different-run');
  await unavailable(f.client.reconcile(scope, 'send'));
  assert.equal((await f.client.conversation(scope).receipt('send')).state.kind, 'accepted');
  assert.equal(f.inspect(db => db.prepare('SELECT data FROM runs').get().data), run);
  b.connected.reconcileCommand = async operation => b.effect(operation, 'completed');
  assert.equal((await f.client.reconcile(scope, 'send')).state.kind, 'completed');
  assert.equal(f.inspect(db => db.prepare("SELECT COUNT(*) AS n FROM events WHERE json_extract(payload,'$.event.kind')<>'receipt'").get().n), 0);
});

for (const state of ['pending', 'accepted']) {
  test(`${state} positive facts survive weaker lookups, replaced credentials, missing generations and revocation`, async t => {
    const a = extension({ submit: (operation, { effect }) => state === 'pending' ? { kind: 'pending', evidence: { admitted: true } } : effect(operation) });
    const f = await fixture(t, [a]), scope = await create(f);
    const original = await f.client.conversation(scope).submit(send(scope)), bytes = stored(f, 'chat');
    for (const kind of ['unavailable', 'authentication-failed', 'unsupported', 'not-dispatched', 'uncertain']) {
      a.connected.reconcileCommand = async () => ({ kind, reason: secret, ...(kind === 'uncertain' ? { evidence: null } : {}) });
      assert.deepEqual(await f.client.reconcile(scope, 'send'), original.receipt);
      assert.equal((await f.client.conversation(scope).submit(send(scope, 'next'))).reason, 'send-awaiting-confirmation');
      assert.deepEqual(stored(f, 'chat'), bytes);
    }
    for (const change of [{ revision: '2' }, { generation: 'replacement' }]) {
      const b = extension(change); await f.restart([b]);
      assert.deepEqual(await f.client.conversation(scope).submit(send(scope)), original);
      assert.deepEqual(await f.client.reconcile(scope, 'send'), original.receipt);
      assert.equal((await f.client.conversation(scope).submit(send(scope, 'next'))).reason, 'send-awaiting-confirmation');
      assert.equal(b.calls.translations + b.calls.submits.length + b.calls.reconciles.length, 0);
      assert.deepEqual(stored(f, 'chat'), bytes);
    }
    const b = extension(); await f.restart([b]);
    f.inspect(db => db.exec('UPDATE service_provider_credentials SET revoked=1'));
    assert.deepEqual(await f.client.reconcile(scope, 'send'), original.receipt);
    assert.equal((await f.client.conversation(scope).submit(send(scope, 'next'))).reason, 'send-awaiting-confirmation');
    assert.equal(b.calls.reconciles.length, 0); assert.deepEqual(stored(f, 'chat'), bytes);
  });
}

for (const field of ['scope', 'operation', 'generation', 'protocol', 'namespace', 'installation', 'authority', 'host', 'session', 'effect']) {
  test(`foreign ${field} in command confirmation cannot establish acceptance or a run`, async t => {
    const a = extension({ native: field === 'host', submit(operation, { effect }) {
      const result = structuredClone(effect(operation)), run = result.value.run;
      if (field === 'scope') run.binding.creation.scope.conversationId = 'foreign';
      if (field === 'operation') run.binding.creation.operationId = '00000000-0000-4000-8000-000000000000';
      if (field === 'generation') run.ref.instance.generation = 'foreign';
      if (field === 'protocol') run.ref.instance.protocolVersion = 'foreign';
      if (field === 'namespace') run.ref.instance.namespace = 'foreign';
      if (field === 'installation') run.ref.instance.installationId = 'foreign';
      if (field === 'authority') run.binding.authority = { ...run.binding.authority, kind: 'agentui-host', hostId: operation.binding.creation.scope.hostId };
      if (field === 'host') run.binding.authority.hostId = 'foreign';
      if (field === 'session') run.binding.authority.binding.opaqueSessionId = 'foreign';
      if (field === 'effect') result.value.kind = 'cancel';
      return result;
    } });
    const f = await fixture(t, [a]), scope = await create(f, 'chat', field === 'host' ? 'Local provider' : 'Remote provider');
    assert.equal((await f.client.conversation(scope).submit(send(scope))).receipt.state.kind, 'uncertain');
    assert.equal(f.inspect(db => db.prepare('SELECT COUNT(*) AS n FROM runs').get().n), 0);
  });
}

test('decoder drift refuses lookup without replacing the captured operation; revocation during submit discards the late response', async t => {
  const a = extension({ submit() { throw new Error('Reply lost'); } }), f = await fixture(t, [a]), scope = await create(f);
  await f.client.conversation(scope).submit(send(scope)); const target = stored(f, 'chat').target;
  const b = extension({ decode: () => ({ member: 'changed', text: 'changed' }) }); await f.restart([b]);
  assert.equal((await f.client.reconcile(scope, 'send')).state.kind, 'uncertain');
  assert.equal(b.calls.reconciles.length + b.calls.translations, 0); assert.equal(stored(f, 'chat').target, target);
  const c = extension({ submit(operation, { effect }) { f.inspect(db => db.exec('UPDATE service_provider_credentials SET revoked=1')); return effect(operation); } });
  await f.restart([c]); const next = await create(f, 'late');
  assert.equal((await f.client.conversation(next).submit(send(next))).receipt.state.kind, 'uncertain');
  assert.equal(f.inspect(db => db.prepare('SELECT COUNT(*) AS n FROM runs').get().n), 0);
});

test('capability intersection requires reconciliation and never changes the provider identifier', async t => {
  const a = extension({ reconcileSupported: false }), f = await fixture(t, [a]), agent = await selected(f), scope = await create(f);
  assert.deepEqual(agent.commands, []);
  assert.equal((await f.client.conversation(scope).submit(send(scope))).kind, 'rejected'); assert.equal(a.calls.translations, 0);
  await f.restart([extension()]);
  const enabled = await selected(f); assert.equal(enabled.id, agent.id); assert.deepEqual(enabled.commands, ['send', 'approve']);
  assert.equal((await f.client.conversation(scope).submit(send(scope))).receipt.state.kind, 'accepted');
});

test('admission and accepted run writes roll back atomically; recovery looks up an intent even before known dispatch', async t => {
  const a = extension(), f = await fixture(t, [a]), scope = await create(f);
  f.inspect(db => db.exec("CREATE TRIGGER fail_command BEFORE INSERT ON commands BEGIN SELECT RAISE(ABORT,'injected'); END"));
  await unavailable(f.client.conversation(scope).submit(send(scope)));
  assert.equal(a.calls.submits.length, 0);
  assert.equal(f.inspect(db => db.prepare('SELECT COUNT(*) AS n FROM events').get().n), 0);
  f.inspect(db => db.exec("DROP TRIGGER fail_command; CREATE TRIGGER fail_receipt BEFORE UPDATE ON commands WHEN json_extract(NEW.receipt,'$.state.kind')='accepted' BEGIN SELECT RAISE(ABORT,'injected'); END"));
  await unavailable(f.client.conversation(scope).submit(send(scope)));
  assert.equal(a.calls.submits.length, 1); assert.equal(f.inspect(db => db.prepare('SELECT COUNT(*) AS n FROM runs').get().n), 0);
  assert.equal((await f.client.conversation(scope).receipt('send')).state.kind, 'pending');
  f.inspect(db => db.exec('DROP TRIGGER fail_receipt'));
  const b = extension({ request() { assert.fail('Recovery cannot translate'); } }); await f.restart([b]);
  assert.equal((await f.client.conversation(scope).submit(send(scope))).receipt.state.kind, 'pending');
  assert.equal((await f.client.reconcile(scope, 'send')).state.kind, 'accepted');
  assert.deepEqual(b.calls.reconciles, a.calls.submits); assert.equal(b.calls.submits.length, 0);
});

test('copied translated request is bounded and receipt capacity refuses before translation', async t => {
  const a = extension({ request: text => ({ member: 'research', text: text.repeat(100000) }) });
  const registry = createProviderRegistry([{ ...a.value, authority: { credentials: {},
    issue: () => ({ credential: null, expectedAuthority: 'remote-provider', assertAuthorized() {} }), async close() {} } }]);
  await registry.activate(); t.after(() => registry.close()); const [discovered] = await registry.discover();
  const target = { kind: 'provider', contributionId: discovered.contributionId, instance: discovered.instance, agent: discovered.agents[0],
    presentationVersion: 1, expectedAuthority: discovered.expectedAuthority };
  const f = hostFixture(t), host = f.open({ providers: registry });
  await host.createProviderConversation(hostScope, target, registry);
  assert.equal((await host.conversation(hostScope).submit(send(hostScope))).reason, 'command-too-large');
  assert.equal(a.calls.submits.length, 0); assert.deepEqual((await snapshot(host.conversation(hostScope))).document.receipts, {});
  const tiny = hostFixture(t), limited = tiny.open({ providers: registry, budgets: { snapshotBytes: 300 } });
  await limited.createProviderConversation(hostScope, target, registry);
  const count = a.calls.translations;
  assert.equal((await limited.conversation(hostScope).submit(send(hostScope))).reason, 'conversation-capacity');
  assert.equal(a.calls.translations, count); assert.equal(a.calls.submits.length, 0);
});

for (const kind of ['not-dispatched', 'unsupported', 'unavailable', 'authentication-failed', 'unauthorized', 'version-unsupported']) {
  test(`fresh resolved ${kind} records known nonacceptance and retry never invokes again`, async t => {
    const a = extension({ submit: () => ({ kind, reason: secret }) }), f = await fixture(t, [a]), scope = await create(f);
    const result = await f.client.conversation(scope).submit(send(scope));
    assert.deepEqual(result.receipt.state, { kind: 'not-dispatched', reason: `provider-${kind}` });
    assert.deepEqual(await f.client.conversation(scope).submit(send(scope)), result);
    assert.deepEqual(await f.client.reconcile(scope, 'send'), result.receipt);
    assert.equal(a.calls.translations, 1); assert.equal(a.calls.submits.length, 1); assert.equal(a.calls.reconciles.length, 0);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_CREATION/);
  });
}

test('authoritative rejection after acceptance retains the original run across restart', async t => {
  const a = extension({ reconcile: () => ({ kind: 'rejected', reason: secret, evidence: { denied: true } }) });
  const f = await fixture(t, [a]), scope = await create(f);
  await f.client.conversation(scope).submit(send(scope));
  const run = f.inspect(db => db.prepare('SELECT data FROM runs').get().data);
  const receipt = await f.client.reconcile(scope, 'send'); assert.equal(receipt.state.kind, 'rejected');
  assert.equal(f.inspect(db => db.prepare('SELECT data FROM runs').get().data), run);
  await f.restart([]);
  assert.deepEqual(await f.client.conversation(scope).receipt('send'), receipt);
  assert.deepEqual(await f.client.reconcile(scope, 'send'), receipt);
});

test('lookup while fresh submission is running cannot weaken its receipt, and shutdown drains that submission', async t => {
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  const a = extension({ async submit(operation, { effect }) { entered.resolve(); await release.promise; return effect(operation); },
    reconcile: () => ({ kind: 'unavailable', reason: 'pending' }) });
  const f = await fixture(t, [a]), scope = await create(f);
  const submitting = f.client.conversation(scope).submit(send(scope)); await entered.promise;
  assert.equal((await f.client.reconcile(scope, 'send')).state.kind, 'pending');
  let closed = false; const closing = f.running.close().then(() => { closed = true; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(closed, false);
  release.resolve(); assert.equal((await submitting).receipt.state.kind, 'uncertain'); await closing;
  const b = extension(); await f.restart([b]);
  assert.equal((await f.client.reconcile(scope, 'send')).state.kind, 'accepted');
  assert.deepEqual(b.calls.reconciles, a.calls.submits); assert.equal(b.calls.submits.length, 0);
});

for (const lookup of [false, true]) {
  test(`entered credential-backed ${lookup ? 'original lookup' : 'send'} defers replacement without retiring its owner`, { timeout: 10000 }, async t => {
    const entered = Promise.withResolvers(), release = Promise.withResolvers(), service = 'http://127.0.0.1:12345';
    const held = async (operation, { context, credential, effect }) => context.credentials.use({ credential, service }, async token => {
      assert.equal(token, secret); entered.resolve(); await release.promise; return effect(operation);
    });
    const a = extension({ submit: lookup ? () => { throw new Error('Reply lost'); } : held, ...(lookup ? { reconcile: held } : {}) });
    const next = entry(t, { label: 'replacement' }), f = await fixture(t, [a]), scope = await create(f);
    if (lookup) {
      assert.equal((await f.client.conversation(scope).submit(send(scope))).receipt.state.kind, 'uncertain');
      const unresolved = await create(f, 'unresolved');
      await f.client.conversation(unresolved).submit(send(unresolved));
    }
    const working = lookup ? f.client.reconcile(scope, 'send') : f.client.conversation(scope).submit(send(scope));
    try {
      await entered.promise;
      const targets = f.inspect(db => db.prepare('SELECT target FROM commands ORDER BY conversation').all());
      const credentials = f.inspect(db => db.prepare('SELECT handle,revoked FROM service_provider_credentials').all());
      assert.equal(f.running.extensionStatus().pending, 1);
      assert.deepEqual(await f.running.replaceProviderExtensions([next.value]), { kind: 'deferred', reason: 'active-work' });
      assert.equal(f.running.extensionStatus().pending, 1);
      assert.equal(next.calls.import, 0); assert.equal(a.calls.close + a.calls.dispose, 0);
      assert.equal(await a.context.credentials.use({ credential: a.credential, service }, async token => token), secret);
      assert.deepEqual(f.inspect(db => db.prepare('SELECT handle,revoked FROM service_provider_credentials').all()), credentials);
      assert.deepEqual(JSON.parse(targets[0].target).operation, a.calls.submits[0]);
      if (lookup) assert.deepEqual(a.calls.reconciles, [a.calls.submits[0]]);
      release.resolve();
      const result = await working;
      assert.equal((lookup ? result : result.receipt).state.kind, 'accepted');
      assert.equal(f.running.extensionStatus().pending, 0);
      assert.deepEqual(await f.running.replaceProviderExtensions([next.value]), { kind: 'replaced', generation: 2 });
      assert.equal(next.calls.import, 1); assert.equal(a.calls.close, 1); assert.equal(a.calls.dispose, 1);
      await assert.rejects(a.context.credentials.use({ credential: a.credential, service }, async () => assert.fail('retired credential')), /credential use refused/);
      if (lookup) {
        assert.equal((await f.client.reconcile(f.scope('unresolved'), 'send')).state.kind, 'uncertain');
        assert.equal(next.calls.commands, 0); assert.equal(a.calls.submits.length, 2); assert.equal(a.calls.reconciles.length, 1);
      }
      assert.deepEqual(f.inspect(db => db.prepare('SELECT target FROM commands ORDER BY conversation').all()), targets);
    } finally { release.resolve(); await working; }
  });
}

test('inactive owner refuses fresh sends and preserves lookup uncertainty without entering effects', async () => {
  const owner = createServerExtensions();
  for (const closing of [false, true]) {
    if (closing) await owner.close();
    assert.throws(() => owner.captureCommand(null, { kind: 'send', text: 'text' }, 'operation'), /Provider unavailable/);
    assert.deepEqual(await owner.executeCommand(null, true, () => assert.fail('inactive fresh effect')),
      { kind: 'not-dispatched', reason: 'provider-local-refusal' });
    assert.deepEqual(await owner.executeCommand(null, false, () => assert.fail('inactive lookup effect')), { kind: 'outcome-unknown' });
  }
});


function permissions(a, { read, revoke, reconcile } = {}) {
  const calls = { reads: [], revokes: [], reconciles: [] };
  const listing = binding => ({ kind: 'available', permissions: [{
    ref: { binding, ref: { kind: 'permission', instance: a.connected.instance, opaqueId: 'permission' } },
    scope: 'agent', actionLabel: 'Create work items', detail: 'Applies to all conversations for this agent',
  }] });
  const effect = { kind: 'confirmed', value: { kind: 'revoke-permission', state: 'completed' }, evidence: { revoked: true } };
  a.connected.permissions = {
    async read(binding) { calls.reads.push(structuredClone(binding)); return read ? read(binding, listing) : listing(binding); },
    async revoke(operation) {
      calls.revokes.push(structuredClone(operation));
      const observed = await this.read(operation.binding);
      if (observed.kind !== 'available' || !observed.permissions.some(row => row.ref.ref.opaqueId === operation.permission.ref.opaqueId && row.scope === operation.scope)) {
        return { kind: 'not-dispatched', reason: 'Permission or confirmed scope changed' };
      }
      return revoke ? revoke(operation, effect) : effect;
    },
    async reconcileRevoke(operation) { calls.reconciles.push(structuredClone(operation)); return reconcile ? reconcile(operation) : { kind: 'uncertain', reason: 'Original acknowledgement unavailable', evidence: null }; },
  };
  return calls;
}
const revoke = (scope, id = 'revoke', permissionScope = 'agent', permissionId = 'permission') => ({ version: 1, scope, clientCommandId: id,
  body: { kind: 'revoke-permission', permissionId, scope: permissionScope } });

test('permission read and authenticated durable revoke survive absent run and decision records', async t => {
  let f, writes = 0;
  const remote = createServer(async (request, response) => {
    assert.equal(request.headers.authorization, `Bearer ${secret}`);
    let body = ''; for await (const part of request) body += part;
    const operation = JSON.parse(body);
    const row = f.inspect(db => db.prepare("SELECT target,receipt FROM commands WHERE id='revoke'").get());
    const captured = JSON.parse(row.target);
    assert.deepEqual(captured.operation, { kind: 'revoke-permission', ...operation });
    assert.deepEqual(captured.credential, a.credential);
    assert.equal(JSON.parse(row.receipt).state.kind, 'pending');
    assert.equal(operation.scope, 'agent'); writes++;
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ kind: 'confirmed', value: { kind: 'revoke-permission', state: 'completed' }, evidence: { revoked: true } }));
  });
  await new Promise(resolve => remote.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => remote.close(resolve)));
  const service = `http://127.0.0.1:${remote.address().port}`, a = extension({ service });
  const calls = permissions(a, { revoke: operation => a.context.credentials.use({ credential: a.credential, service }, async token =>
    (await fetch(service, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: JSON.stringify(operation) })).json()) });
  let pending = true;
  a.connected.snapshot = async binding => {
    const ref = kind => ({ binding, ref: { kind, instance: a.connected.instance, opaqueId: `same-${kind}` } });
    return { kind: 'available', snapshot: { binding, cursor: { binding, kind: 'provider-cursor', opaque: { checkpoint: pending ? 'pending' : 'ended', stream: 1 } },
      projectionVersion: 1, state: { messages: [] }, decisions: pending ? [{ ref: ref('decision'), run: ref('run'), prompt: 'Continue?',
        choices: [{ ref: ref('choice'), label: 'Yes' }] }] : [] } };
  };
  a.connected.observe = () => ({ close() {}, ended: Promise.resolve({ kind: 'disconnected', cursor: null, reason: 'Run ended' }) });
  f = await fixture(t, [a]);
  const scope = await create(f);
  assert.equal(Object.keys((await snapshot(f.client.conversation(scope), transcriptProjection.version)).document.decisions).length, 1);
  pending = false;
  await f.client.providerObservation({ scope, action: 'retry' });
  assert.deepEqual((await snapshot(f.client.conversation(scope), transcriptProjection.version)).document.decisions, {});
  f.inspect(db => db.exec('DELETE FROM pending_decisions; DELETE FROM runs'));
  const original = f.inspect(db => JSON.parse(db.prepare('SELECT observation FROM provider_creations').get().observation).binding);
  const listing = await f.client.conversationPermissions(scope);
  assert.equal(listing.kind, 'available'); assert.equal(listing.permissions[0].scope, 'agent');
  assert.deepEqual(calls.reads, [original]);
  assert.doesNotMatch(JSON.stringify(listing), /opaqueHandle|PRIVATE_CREATION|same-session/);
  for (const [id, scopeName, permissionId] of [['wrong-scope', 'conversation', 'permission'], ['foreign', 'agent', 'foreign']]) {
    assert.equal((await f.client.conversation(scope).submit(revoke(scope, id, scopeName, permissionId))).receipt.state.kind, 'not-dispatched');
  }
  assert.equal(writes, 0);
  assert.equal((await f.client.conversation(scope).submit(revoke(scope))).receipt.state.kind, 'completed');
  assert.equal(writes, 1);
  assert.deepEqual(calls.revokes.at(-1).binding, original);
  assert.equal(f.inspect(db => db.prepare('SELECT COUNT(*) AS n FROM pending_decisions').get().n), 0);
  assert.equal(f.inspect(db => db.prepare('SELECT COUNT(*) AS n FROM runs').get().n), 0);
  assert.equal((await f.client.conversation(scope).submit(revoke(scope))).receipt.state.kind, 'completed');
  assert.equal(writes, 1);
});

test('lost revoke acknowledgement remains uncertain after empty read and restart without automatic replay', async t => {
  const a = extension(); permissions(a, { revoke() { throw new Error('Reply lost'); } });
  const f = await fixture(t, [a]), scope = await create(f), command = revoke(scope);
  const receipt = (await f.client.conversation(scope).submit(command)).receipt;
  assert.equal(receipt.state.kind, 'uncertain'); const saved = stored(f, 'chat');
  const b = extension(), calls = permissions(b, { read: () => ({ kind: 'available', permissions: [] }) });
  await f.restart([b]);
  assert.deepEqual(await f.client.conversation(scope).submit(command), { kind: 'receipt', receipt });
  assert.deepEqual((await f.client.conversationPermissions(scope)).permissions, []);
  assert.deepEqual(await f.client.reconcile(scope, 'revoke'), receipt);
  assert.equal(calls.revokes.length, 0);
  const operation = JSON.parse(saved.target).operation;
  const { kind: _kind, ...bound } = operation;
  assert.deepEqual(calls.reconciles, [bound]);
  assert.deepEqual(stored(f, 'chat'), saved);
});

test('original permission binding refuses replaced credentials or generation and unsupported/native providers before dispatch', async t => {
  const a = extension(); permissions(a, { revoke() { throw new Error('Reply lost'); } });
  const f = await fixture(t, [a]), scope = await create(f);
  const receipt = (await f.client.conversation(scope).submit(revoke(scope))).receipt;
  const target = stored(f, 'chat').target;
  for (const changed of [{ revision: '2' }, { generation: '2' }]) {
    const b = extension(changed), calls = permissions(b); await f.restart([b]);
    assert.equal((await f.client.conversationPermissions(scope)).kind, 'unavailable');
    assert.deepEqual(await f.client.reconcile(scope, 'revoke'), receipt);
    assert.equal((await f.client.conversation(scope).submit(revoke(scope, 'new'))).kind, 'rejected');
    assert.deepEqual(calls, { reads: [], revokes: [], reconciles: [] });
    assert.equal(stored(f, 'chat').target, target);
  }
  const b = extension(); await f.restart([b]);
  assert.equal((await f.client.conversationPermissions(scope)).kind, 'unsupported');
  assert.equal((await f.client.conversation(scope).submit(revoke(scope, 'unsupported'))).kind, 'rejected');
  assert.equal(b.calls.submits.length, 0);
  const native = f.scope('native'); await f.client.create(native, (await f.client.metadata()).defaultAgentId);
  assert.equal((await f.client.conversationPermissions(native)).kind, 'unsupported');
  assert.equal((await f.client.conversation(native).submit(revoke(native))).reason, 'permission-management-unsupported');
  assert.equal(f.inspect(db => db.prepare("SELECT COUNT(*) AS n FROM commands WHERE conversation='native'").get().n), 0);
  f.inspect(db => db.exec("DELETE FROM provider_creations WHERE conversation='chat'"));
  assert.equal((await f.client.conversationPermissions(scope)).kind, 'unavailable');
});

test('foreign permission references and authority revoked during a read never become an available listing', async t => {
  const a = extension(); let changed = false;
  permissions(a, { read(binding, listing) {
    const result = listing(binding);
    if (changed) f.inspect(db => db.exec('UPDATE service_provider_credentials SET revoked=1'));
    else result.permissions[0].ref.ref.instance = { ...a.connected.instance, protocolVersion: 'foreign' };
    return result;
  } });
  const f = await fixture(t, [a]), scope = await create(f);
  assert.equal((await f.client.conversationPermissions(scope)).kind, 'unavailable');
  changed = true;
  assert.equal((await f.client.conversationPermissions(scope)).kind, 'unavailable');
  await assert.rejects(f.client.conversationPermissions({ ...scope, hostId: 'foreign' }), error => error.kind === 'forbidden');
});


test('offered send binds the actual HTTP input to its authenticated original owner', async t => {
  let f, input;
  const remote = createServer(async (request, response) => {
    let body = ''; for await (const part of request) body += part;
    input = JSON.parse(body);
    assert.deepEqual(JSON.parse(stored(f, 'offered').target).operation.request, input);
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify(a.effect(a.calls.submits[0], 'completed', input.runId)));
  });
  await new Promise(resolve => remote.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => remote.close(resolve)));
  const a = extension({ agui: true, service: `http://127.0.0.1:${remote.address().port}`,
    request: text => ({ runId: 'actual-run', threadId: 'actual-thread', messages: [{ id: 'user', role: 'user', content: text }],
      tools: [{ name: 'server', description: 'Server tool', parameters: {} }], context: [], state: null, forwardedProps: { original: true }, custom: 'preserved' }),
    decode: value => value,
    submit: async operation => (await fetch(`http://127.0.0.1:${remote.address().port}`, { method: 'POST', body: JSON.stringify(operation.request) })).json(),
  });
  f = await fixture(t, [a]);
  assert.equal((await selected(f)).frontendOffers, 'ag-ui-capture-and-bind');
  const scope = await create(f, 'offered');
  const command = { version: 2, scope, clientCommandId: 'original', body: { kind: 'send', text: 'Hello', frontend: {
    platform: 'desktop', tools: [{ definition: { name: 'test__inspect', description: 'Inspect', parameters: { type: 'object' } }, activationId: 'activation-a' }],
  } } };
  const result = await f.client.conversation(scope).submit(command);
  assert.equal(result.kind, 'receipt');
  assert.equal(result.receipt.state.kind, 'completed');
  assert.deepEqual(input.tools, [{ name: 'server', description: 'Server tool', parameters: {} }, command.body.frontend.tools[0].definition]);
  assert.equal(input.state, null);
  assert.equal(input.custom, 'preserved');
  const bound = await f.client.frontendBinding({ scope, id: 'original', action: 'recover' });
  assert.equal(bound.kind, 'bound');
  assert.deepEqual(bound.command, command);
  assert.equal(bound.run.runId, input.runId);
  assert.equal(bound.threadId, input.threadId);
  assert.equal(bound.hostOperationId, result.receipt.hostOperationId);
  assert.equal(a.calls.translations, 1);
  for (const table of ['frontend_events', 'frontend_receipts']) assert.equal(f.inspect(db => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n), 0);
  await f.restart([a]);
  assert.deepEqual(await f.client.frontendBinding({ scope, id: 'original', action: 'recover' }), bound);
  assert.equal((await f.client.frontendBinding({ scope, id: 'original', action: 'unavailable' })).kind, 'unavailable');
  assert.equal((await f.client.frontendBinding({ scope, id: 'original', action: 'recover' })).kind, 'unavailable');
  assert.deepEqual((await f.client.conversation(scope).submit(command)).receipt, result.receipt);
  assert.equal(a.calls.translations, 1);
  assert.equal(a.calls.submits.length, 1);
});


test('offered owner identity fences admission, receipt, recovery, reconciliation and tombstones across paired principals', async t => {
  const a = aguiExtension(), f = await fixture(t, [a]), scope = await create(f), other = await f.anotherClient();
  const command = offered(scope);
  await other.frontendBinding({ scope, id: command.clientCommandId, action: 'unavailable' });
  assert.equal((await f.client.conversation(scope).submit(command)).receipt.state.kind, 'completed');
  for (const action of ['recover', 'unavailable']) await unavailable(other.frontendBinding({ scope, id: command.clientCommandId, action }));
  await unavailable(other.reconcile(scope, command.clientCommandId));
  await unavailable(other.conversation(scope).receipt(command.clientCommandId));
  assert.equal((await other.conversation(scope).submit(command)).kind, 'rejected');
  assert.equal((await f.client.frontendBinding({ scope, id: command.clientCommandId, action: 'recover' })).kind, 'bound');
  assert.equal(f.inspect(db => db.prepare("SELECT COUNT(*) AS n FROM frontend_send_owners WHERE state='available'").get().n), 1);
  const late = offered(scope, 'late');
  f.loseNext('frontend-binding');
  await assert.rejects(f.client.frontendBinding({ scope, id: late.clientCommandId, action: 'unavailable' }));
  assert.equal((await f.client.frontendBinding({ scope, id: late.clientCommandId, action: 'unavailable' })).kind, 'unavailable');
  assert.equal((await f.client.conversation(scope).submit(late)).kind, 'rejected');
  assert.equal(a.calls.translations, 1);
  assert.equal(a.calls.submits.length, 1);
});

test('offered recovery survives lost replies and registration crash gaps using only original durable bytes', async t => {
  const a = aguiExtension(), f = await fixture(t, [a]), scope = await create(f), command = offered(scope);
  f.loseNext('submit');
  await assert.rejects(f.client.conversation(scope).submit(command));
  assert.equal(f.inspect(db => db.prepare('SELECT COUNT(*) AS n FROM frontend_runs').get().n), 0);
  const original = stored(f, 'chat');
  await f.restart([a]);
  assert.equal(a.calls.reconciles.length, 0);
  assert.equal((await f.client.conversation(scope).submit(command)).receipt.state.kind, 'completed');
  f.loseNext('frontend-binding');
  await assert.rejects(f.client.frontendBinding({ scope, id: command.clientCommandId, action: 'recover' }));
  const bound = await f.client.frontendBinding({ scope, id: command.clientCommandId, action: 'recover' });
  assert.equal(bound.kind, 'bound');
  assert.deepEqual(stored(f, 'chat'), original);
  assert.equal(a.calls.translations, 1); assert.equal(a.calls.submits.length, 1);
  const coordinator = f.inspect(db => db.prepare('SELECT data FROM frontend_runs').get().data);
  f.inspect(db => db.exec("UPDATE frontend_send_owners SET state='unavailable'"));
  await f.restart([]);
  assert.deepEqual(await f.client.frontendBinding({ scope, id: command.clientCommandId, action: 'recover' }),
    { kind: 'unavailable', id: command.clientCommandId, reason: 'closures-unavailable' });
  assert.equal(f.inspect(db => db.prepare('SELECT data FROM frontend_runs').get().data), coordinator);
  assert.equal(f.inspect(db => db.prepare('SELECT state FROM frontend_send_owners').get().state), 'unavailable');
  assert.deepEqual(stored(f, 'chat'), original);
});

test('offered conflicts cannot alter original text, definitions, activations, ordering or platform', async t => {
  const a = aguiExtension(), f = await fixture(t, [a]), scope = await create(f), command = offered(scope);
  command.body.frontend.tools.push({ definition: { name: 'test__second', description: 'Second' }, activationId: 'second-a' });
  await f.client.conversation(scope).submit(command);
  const original = stored(f, 'chat');
  for (const change of [value => { value.body.text = 'Changed'; }, value => { value.body.frontend.tools[0].definition.description = 'Changed'; },
    value => { value.body.frontend.tools[0].activationId = 'replacement-b'; }, value => { value.body.frontend.tools.reverse(); },
    value => { value.body.frontend.platform = 'ios'; }]) {
    const changed = structuredClone(command); change(changed);
    assert.equal((await f.client.conversation(scope).submit(changed)).kind, 'rejected');
  }
  assert.deepEqual(stored(f, 'chat'), original);
  assert.equal(a.calls.translations, 1); assert.equal(a.calls.submits.length, 1);
});

test('offered delayed recovery cannot revive a released owner or return evidence to a revoked actor', async t => {
  for (const revoke of [false, true]) {
    const entered = Promise.withResolvers(), release = Promise.withResolvers();
    const a = aguiExtension({ submit: () => ({ kind: 'pending', evidence: {} }), reconcile: async (operation, { effect }) => {
      entered.resolve(); await release.promise; return effect(operation, 'completed', operation.request.runId);
    } });
    const f = await fixture(t, [a]), scope = await create(f), command = offered(scope);
    await f.client.conversation(scope).submit(command);
    const recovery = f.client.frontendBinding({ scope, id: command.clientCommandId, action: 'recover' });
    const observed = recovery.then(value => ({ value }), error => ({ error }));
    await entered.promise;
    if (revoke) f.inspect(db => db.exec('UPDATE service_devices SET revoked=1'));
    else await f.client.frontendBinding({ scope, id: command.clientCommandId, action: 'unavailable' });
    release.resolve();
    const result = await observed;
    if (revoke) assert.ok(result.error);
    else {
      assert.deepEqual(result.value, { kind: 'unavailable', id: command.clientCommandId, reason: 'closures-unavailable' });
      assert.equal(f.inspect(db => db.prepare('SELECT COUNT(*) AS n FROM frontend_runs').get().n), 0);
      assert.equal(f.inspect(db => db.prepare('SELECT state FROM frontend_send_owners').get().state), 'unavailable');
    }
    assert.equal(a.calls.submits.length, 1);
  }
});

for (const authority of ['actor', 'provider']) test(`offered ${authority} revocation after admission and during awaited connection prevents dispatch`, async t => {
  let f;
  const a = aguiExtension({ request(text) {
    queueMicrotask(() => f.inspect(db => db.exec(`UPDATE ${authority === 'actor' ? 'service_devices' : 'service_provider_credentials'} SET revoked=1`)));
    return actualInput(text);
  } });
  f = await fixture(t, [a]);
  const scope = await create(f), command = offered(scope);
  if (authority === 'actor') await assert.rejects(f.client.conversation(scope).submit(command));
  else assert.equal((await f.client.conversation(scope).submit(command)).receipt.state.kind, 'not-dispatched');
  assert.equal(a.calls.submits.length, 0);
  assert.equal(JSON.parse(stored(f, 'chat').receipt).state.kind, 'not-dispatched');
});

test('offered mismatched actual run confirmation never establishes a successful receipt, run or binding', async t => {
  const a = aguiExtension({ submit: (operation, { effect }) => effect(operation, 'completed', 'wrong-run'),
    reconcile: (operation, { effect }) => effect(operation, 'completed', 'wrong-run') });
  const f = await fixture(t, [a]), scope = await create(f), command = offered(scope);
  assert.equal((await f.client.conversation(scope).submit(command)).receipt.state.kind, 'uncertain');
  assert.equal((await f.client.frontendBinding({ scope, id: command.clientCommandId, action: 'recover' })).kind, 'pending');
  assert.equal(f.inspect(db => db.prepare('SELECT COUNT(*) AS n FROM runs').get().n), 0);
  assert.equal(f.inspect(db => db.prepare('SELECT COUNT(*) AS n FROM frontend_runs').get().n), 0);
  assert.deepEqual(JSON.parse(stored(f, 'chat').observation), { kind: 'outcome-unknown' });
});

for (const fault of ['generic', 'collision', 'duplicate', 'invalid-input', 'decoder-drift']) test(`offered ${fault} producer refuses before admission or effects`, async t => {
  const a = aguiExtension({ agui: fault !== 'generic', request(text) {
    const input = actualInput(text);
    if (fault === 'collision') input.tools = [{ name: 'test__inspect', description: 'Collision' }];
    if (fault === 'duplicate') input.tools = [{ name: 'server', description: 'One' }, { name: 'server', description: 'Two' }];
    if (fault === 'invalid-input') input.runId = '';
    return input;
  }, decode: value => fault === 'decoder-drift' ? { ...value, state: {} } : value });
  const f = await fixture(t, [a]), scope = await create(f);
  assert.equal((await f.client.conversation(scope).submit(offered(scope))).kind, 'rejected');
  assert.equal(f.inspect(db => db.prepare('SELECT COUNT(*) AS n FROM commands').get().n), 0);
  assert.equal(f.inspect(db => db.prepare('SELECT COUNT(*) AS n FROM frontend_send_owners').get().n), 0);
  assert.equal(a.calls.submits.length, 0);
});

test('offered reentrant provider decoding cannot revoke its actor after the final authority check', async t => {
  let f, admittedDecodes = 0;
  const a = aguiExtension({ decode(value) {
    if (f && f.inspect(db => db.prepare('SELECT 1 FROM commands').get()) && ++admittedDecodes === 1) {
      f.inspect(db => db.exec('UPDATE service_devices SET revoked=1'));
    }
    return value;
  } });
  f = await fixture(t, [a]);
  const scope = await create(f);
  await assert.rejects(f.client.conversation(scope).submit(offered(scope)));
  assert.equal(a.calls.submits.length, 0);
});


test('offered recovery rejects forged restored run evidence and ownerless commands', async t => {
  const a = aguiExtension(), f = await fixture(t, [a]), scope = await create(f), command = offered(scope);
  await f.client.conversation(scope).submit(command);
  const original = stored(f, 'chat').observation, forged = JSON.parse(original);
  forged.evidence.source.run.identity.runId = 'foreign-run';
  forged.evidence.source.run.reference.ref.opaqueId = 'foreign-run';
  forged.evidence.operation.id = canonicalJson(forged.evidence.source.run.reference);
  f.inspect(db => db.prepare('UPDATE commands SET observation=?').run(canonicalJson(forged)));
  await f.restart([a]);
  await unavailable(f.client.frontendBinding({ scope, id: command.clientCommandId, action: 'recover' }));
  assert.equal(f.inspect(db => db.prepare('SELECT COUNT(*) AS n FROM frontend_runs').get().n), 0);
  f.inspect(db => { db.prepare('UPDATE commands SET observation=?').run(original); db.exec('DELETE FROM frontend_send_owners'); });
  await unavailable(f.client.frontendBinding({ scope, id: command.clientCommandId, action: 'recover' }));
  assert.equal((await f.client.conversation(scope).submit(command)).kind, 'rejected');
  assert.equal(a.calls.submits.length, 1);
});

test('offered input preserves absent defaults and ownership admission rolls back with command persistence', async t => {
  const a = aguiExtension({ request(text) { const input = actualInput(text); delete input.context; delete input.tools; return input; } });
  const f = await fixture(t, [a]), scope = await create(f), command = offered(scope);
  f.inspect(db => db.exec("CREATE TRIGGER fail_owner BEFORE INSERT ON frontend_send_owners BEGIN SELECT RAISE(ABORT,'injected'); END"));
  await unavailable(f.client.conversation(scope).submit(command));
  for (const table of ['commands', 'frontend_send_owners', 'frontend_send_tombstones']) assert.equal(f.inspect(db => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n), 0);
  assert.equal(a.calls.submits.length, 0);
  f.inspect(db => db.exec('DROP TRIGGER fail_owner'));
  assert.equal((await f.client.conversation(scope).submit(command)).receipt.state.kind, 'completed');
  assert.equal(Object.hasOwn(a.calls.submits[0].request, 'context'), false);
  assert.equal(a.calls.submits[0].request.state, null);
  assert.deepEqual(a.calls.submits[0].request.tools, command.body.frontend.tools.map(tool => tool.definition));
});

test('offered commands require a fresh actor after host restart and keep old evidence private during blocker settlement', async t => {
  const a = aguiExtension({ request: text => ({ ...actualInput(text), runId: `run-${text}` }), submit: (operation, { effect }) => effect(operation, 'accepted', operation.request.runId) });
  const registry = createProviderRegistry([{ ...a.value, authority: { credentials: {},
    issue: () => ({ credential: null, expectedAuthority: 'remote-provider', assertAuthorized() {} }), async close() {} } }]);
  await registry.activate(); t.after(() => registry.close());
  const [discovered] = await registry.discover();
  const target = { kind: 'provider', contributionId: discovered.contributionId, instance: discovered.instance, agent: discovered.agents[0],
    presentationVersion: 1, expectedAuthority: discovered.expectedAuthority };
  const f = hostFixture(t), actor = { id: 'original-owner', platform: 'desktop', authorized: () => true };
  let host = f.open({ providers: registry });
  await host.createProviderConversation(hostScope, target, registry);
  const command = offered(hostScope);
  assert.equal((await host.conversation(hostScope).submit(command)).kind, 'rejected');
  await host.conversation(hostScope, actor).submit(command);
  host.close(); await host.drained; host = f.open({ providers: registry });
  await assert.rejects(host.reconcile(hostScope, command.clientCommandId), /frontend-owner/);
  const other = { ...actor, id: 'different-owner' };
  assert.equal((await host.conversation(hostScope).submit(send(hostScope, 'actorless'))).reason, 'send-awaiting-confirmation');
  assert.equal(a.calls.reconciles.length, 0);
  assert.equal((await host.conversation(hostScope, other).submit(send(hostScope, 'follow-up', 'Next'))).receipt.state.kind, 'accepted');
  await assert.rejects(host.reconcile(hostScope, command.clientCommandId, other), /frontend-owner/);
  await assert.rejects(host.conversation(hostScope, other).receipt(command.clientCommandId), /frontend-owner/);
  assert.equal((await host.frontendBinding({ scope: hostScope, id: command.clientCommandId, action: 'recover' }, actor, scope => frontendToolsFor(host).producer(scope))).kind, 'bound');
  assert.equal(a.calls.reconciles.length, 1);
});
