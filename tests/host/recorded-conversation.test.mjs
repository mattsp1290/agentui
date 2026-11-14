import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { canonicalJson, DEFAULT_MAX_COMMAND_BYTES, foldDocument } from '@agentui/contracts';
import { parseTranscript, parseTranscriptEvent, transcriptProjection } from '@agentui/contracts/conversation';
import { createConversationStore } from '@agentui/client';
import { openRecordedHost, recordedInstallation } from '@agentui/host/recorded';

const scope = { hostId: 'recorded-host', conversationId: 'recorded-conversation' };
const command = (id, body = { kind: 'send', text: 'Please start the recorded run.' }) =>
  ({ version: 1, scope, clientCommandId: id, body });
const event = (revision, text, complete = false, role = 'assistant') =>
  ({ kind: 'message-updated', messageId: 'message-a', revision, text, complete, role });
async function until(predicate) {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Recorded conversation milestone timed out');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}
function harness(t, progressMs = 15) {
  const directory = mkdtempSync(join(tmpdir(), 'agentui-recorded-app-'));
  const options = { path: join(directory, 'host.sqlite'), backendPath: join(directory, 'recorded.jsonl'),
    hostId: scope.hostId, progressMs };
  const hosts = [], clients = [], feeds = [];
  t.after(() => {
    for (const client of clients) client.disconnect();
    for (const feed of feeds) feed.close();
    for (const host of hosts) host.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const open = () => { const host = openRecordedHost(options); hosts.push(host); return host; };
  const entries = () => existsSync(options.backendPath) ? readFileSync(options.backendPath, 'utf8').trim().split('\n').map(JSON.parse) : [];
  const watch = host => {
    const history = [], events = [];
    let document;
    const feed = host.conversation(scope).watch({ after: null, projectionVersion: 1 }, async item => {
      if (item.kind === 'snapshot') document = item.snapshot.document;
      else for (const envelope of item.events) {
        document = foldDocument(document, envelope.event, transcriptProjection);
        events.push(envelope);
        history.push(structuredClone(document));
      }
    });
    feeds.push(feed);
    return { history, events, get document() { return document; } };
  };
  const client = (host, name) => {
    let serial = 0, saved = null;
    const store = createConversationStore({ scope, port: host.conversation(scope), projection: transcriptProjection,
      createCommandId: () => `${name}-${++serial}`,
      drafts: { async load() { return saved; }, async save(value) { saved = structuredClone(value); } } });
    clients.push(store);
    return store;
  };
  return { options, open, entries, watch, client };
}

test('transcript decoding preserves order and rejects identity changes and conflicting revisions', () => {
  const first = transcriptProjection.apply(transcriptProjection.initial(), event(1, 'Started'));
  const before = structuredClone(first);
  const second = transcriptProjection.apply(first, { ...event(1, 'User text', true, 'user'), messageId: 'message-b' });
  const final = transcriptProjection.apply(second, event(3, 'Finished', true));
  assert.deepEqual(first, before);
  assert.deepEqual(final.messages.map(item => item.messageId), ['message-a', 'message-b']);
  assert.equal(transcriptProjection.apply(final, event(2, 'Delayed')), final);
  assert.equal(transcriptProjection.apply(final, event(3, 'Finished', true)), final);
  assert.throws(() => transcriptProjection.apply(final, event(3, 'Conflict', true)), /Conflicting/);
  assert.throws(() => transcriptProjection.apply(final, event(4, 'Reopened')), /Completed/);
  assert.throws(() => transcriptProjection.apply(final, event(1, 'Role changed', false, 'user')), /role/);
  assert.deepEqual(parseTranscript(final), final);
  assert.deepEqual(parseTranscriptEvent(event(1, 'Started')), event(1, 'Started'));
  assert.throws(() => parseTranscript({ messages: [...final.messages, final.messages[0]] }), /Duplicate/);
  for (const malformed of [{ ...event(0, 'Bad') }, { ...event(1, 'Bad'), revision: 1.5 },
    { ...event(1, 'Bad'), role: 'system' }, { ...event(1, 'Bad'), complete: 'yes' },
    { ...event(1, 'Bad'), messageId: '' }, { ...event(1, 'Bad'), extra: true }]) {
    assert.throws(() => parseTranscriptEvent(malformed));
  }
});

test('recorded host commits progressive messages and two clients admit one decision winner', { timeout: 10_000 }, async t => {
  const f = harness(t), host = f.open();
  host.createConversation(scope, recordedInstallation);
  const observed = f.watch(host), alice = f.client(host, 'alice'), bob = f.client(host, 'bob');
  await Promise.all([alice.connect(), bob.connect()]);
  await until(() => observed.document && [alice, bob].every(client => client.getSnapshot().connection.kind === 'connected'));
  await alice.setDraft('Please start the recorded run.');
  const submitting = alice.send();
  await until(() => observed.history.some(item => item.domain.messages.some(message => message.revision === 1 && message.role === 'assistant')));
  assert.equal(f.entries().length, 1);
  const accepted = f.entries()[0];
  assert.equal(accepted.kind, 'conclusive');
  const sent = await submitting;
  assert.equal(sent.receipt.state.kind, 'completed');
  await until(() => [alice, bob].every(client => Object.keys(client.getSnapshot().document.decisions).length === 1));
  const assistantUpdates = observed.events.filter(item => item.event.kind === 'domain' && item.event.event.role === 'assistant');
  assert.deepEqual(assistantUpdates.map(item => item.event.event.revision), [1, 2, 3]);
  assert.ok(assistantUpdates[0].sequence < assistantUpdates[1].sequence);
  assert.ok(assistantUpdates[1].sequence < assistantUpdates[2].sequence);
  assert.deepEqual(observed.document.domain.messages.map(message => message.role), ['user', 'assistant']);
  assert.equal(observed.document.domain.messages[0].text, 'Please start the recorded run.');
  assert.ok(observed.document.domain.messages.every(message => message.complete));
  const pending = Object.values(alice.getSnapshot().document.decisions)[0];
  const winning = alice.approve(pending.pendingId, 'approve');
  const losing = await bob.approve(pending.pendingId, 'decline');
  assert.deepEqual(losing, { kind: 'rejected', reason: 'decision-unavailable' });
  assert.equal((await winning).receipt.state.kind, 'completed');
  await until(() => [alice, bob].every(client => client.getSnapshot().document.domain.messages.length === 3 &&
    Object.keys(client.getSnapshot().document.decisions).length === 0));
  assert.deepEqual(alice.getSnapshot().document, bob.getSnapshot().document);
  assert.match(alice.getSnapshot().document.domain.messages[2].text, new RegExp(pending.runId));
  assert.equal(f.entries().length, 2);
  const cancel = await host.conversation(scope).submit(command('cancel', { kind: 'cancel', runId: pending.runId }));
  assert.deepEqual(cancel, { kind: 'rejected', reason: 'recorded-cancel-unavailable' });
  assert.equal(f.entries().length, 2);
  alice.disconnect(); bob.disconnect(); host.close();
  const reopened = f.open(), restored = f.watch(reopened);
  await until(() => restored.document);
  assert.deepEqual(restored.document, alice.getSnapshot().document);
});

test('reconciliation overtakes delayed progress without regressing completion or repeating acceptance', async t => {
  const f = harness(t, 70), host = f.open();
  host.createConversation(scope, recordedInstallation);
  const observed = f.watch(host), port = host.conversation(scope), intent = command('reconcile-race');
  await until(() => observed.document);
  const submitting = port.submit(intent);
  await until(() => f.entries().length === 1);
  assert.equal((await host.reconcile(scope, intent.clientCommandId)).state.kind, 'completed');
  await until(() => observed.document.domain.messages.some(message => message.role === 'assistant' && message.complete));
  const completed = structuredClone(observed.document.domain);
  assert.equal((await submitting).receipt.state.kind, 'completed');
  await until(() => observed.events.filter(item => item.event.kind === 'domain' && item.event.event.role === 'assistant').length === 3);
  for (const document of observed.history.filter(item => item.domain.messages.some(message => message.role === 'assistant' && message.complete))) {
    assert.deepEqual(document.domain, completed);
  }
  assert.deepEqual(observed.document.domain, completed);
  assert.equal((await port.submit(intent)).receipt.state.kind, 'completed');
  assert.equal(f.entries().length, 1);
});

test('a recorded send at the command byte limit is refused before admission or backend acceptance', async t => {
  const f = harness(t, 0), host = f.open();
  host.createConversation(scope, recordedInstallation);
  const intent = command('00000000-0000-0000-0000-000000000000', { kind: 'send', text: '' });
  intent.body.text = 'x'.repeat(DEFAULT_MAX_COMMAND_BYTES - Buffer.byteLength(canonicalJson(intent)));
  assert.equal(Buffer.byteLength(canonicalJson(intent)), DEFAULT_MAX_COMMAND_BYTES);
  const port = host.conversation(scope);
  assert.deepEqual(await port.submit(intent), { kind: 'rejected', reason: 'message-too-large' });
  assert.equal(await port.receipt(intent.clientCommandId), null);
  assert.deepEqual(f.entries(), []);
});

for (const [label, unit] of [['ASCII', 'x'], ['multibyte', '🙂'], ['escaped', '\0"\\']]) {
  test(`the largest recorded ${label} user event completes and one extra byte is refused`, async t => {
    const f = harness(t, 0), host = f.open();
    host.createConversation(scope, recordedInstallation);
    const envelope = { scope, sequence: Number.MAX_SAFE_INTEGER, event: { kind: 'domain', event: {
      kind: 'message-updated', messageId: '00000000-0000-0000-0000-000000000000:user', revision: 1,
      role: 'user', text: '', complete: true,
    } } };
    const room = 64_000 - Buffer.byteLength(canonicalJson(envelope));
    const unitBytes = Buffer.byteLength(canonicalJson(unit)) - 2;
    const text = unit.repeat(Math.floor(room / unitBytes)) + 'x'.repeat(room % unitBytes);
    envelope.event.event.text = text;
    assert.equal(Buffer.byteLength(canonicalJson(envelope)), 64_000);
    const port = host.conversation(scope), oversized = command('too-large', { kind: 'send', text: text + 'x' });
    assert.deepEqual(await port.submit(oversized), { kind: 'rejected', reason: 'message-too-large' });
    assert.equal(await port.receipt(oversized.clientCommandId), null);
    assert.deepEqual(f.entries(), []);
    const intent = command('largest-fitting', { kind: 'send', text });
    const result = await port.submit(intent);
    assert.equal(result.kind, 'receipt');
    assert.equal(result.receipt.state.kind, 'completed');
    assert.equal((await port.receipt(intent.clientCommandId)).state.kind, 'completed');
    assert.equal(f.entries().length, 1);
    const observed = f.watch(host);
    await until(() => observed.document);
    assert.equal(observed.document.domain.messages[0].text, text);
  });
}

test('a killed recorded process recovers final evidence with the original command ID', { timeout: 10_000 }, async t => {
  const f = harness(t);
  const source = `import { openRecordedHost, recordedInstallation } from '@agentui/host/recorded';
    const host = openRecordedHost(${JSON.stringify({ ...f.options, progressMs: 60_000 })});
    host.createConversation(${JSON.stringify(scope)}, recordedInstallation);
    await host.conversation(${JSON.stringify(scope)}).submit(${JSON.stringify(command('crash'))});`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', source], { cwd: process.cwd(), stdio: 'pipe' });
  let error = '';
  child.stderr.on('data', chunk => { error += chunk; });
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  await until(() => { if (child.exitCode !== null) throw new Error(error); return f.entries().length === 1; });
  const exited = once(child, 'exit');
  child.kill('SIGKILL');
  await exited;
  const reopened = f.open(), port = reopened.conversation(scope);
  assert.equal((await port.receipt('crash')).state.kind, 'pending');
  assert.equal((await reopened.reconcile(scope, 'crash')).state.kind, 'completed');
  const observed = f.watch(reopened);
  await until(() => observed.document);
  assert.deepEqual(observed.document.domain.messages.map(message => [message.role, message.complete]), [['user', true], ['assistant', true]]);
  assert.equal(Object.keys(observed.document.decisions).length, 1);
  assert.equal((await port.submit(command('crash'))).receipt.state.kind, 'completed');
  assert.equal(f.entries().length, 1);
});
