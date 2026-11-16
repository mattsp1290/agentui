import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { canonicalJson, HOST_DEFAULT_SNAPSHOT_BYTES } from '@agentui/contracts';
import { transcriptProjection } from '@agentui/contracts/conversation';
import { openLocalHost } from '@agentui/host';
import { recoverProviderConversations, PROVIDER_RECOVERY } from '../../apps/host/build/tsc/provider-recovery.js';

const scope = { hostId: 'restart-host', conversationId: 'conversation' };
const installation = { installationId: 'codex-local-v1', binding: {
  engine: 'codex', nativeVersion: 'fixture', account: 'local', authorizedScope: '/fixture/workspace',
  nativeFormat: 'codex-app-server-v2',
} };
const empty = () => ({ events: [], runs: [], decisions: [] });
const command = (id, body = { kind: 'send', text: 'Continue' }, conversation = scope) =>
  ({ version: 1, scope: conversation, clientCommandId: id, body });
const message = (messageId, text, complete = false) =>
  ({ kind: 'message-updated', messageId, revision: 1, role: 'assistant', text, complete });

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'agentui-codex-recovery-'));
  const path = join(directory, 'host.sqlite'), hosts = [], dispatches = [];
  const driver = {
    source: 'recorded', installation, capability: () => ({ kind: 'supported' }),
    async dispatch(cmd, target) {
      dispatches.push(structuredClone({ command: cmd, target }));
      if (cmd.body.kind === 'approve') return { kind: 'outcome-unknown' };
      return { kind: 'conclusive', evidence: {
        identity: target.identity, source: 'native-acknowledgement',
        nativeOperation: { namespace: 'deterministic-test-provider', id: target.identity.hostOperationId },
        observation: { namespace: 'deterministic-test-provider', schemaVersion: 1, data: null },
      }, result: { kind: 'completed', output: empty() } };
    },
  };
  const open = () => {
    const host = openLocalHost({ path, projection: transcriptProjection, driver, authorize: () => true });
    hosts.push(host);
    return host;
  };
  const readPrivate = () => {
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      return { commands: db.prepare('SELECT * FROM commands ORDER BY id').all(),
        runs: db.prepare('SELECT * FROM runs ORDER BY id').all() };
    } finally { db.close(); }
  };
  t.after(async () => {
    for (const host of hosts) host.close();
    await Promise.all(hosts.map(host => host.drained));
    rmSync(directory, { recursive: true, force: true });
  });
  return { path, open, dispatches, readPrivate };
}

for (const answered of [false, true]) {
  test(`restart closes partial output and ${answered ? 'answered' : 'unanswered'} stale approvals without claiming a native outcome`, async t => {
    const f = fixture(t), original = f.open();
    original.createConversation(scope, installation);
    const sent = await original.conversation(scope).submit(command('old-send'));
    assert.equal(sent.receipt.state.kind, 'completed');
    const text = `Preserve this exact partial response.\n${'x'.repeat(63_000)}`;
    const run = { identity: { conversation: scope, runId: 'old-run', authority: {
      kind: 'agentui-host', hostId: scope.hostId, binding: { namespace: 'codex-app-server',
        installationId: installation.installationId, opaqueSessionId: 'private-thread-binding' },
    } }, reference: { kind: 'session', formatVersion: 1, binding: installation.binding, opaque: 'private-thread-binding' } };
    original.append(scope, { events: [message('partial', text)], runs: [run], decisions: [{
      visible: { pendingId: 'old-approval', runId: 'old-run', choices: ['yes', 'no'], prompt: 'Run this action?' },
      continuation: { privateRequest: 42 },
    }] });
    const approval = command('old-answer', { kind: 'approve', pendingId: 'old-approval', choiceId: 'yes' });
    const uncertain = answered ? await original.conversation(scope).submit(approval) : null;
    if (uncertain) assert.equal(uncertain.receipt.state.kind, 'uncertain');
    const before = original.inspect(scope).snapshot;
    original.close();
    await original.drained;
    const privateBefore = f.readPrivate(), dispatchCount = f.dispatches.length;
    const reopened = f.open();
    recoverProviderConversations(reopened, scope.hostId, installation, PROVIDER_RECOVERY.codex);
    const recovered = reopened.inspect(scope).snapshot;
    assert.deepEqual(recovered.document.domain.messages[0], {
      messageId: 'partial', revision: 2, role: 'assistant', text, complete: true,
    });
    assert.equal(recovered.document.domain.messages.length, 2);
    const notice = recovered.document.domain.messages[1];
    assert.equal(notice.complete, true);
    assert.equal(notice.role, 'assistant');
    assert.match(notice.text, /connection was interrupted/);
    assert.match(notice.text, /Check any unconfirmed actions before retrying/);
    assert.deepEqual(recovered.document.decisions, {});
    assert.deepEqual(recovered.document.receipts, before.document.receipts);
    assert.deepEqual(f.readPrivate(), privateBefore);
    assert.doesNotMatch(canonicalJson(recovered), /private-thread-binding|privateRequest/);
    assert.equal(f.dispatches.length, dispatchCount);
    recoverProviderConversations(reopened, scope.hostId, installation, PROVIDER_RECOVERY.codex);
    assert.deepEqual(reopened.inspect(scope).snapshot, recovered);
    if (uncertain) assert.deepEqual(await reopened.conversation(scope).submit(approval), uncertain);
    assert.deepEqual(await reopened.conversation(scope).submit({ ...approval, clientCommandId: 'new-answer' }),
      { kind: 'rejected', reason: 'decision-unavailable' });
    assert.deepEqual(await reopened.conversation(scope).submit(command('old-send')), sent);
    assert.equal(f.dispatches.length, dispatchCount);
    const next = await reopened.conversation(scope).submit(command('new-send'));
    assert.equal(next.receipt.state.kind, 'completed');
    assert.equal(f.dispatches.length, dispatchCount + 1);
    assert.equal(f.dispatches.at(-1).command.clientCommandId, 'new-send');
    assert.deepEqual(f.dispatches.at(-1).target.run, run);
    assert.equal((await reopened.conversation(scope).receipt('old-send')).state.kind, 'completed');
    if (uncertain) assert.deepEqual(await reopened.conversation(scope).receipt('old-answer'), uncertain.receipt);
  });
}

test('restart pages all conversations and preserves histories with a different workspace or provider binding', async t => {
  const f = fixture(t), original = f.open(), foreign = [];
  for (let index = 0; index < 101; index++) {
    const conversation = { ...scope, conversationId: `page-${String(index).padStart(3, '0')}` };
    original.createConversation(conversation, installation);
    if (index === 100) original.append(conversation, { ...empty(), events: [message('last-page', 'Still streaming')] });
  }
  for (const [name, binding] of [
    ['workspace', { ...installation.binding, authorizedScope: '/other/workspace' }],
    ['provider', { ...installation.binding, engine: 'another-provider' }],
  ]) {
    const conversation = { ...scope, conversationId: `foreign-${name}` };
    original.createConversation(conversation, { ...installation, binding });
    original.append(conversation, { ...empty(), events: [message('foreign-partial', 'Do not change this')] });
    foreign.push({ conversation, before: original.inspect(conversation) });
  }
  original.close();
  await original.drained;
  const reopened = f.open();
  recoverProviderConversations(reopened, scope.hostId, installation, PROVIDER_RECOVERY.codex);
  const last = reopened.inspect({ ...scope, conversationId: 'page-100' }).snapshot.document.domain.messages;
  assert.equal(last[0].complete, true);
  assert.equal(last.length, 2);
  for (const { conversation, before } of foreign) assert.deepEqual(reopened.inspect(conversation), before);
  assert.deepEqual(f.dispatches, []);
});

for (const activeRun of [false, true]) {
  test(`a full default snapshot ${activeRun ? 'with an active run ' : ''}still finishes the old stream and allows startup without a notice`, async t => {
    const f = fixture(t), original = f.open();
    original.createConversation(scope, installation);
    if (activeRun) original.append(scope, { ...empty(), events: [
      { kind: 'run-started', runId: 'full-run', previousRunId: null },
    ] });
    const fresh = { ...scope, conversationId: 'fresh' };
    original.createConversation(fresh, installation);
    original.append(fresh, { ...empty(), events: [message('other-partial', 'Recover this conversation too')] });
    for (let index = 0; index < 63; index++) {
      original.append(scope, { ...empty(), events: [message(`complete-${index}`, 'x'.repeat(63_000), true)] });
    }
    const before = original.inspect(scope).snapshot;
    const last = { messageId: 'partial', revision: 1, role: 'assistant', text: '', complete: false };
    const withLast = { ...before, cursor: Number.MAX_SAFE_INTEGER, document: { ...before.document,
      domain: { ...before.document.domain, messages: [...before.document.domain.messages, last] } } };
    last.text = 'x'.repeat(HOST_DEFAULT_SNAPSHOT_BYTES - Buffer.byteLength(canonicalJson(withLast)) - 10);
    original.append(scope, { ...empty(), events: [{ kind: 'message-updated', ...last }] });
    original.close();
    await original.drained;
    const reopened = f.open(), warnings = [];
    t.mock.method(process, 'emitWarning', (warning, options) => { warnings.push({ warning, options }); });
    assert.doesNotThrow(() => recoverProviderConversations(reopened, scope.hostId, installation, PROVIDER_RECOVERY.codex));
    const recovered = reopened.inspect(scope).snapshot;
    assert.deepEqual(recovered.document.domain.messages.at(-1), { ...last, revision: 2, complete: true });
    assert.equal(recovered.document.domain.messages.length, 64);
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].options.code, 'AGENTUI_CODEX_RECOVERY_CAPACITY');
    assert.deepEqual(recovered.document.domain.currentRun, activeRun ? { kind: 'running', runId: 'full-run' } : null);
    const other = reopened.inspect(fresh).snapshot.document.domain.messages;
    assert.equal(other[0].complete, true);
    assert.match(other[1].text, /connection was interrupted/);
    recoverProviderConversations(reopened, scope.hostId, installation, PROVIDER_RECOVERY.codex);
    assert.equal(warnings.length, activeRun ? 2 : 1);
    assert.equal((await reopened.conversation(fresh).submit(command('fresh-send', undefined, fresh))).receipt.state.kind, 'completed');
  });
}

test('restart propagates corrupt stored transcript errors', async t => {
  const f = fixture(t), original = f.open();
  original.createConversation(scope, installation);
  original.close();
  await original.drained;
  const db = new DatabaseSync(f.path);
  try {
    db.prepare('UPDATE conversations SET document=?').run(JSON.stringify({
      domain: { messages: [{ invalid: true }] }, receipts: {}, decisions: {},
    }));
  } finally { db.close(); }
  const reopened = f.open();
  assert.throws(() => recoverProviderConversations(reopened, scope.hostId, installation, PROVIDER_RECOVERY.codex), /Invalid|Expected|Unexpected|Missing/);
});

for (const kind of ['running', 'stopping']) {
  test(`restart ends a ${kind} run before any response text`, async t => {
    const f = fixture(t), original = f.open();
    original.createConversation(scope, installation);
    const runId = 'silent-run';
    original.append(scope, { ...empty(), events: [
      { kind: 'run-started', runId, previousRunId: null },
      ...(kind === 'stopping' ? [{ kind: 'run-stop-requested', runId, clientCommandId: 'old-stop' }] : []),
    ] });
    original.close();
    await original.drained;
    const reopened = f.open();
    recoverProviderConversations(reopened, scope.hostId, installation, PROVIDER_RECOVERY.codex);
    const recovered = reopened.inspect(scope).snapshot;
    assert.deepEqual(recovered.document.domain.currentRun, { kind: 'ended', runId, outcome: 'connection-lost' });
    assert.match(recovered.document.domain.messages[0].text, /connection was interrupted/);
    recoverProviderConversations(reopened, scope.hostId, installation, PROVIDER_RECOVERY.codex);
    assert.deepEqual(reopened.inspect(scope).snapshot, recovered);
    assert.deepEqual(f.dispatches, []);
  });
}

test('restart accepts an existing message-only SQLite snapshot at projection version one', async t => {
  const f = fixture(t), original = f.open();
  original.createConversation(scope, installation);
  original.close();
  await original.drained;
  const db = new DatabaseSync(f.path);
  try {
    const document = JSON.stringify({
      domain: { messages: [{ messageId: 'legacy', revision: 1, role: 'assistant', text: 'Old partial', complete: false }] },
      receipts: {}, decisions: {},
    });
    db.prepare('UPDATE conversations SET version=1, document=?, bytes=?').run(document, Buffer.byteLength(document));
  } finally { db.close(); }
  const reopened = f.open();
  recoverProviderConversations(reopened, scope.hostId, installation, PROVIDER_RECOVERY.codex);
  const recovered = reopened.inspect(scope).snapshot;
  assert.equal(recovered.projectionVersion, transcriptProjection.version);
  assert.equal(recovered.document.domain.currentRun, null);
  assert.deepEqual(recovered.document.domain.messages[0], {
    messageId: 'legacy', revision: 2, role: 'assistant', text: 'Old partial', complete: true,
  });
});

test('Pi restart seals its unfinished response and names the provider without suggesting tool actions', async t => {
  const f = fixture(t), original = f.open();
  const piInstallation = { installationId: 'pi-chat-v1', binding: { ...installation.binding,
    engine: 'pi', nativeVersion: '1.5.2', nativeFormat: 'pi-sdk-chat-opencode-go-glm-5.3-v1' } };
  original.createConversation(scope, piInstallation);
  original.append(scope, { ...empty(), events: [
    { kind: 'run-started', runId: 'pi-run', previousRunId: null },
    message('partial-pi', 'Keep this streamed text'),
  ] });
  original.close();
  await original.drained;
  const reopened = f.open();
  recoverProviderConversations(reopened, scope.hostId, piInstallation, PROVIDER_RECOVERY.pi);
  const recovered = reopened.inspect(scope).snapshot;
  assert.deepEqual(recovered.document.domain.currentRun, { kind: 'ended', runId: 'pi-run', outcome: 'connection-lost' });
  assert.equal(recovered.document.domain.messages[0].complete, true);
  assert.equal(recovered.document.domain.messages[0].text, 'Keep this streamed text');
  assert.match(recovered.document.domain.messages[1].text, /The Pi connection was interrupted/);
  assert.doesNotMatch(recovered.document.domain.messages[1].text, /Codex|actions/);
  recoverProviderConversations(reopened, scope.hostId, piInstallation, PROVIDER_RECOVERY.pi);
  assert.deepEqual(reopened.inspect(scope).snapshot, recovered);
});
