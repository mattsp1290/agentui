import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { FeedMismatchError, parseFeedItem } from '@agentui/contracts';
import { transcriptProjection, parseTranscript, parseCommandActivity, retainText } from '@agentui/contracts/conversation';
import { createCommandActivity } from '../../packages/host/dist/codex-command-activity.js';
import { fixture, installed, scope, other, command, empty, run, snapshot as readSnapshot } from './fixture.mjs';

const row = (overrides = {}) => ({ kind: 'command', activityId: 'activity', runId: 'run', revision: 1,
  command: 'printf hello', cwd: '/work', detailsTruncated: false, status: { kind: 'running' }, output: '', outputTruncated: false, ...overrides });
const update = activity => ({ kind: 'command-updated', activity });
const append = (host, events) => host.append(scope, { ...empty(), events });
const started = { kind: 'run-started', runId: 'run', previousRunId: null };
const ended = { kind: 'run-ended', runId: 'run', outcome: 'completed' };

test('command projection keeps ordered identity, revisions, terminal facts and optional legacy encoding', () => {
  const initial = transcriptProjection.initial();
  assert.equal(Object.hasOwn(initial, 'activities'), false);
  assert.deepEqual(parseTranscript({ messages: [] }), initial);
  let state = transcriptProjection.apply(initial, update(row()));
  assert.equal(transcriptProjection.apply(state, update(row())), state);
  assert.equal(transcriptProjection.apply(state, update(row({ revision: 0 }))), state);
  assert.throws(() => transcriptProjection.apply(state, update(row({ output: 'conflict' }))), /Conflicting/);
  state = transcriptProjection.apply(state, update(row({ revision: 2, status: { kind: 'failed', exitCode: null } })));
  assert.throws(() => transcriptProjection.apply(state, update(row({ revision: 3 }))), /Terminal/);
  assert.throws(() => transcriptProjection.apply(state, update(row({ revision: 3, command: 'changed' }))), /identity/);
  const next = transcriptProjection.apply(state, update(row({ revision: 3, status: { kind: 'failed', exitCode: null }, output: 'late' })));
  assert.equal(next.activities[0].output, 'late');
  assert.throws(() => parseCommandActivity(row({ status: { kind: 'running', exitCode: 0 } })));
  assert.throws(() => parseCommandActivity(row({ status: { kind: 'completed', exitCode: 2147483648 } })));
  assert.throws(() => parseTranscript({ ...initial, activities: [] }));
  for (const text of ['🙂'.repeat(3000), '\u0000"\\汉'.repeat(3000), '\ud800'.repeat(3000)]) {
    const retained = retainText(text, 8_000);
    assert.ok(retained.truncated);
    assert.ok(Buffer.byteLength(JSON.stringify(retained.text)) - 2 <= 8_000);
    assert.ok(text.startsWith(retained.text));
  }
});

test('private normalizer reconciles authority and rejects contradictions without changing published facts', () => {
  const events = [], stream = createCommandActivity('run', event => events.push(event));
  const full = (status, aggregatedOutput = null) => ({ item: { type: 'commandExecution', id: 'native', command: 'echo', cwd: '/', status, aggregatedOutput } });
  stream.observe('item/commandExecution/outputDelta', { itemId: 'native', delta: 'before' });
  stream.observe('item/started', full('inProgress'));
  stream.flush();
  assert.equal(events[0].activity.output, 'before');
  stream.observe('item/completed', full('completed', ''));
  stream.flush();
  stream.observe('item/commandExecution/outputDelta', { itemId: 'native', delta: 'ignored' });
  stream.observe('item/started', full('inProgress'));
  stream.flush();
  assert.equal(events.length, 2);
  assert.equal(events[1].activity.output, '');
  assert.throws(() => stream.observe('item/completed', full('failed')), /Contradictory/);
  assert.throws(() => stream.observe('item/completed', full('completed', 'different')), /Contradictory/);
  stream.flush();
  assert.equal(events.length, 2);
});

function tables(path) {
  const db = new DatabaseSync(path);
  try { return Object.fromEntries(['conversations', 'events', 'commands', 'runs', 'pending_decisions', 'host_limits']
    .map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all().map(row => ({ ...row }))])); }
  finally { db.close(); }
}
function legacy(path, corrupt = false) {
  const db = new DatabaseSync(path);
  try {
    db.prepare('UPDATE conversations SET version=1').run();
    if (corrupt) db.prepare("UPDATE conversations SET document='{}', bytes=2 WHERE conversation=?").run(other.conversationId);
  } finally { db.close(); }
}

const image = { imageId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', name: 'Screen.png', mediaType: 'image/png', byteLength: 4, width: 1, height: 1 };
const userText = { kind: 'message-updated', messageId: 'user', revision: 1, role: 'user', text: 'hi', complete: true };
const userImage = (overrides = {}) => ({ ...userText, text: '', image, ...overrides });

test('user messages carry image metadata and same-revision image changes conflict', () => {
  const state = transcriptProjection.apply(transcriptProjection.initial(), userImage());
  assert.deepEqual(state.messages, [{ messageId: 'user', revision: 1, role: 'user', text: '', complete: true, image }]);
  assert.deepEqual(parseTranscript(JSON.parse(JSON.stringify(state))), state);
  assert.equal(transcriptProjection.apply(state, userImage()), state);
  assert.throws(() => transcriptProjection.apply(state, userImage({ image: { ...image, name: 'Other.png' } })), /Conflicting/);
  assert.throws(() => transcriptProjection.apply(state, userImage({ image: undefined })), /Conflicting/);
  const plain = transcriptProjection.apply(transcriptProjection.initial(), userText);
  assert.equal(Object.hasOwn(plain.messages[0], 'image'), false);
  assert.throws(() => transcriptProjection.decodeEvent(userImage({ role: 'assistant' })), /Invalid transcript message/);
  assert.throws(() => transcriptProjection.decodeEvent(userImage({ image: { ...image, mediaType: 'image/gif' } })));
  assert.equal(transcriptProjection.version, 4);
});

test('V3 migration advances imageless rows only and refuses historical images unchanged', async t => {
  for (const variant of ['plain', 'snapshot', 'event']) {
    const f = fixture(t), host = f.open({ projection: transcriptProjection });
    host.createConversation(scope, installed);
    append(host, [variant === 'plain' ? userText : userImage()]);
    host.close(); await host.drained;
    const db = new DatabaseSync(f.path);
    db.prepare('UPDATE conversations SET version=3').run();
    if (variant === 'event') {
      const document = JSON.parse(db.prepare('SELECT document FROM conversations').get().document);
      delete document.domain.messages[0].image;
      const encoded = JSON.stringify(document);
      db.prepare('UPDATE conversations SET document=?, bytes=?').run(encoded, Buffer.byteLength(encoded));
    }
    db.close();
    const before = tables(f.path);
    if (variant === 'plain') {
      const reopened = f.open({ projection: transcriptProjection });
      assert.deepEqual(tables(f.path), { ...before, conversations: before.conversations.map(value => ({ ...value, version: 4 })) });
      reopened.close(); await reopened.drained;
    } else {
      assert.throws(() => f.open({ projection: transcriptProjection }), variant === 'snapshot' ? /historical image/ : /legacy transcript event/);
      assert.deepEqual(tables(f.path), before);
    }
  }
});

test('V1 migration updates only projection metadata and preserves canonical retries, old feeds refuse clearly', async t => {
  const f = fixture(t, { resolve: async () => ({ kind: 'completed', output: empty() }) });
  const host = f.open({ projection: transcriptProjection });
  host.createConversation(scope, installed);
  host.append(scope, { events: [started], runs: [run(scope, 'run')], decisions: [{
    visible: { pendingId: 'native-pending', runId: 'run', choices: ['accept'], prompt: 'Retained native decision' },
    continuation: { nativeRequestId: 42, opaque: 'private-native-continuation' },
  }] });
  const sent = command('same-id');
  const receipt = await host.conversation(scope).submit(sent);
  append(host, [{ kind: 'message-updated', messageId: 'text', revision: 1, role: 'assistant', text: 'Retained', complete: true }, ended]);
  host.close(); await host.drained;
  legacy(f.path);
  const before = tables(f.path);
  const reopened = f.open({ projection: transcriptProjection });
  const after = tables(f.path);
  assert.deepEqual(after, { ...before, conversations: before.conversations.map(value => ({ ...value, version: 4 })) });
  assert.deepEqual(await reopened.conversation(scope).submit(sent), receipt);
  const feed = reopened.conversation(scope).watch({ after: null, projectionVersion: 1 }, async () => assert.fail('Old feed delivered'));
  assert.match((await feed.ended).reason, /Update the app and host together/);
  await assert.rejects(readSnapshot(reopened.conversation(scope), 2), /Snapshot feed ended before delivery: refused/);
  const snapshot = reopened.inspect(scope).snapshot;
  assert.equal(Object.hasOwn(snapshot.document.domain, 'activities'), false);
  assert.throws(() => parseFeedItem({ kind: 'snapshot', snapshot }, { ...transcriptProjection, version: 1 }, scope), FeedMismatchError);
  assert.throws(() => parseFeedItem({ kind: 'snapshot', snapshot: { ...snapshot, projectionVersion: 1 } }, transcriptProjection, scope), /update the app and host together/);
  reopened.close(); await reopened.drained;
  const again = f.open({ projection: transcriptProjection });
  assert.deepEqual(tables(f.path), after);
  again.close(); await again.drained;
});

for (const corruption of ['domain', 'event', 'unsupported', 'current-v2-domain']) {
  test(`V1 migration rolls back every conversation on ${corruption} corruption`, async t => {
    const f = fixture(t), host = f.open({ projection: transcriptProjection });
    host.createConversation(scope, installed); host.createConversation(other, installed);
    append(host, [started]);
    host.close(); await host.drained;
    legacy(f.path, corruption === 'domain');
    const db = new DatabaseSync(f.path);
    if (corruption === 'current-v2-domain') db.prepare("UPDATE conversations SET version=2, document='{}', bytes=2 WHERE conversation=?").run(other.conversationId);
    if (corruption === 'event') db.prepare("UPDATE events SET payload='{}', bytes=2").run();
    if (corruption === 'unsupported') db.prepare('UPDATE conversations SET version=5 WHERE conversation=?').run(other.conversationId);
    db.close();
    const before = tables(f.path);
    assert.throws(() => f.open({ projection: transcriptProjection }));
    assert.deepEqual(tables(f.path), before);
  });
}

test('running command reserves output and terminal growth while commandless legacy snapshots have no reserve', async t => {
  const f = fixture(t), host = f.open({ projection: transcriptProjection, budgets: { snapshotBytes: 18_000 } });
  host.createConversation(scope, installed);
  append(host, [started, update(row())]);
  assert.throws(() => append(host, [{ kind: 'message-updated', messageId: 'too-big', revision: 1, role: 'assistant', text: 'x'.repeat(7000), complete: true }]), /snapshot budget/);
  append(host, [update(row({ revision: 2, output: 'x'.repeat(8000), status: { kind: 'completed', exitCode: -2147483648 } })), ended]);
  assert.equal(host.inspect(scope).snapshot.document.domain.activities[0].output.length, 8000);
  assert.equal(transcriptProjection.reserveBytes({ messages: [], currentRun: { kind: 'running', runId: 'old' } }), 0);
  host.close(); await host.drained;
});

test('near-limit legacy history migrates and opens without activity fields or new reserve bytes', async t => {
  const f = fixture(t), limits = { snapshotBytes: 18_000 }, host = f.open({ projection: transcriptProjection, budgets: limits });
  host.createConversation(scope, installed);
  append(host, [started, { kind: 'message-updated', messageId: 'large', revision: 1, role: 'assistant', text: 'x'.repeat(17500), complete: false }]);
  host.close(); await host.drained;
  legacy(f.path);
  const before = tables(f.path);
  const reopened = f.open({ projection: transcriptProjection, budgets: limits });
  assert.equal(reopened.inspect(scope).snapshot.document.domain.messages[0].text.length, 17500);
  assert.equal(tables(f.path).conversations[0].document, before.conversations[0].document);
  const feed = reopened.conversation(scope).watch({ after: null, projectionVersion: 4 }, async item => assert.ok(item.snapshot));
  feed.close(); await feed.ended;
});


test('failed V2 opening with incompatible budgets leaves the entire V1 database unchanged', async t => {
  const f = fixture(t), host = f.open({ projection: transcriptProjection });
  host.createConversation(scope, installed);
  append(host, [started]);
  host.close(); await host.drained;
  legacy(f.path);
  const before = tables(f.path);
  assert.throws(() => f.open({ projection: transcriptProjection, budgets: { snapshotBytes: 3_000_000 } }), /persistent host budgets/);
  assert.deepEqual(tables(f.path), before);
});


test('normalizer bounds metadata and pre-full deltas before buffering without deduplicating repeated text', () => {
  const events = [], stream = createCommandActivity('run', event => events.push(event));
  for (let index = 0; index < 10; index++) stream.observe('item/commandExecution/outputDelta', { itemId: 'id-' + index, delta: '🙂'.repeat(5000) });
  const full = id => ({ item: { type: 'commandExecution', id, command: '汉'.repeat(5000), cwd: '\u0000'.repeat(3000), status: 'inProgress' } });
  stream.observe('item/started', full('id-0'));
  stream.observe('item/started', full('id-9'));
  stream.observe('item/commandExecution/outputDelta', { itemId: 'id-9', delta: 'same' });
  stream.observe('item/commandExecution/outputDelta', { itemId: 'id-9', delta: 'same' });
  stream.flush();
  assert.equal(events[0].activity.outputTruncated, true);
  assert.equal(events[0].activity.detailsTruncated, true);
  assert.ok(Buffer.byteLength(JSON.stringify(events[0].activity.command)) - 2 <= 4000);
  assert.ok(Buffer.byteLength(JSON.stringify(events[0].activity.cwd)) - 2 <= 1000);
  assert.equal(events[1].activity.output, 'samesame');
});

for (const overflow of ['🙂', '\nfoo', '\u001b']) {
  test(`normalizer retains a true prefix after ${JSON.stringify(overflow)} crosses the byte boundary`, () => {
    const events = [], stream = createCommandActivity('run', event => events.push(event));
    const full = (status, aggregatedOutput = null) => ({ item: { type: 'commandExecution', id: 'native', command: 'echo', cwd: '/', status, aggregatedOutput } });
    const delta = text => stream.observe('item/commandExecution/outputDelta', { itemId: 'native', delta: text });
    stream.observe('item/started', full('inProgress'));
    const prefix = 'a'.repeat(7999);
    delta(prefix); delta(overflow); delta('x');
    stream.observe('item/completed', full('completed'));
    delta('late');
    stream.flush();
    assert.equal(events.at(-1).activity.output, prefix);
    assert.equal(events.at(-1).activity.outputTruncated, true);
    assert.ok((prefix + overflow + 'xlate').startsWith(events.at(-1).activity.output));
    stream.observe('item/completed', full('completed', 'Authoritative aggregate 🙂'));
    stream.flush();
    assert.equal(events.at(-1).activity.output, 'Authoritative aggregate 🙂');
    assert.equal(events.at(-1).activity.outputTruncated, false);
  });
}

test('early output cannot resume a truncated prefix after shared capacity is released or full metadata arrives', () => {
  const events = [], stream = createCommandActivity('run', event => events.push(event));
  const full = id => ({ item: { type: 'commandExecution', id, command: 'echo', cwd: '/', status: 'inProgress' } });
  const delta = (id, text) => stream.observe('item/commandExecution/outputDelta', { itemId: id, delta: text });
  delta('first', 'a'.repeat(8000));
  delta('second', 'b'.repeat(7000));
  const prefix = 'c'.repeat(999);
  delta('target', prefix); delta('target', '🙂');
  stream.observe('item/started', full('first'));
  delta('target', 'x');
  stream.observe('item/started', full('target'));
  delta('target', 'y');
  stream.flush();
  const target = events.find(event => event.activity.output.startsWith('c')).activity;
  assert.equal(target.output, prefix);
  assert.equal(target.outputTruncated, true);
});

test('failed V2 opening with malformed installation JSON leaves every raw V1 table unchanged', async t => {
  const f = fixture(t), host = f.open({ projection: transcriptProjection });
  host.createConversation(scope, installed); host.createConversation(other, installed);
  append(host, [started]);
  host.close(); await host.drained;
  legacy(f.path);
  const db = new DatabaseSync(f.path);
  db.prepare("UPDATE conversations SET installation='{' WHERE conversation=?").run(other.conversationId);
  db.close();
  const before = tables(f.path);
  assert.throws(() => f.open({ projection: transcriptProjection }), /Corrupt stored JSON/);
  assert.deepEqual(tables(f.path), before);
});

test('mixed V1 and V2 migration preserves raw command rows, journals and native records while V2 feeds refuse', async t => {
  const f = fixture(t), host = f.open({ projection: transcriptProjection });
  host.createConversation(scope, installed); host.createConversation(other, installed);
  host.append(scope, { events: [started, update(row()), ended], runs: [run(scope, 'run')], decisions: [] });
  host.close(); await host.drained;
  const db = new DatabaseSync(f.path);
  db.prepare('UPDATE conversations SET version=2 WHERE conversation=?').run(scope.conversationId);
  db.prepare('UPDATE conversations SET version=1 WHERE conversation=?').run(other.conversationId);
  db.close();
  const before = tables(f.path), reopened = f.open({ projection: transcriptProjection });
  assert.deepEqual(tables(f.path), { ...before, conversations: before.conversations.map(value => ({ ...value, version: 4 })) });
  const feed = reopened.conversation(scope).watch({ after: null, projectionVersion: 2 }, async () => assert.fail('Old feed delivered'));
  assert.match((await feed.ended).reason, /Update the app and host together/);
  assert.deepEqual(reopened.inspect(scope).snapshot.document.domain.activities, [row()]);
  reopened.close(); await reopened.drained;
});

for (const version of [1, 2]) {
  for (const stored of ['snapshot', 'event']) {
    test(`historical V${version} rejects file activity in its ${stored} and rolls back metadata`, async t => {
      const f = fixture(t), host = f.open({ projection: transcriptProjection });
      host.createConversation(scope, installed); host.createConversation(other, installed);
      append(host, [started, { kind: 'file-change-updated', activity: { kind: 'file-change', activityId: 'file', runId: 'run',
        revision: 1, status: { kind: 'unknown' }, changes: [], omittedChanges: 0 } }]);
      host.close(); await host.drained;
      const db = new DatabaseSync(f.path);
      db.prepare('UPDATE conversations SET version=?').run(version);
      if (stored === 'event') {
        const row = db.prepare('SELECT document FROM conversations WHERE conversation=?').get(scope.conversationId);
        const document = JSON.parse(row.document); delete document.domain.activities;
        const data = JSON.stringify(document);
        db.prepare('UPDATE conversations SET document=?,bytes=? WHERE conversation=?').run(data, Buffer.byteLength(data), scope.conversationId);
      }
      db.close();
      const before = tables(f.path);
      assert.throws(() => f.open({ projection: transcriptProjection }), /legacy|historical/);
      assert.deepEqual(tables(f.path), before);
    });
  }
}

for (const corruption of ['missing-event', 'native-floor', 'floor-ahead']) {
  test(`V2 migration rejects ${corruption} without advancing metadata`, async t => {
    const f = fixture(t), host = f.open({ projection: transcriptProjection });
    host.createConversation(scope, installed); append(host, [started, ended]);
    host.close(); await host.drained;
    const db = new DatabaseSync(f.path);
    db.prepare('UPDATE conversations SET version=2').run();
    db.prepare('DELETE FROM events WHERE sequence=1').run();
    if (corruption !== 'missing-event') db.prepare('INSERT INTO provider_checkpoints(host,conversation,original,data,floor) VALUES (?,?,?,?,?)')
      .run(scope.hostId, scope.conversationId, '{}', '{}', corruption === 'native-floor' ? 1 : 3);
    db.close();
    const before = tables(f.path);
    assert.throws(() => f.open({ projection: transcriptProjection }), /sequence|replay floor/);
    assert.deepEqual(tables(f.path), before);
  });
}
