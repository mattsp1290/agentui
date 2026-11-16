import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { transcriptProjection, parseFileChangeActivity, fileChangeDetailBytes, escapedBytes } from '@agentui/contracts/conversation';
import { createFileActivity } from '../../packages/host/dist/codex-file-activity.js';
import { fixture, installed, scope, empty } from './fixture.mjs';

const change = (diff = '-old\n+new', kind = { type: 'update', move_path: 'next.ts' }) => ({ path: 'original.ts', diff, kind });
const full = (status, changes = [change()]) => ({ item: { type: 'fileChange', id: 'native', status, changes } });
const row = (overrides = {}) => ({ kind: 'file-change', activityId: 'activity', runId: 'run', revision: 1,
  status: { kind: 'unknown' }, changes: [], omittedChanges: 0, ...overrides });
const update = activity => ({ kind: 'file-change-updated', activity });
const started = { kind: 'run-started', runId: 'run', previousRunId: null };
const ended = { kind: 'run-ended', runId: 'run', outcome: 'completed' };

function stream() {
  const events = [], normalizer = createFileActivity('run', event => events.push(event));
  return { events, observe(method, params) { normalizer.observe(method, params); normalizer.flush(); },
    patch(changes) { this.observe('item/fileChange/patchUpdated', { itemId: 'native', changes }); } };
}
test('patch-first file observations replace even with empty changes and freeze the first terminal payload', () => {
  const f = stream();
  f.patch([change()]);
  assert.equal(f.events[0].activity.status.kind, 'unknown');
  assert.equal(f.events[0].activity.activityId, createHash('sha256').update(JSON.stringify(['run', 'native'])).digest('hex'));
  f.patch([change()]);
  assert.equal(f.events.length, 1);
  f.patch([]);
  assert.deepEqual(f.events.at(-1).activity.changes, []);
  f.observe('item/started', full('inProgress'));
  f.patch([change('replacement')]);
  assert.equal(f.events.at(-1).activity.status.kind, 'running');
  assert.equal(f.events.at(-1).activity.changes[0].patch, 'replacement');
  f.observe('item/completed', full('completed', []));
  const terminal = f.events.at(-1);
  f.patch([change('stale')]);
  f.observe('item/started', full('inProgress'));
  f.observe('item/completed', full('completed', []));
  assert.equal(f.events.at(-1), terminal);
  assert.equal(f.events.length, 5);
  assert.throws(() => f.observe('item/completed', full('failed', [])), /Contradictory/);
  assert.throws(() => f.observe('item/completed', full('completed')), /Contradictory/);
  assert.equal(f.events.at(-1), terminal);
});

test('encoded file details include structure, escaped paths and patches within one shared budget', () => {
  const f = stream(), text = '\u0000"\\🙂汉\ud800'.repeat(4000);
  f.patch(Array.from({ length: 20 }, () => ({ path: text, diff: text, kind: { type: 'update', move_path: text } })));
  const activity = f.events[0].activity;
  assert.deepEqual(parseFileChangeActivity(activity), activity);
  assert.ok(fileChangeDetailBytes(activity) <= 16000);
  assert.ok(fileChangeDetailBytes(activity) > 15900);
  assert.equal(activity.omittedChanges, 19);
  assert.equal(activity.changes[0].patchTruncated, true);
  assert.equal(activity.changes[0].detailsTruncated, true);
  for (const path of [activity.changes[0].path, activity.changes[0].movedTo]) assert.ok(escapedBytes(path) <= 1000);
  assert.ok(text.startsWith(activity.changes[0].patch));
  assert.throws(() => parseFileChangeActivity({ ...activity, changes: [{ ...activity.changes[0], patch: text }] }), /budget/);
  f.patch(Array.from({ length: 17 }, () => change('', { type: 'add' })));
  assert.equal(f.events.at(-1).activity.changes.length, 16);
  assert.equal(f.events.at(-1).activity.omittedChanges, 1);
  assert.throws(() => parseFileChangeActivity(row({ changes: [{ path: '', patch: '', operation: 'delete', movedTo: null, detailsTruncated: false, patchTruncated: false }] })));
  assert.throws(() => f.observe('item/started', full('unknown')), /status/);
});

test('mixed activity revisions retain command encoding and reject identity reuse and terminal mutations', () => {
  const command = { kind: 'command', activityId: 'command', runId: 'run', revision: 1, command: 'echo hi', cwd: '/',
    detailsTruncated: false, status: { kind: 'running' }, output: '', outputTruncated: false };
  let state = transcriptProjection.apply(transcriptProjection.initial(), { kind: 'command-updated', activity: command });
  state = transcriptProjection.apply(state, update(row()));
  assert.deepEqual(state.activities, [command, row()]);
  assert.equal(transcriptProjection.apply(state, update(row())), state);
  assert.throws(() => transcriptProjection.apply(state, update(row({ runId: 'other', revision: 0 }))), /identity/);
  assert.throws(() => transcriptProjection.apply(state, update(row({ activityId: 'command' }))), /identity/);
  assert.throws(() => transcriptProjection.apply(state, update(row({ omittedChanges: 1 }))), /Conflicting/);
  const terminal = row({ revision: 2, status: { kind: 'declined' } });
  state = transcriptProjection.apply(state, update(terminal));
  assert.throws(() => transcriptProjection.apply(state, update({ ...terminal, revision: 3, omittedChanges: 1 })), /Terminal/);
  assert.deepEqual(state.activities[0], command);
});

test('unknown files reserve exact remaining detail growth and terminal metadata alongside commands', async t => {
  const f = fixture(t), host = f.open({ projection: transcriptProjection, budgets: { snapshotBytes: 34_000 } });
  const command = { kind: 'command', activityId: 'command', runId: 'run', revision: 1, command: 'echo', cwd: '/',
    detailsTruncated: false, status: { kind: 'running' }, output: '', outputTruncated: false };
  host.createConversation(scope, installed);
  const append = events => host.append(scope, { ...empty(), events });
  append([started, { kind: 'command-updated', activity: command }, update(row())]);
  const domain = () => host.inspect(scope).snapshot.document.domain;
  assert.equal(transcriptProjection.reserveBytes(domain()), 256 + 16000 - fileChangeDetailBytes(row()) + 256 + 8000 + 4000 - 4 + 1000 - 1 + 256);
  assert.throws(() => append([{ kind: 'message-updated', messageId: 'fill', revision: 1, role: 'assistant', text: 'x'.repeat(8000), complete: true }]), /snapshot budget/);
  const normalized = stream();
  normalized.observe('item/completed', full('failed', [change('x'.repeat(20000))]));
  const final = { ...normalized.events[0].activity, activityId: 'activity', revision: 2 };
  append([update(final), { kind: 'command-updated', activity: { ...command, revision: 2, output: 'x'.repeat(8000), status: { kind: 'completed', exitCode: 0 } } }, ended]);
  assert.equal(transcriptProjection.reserveBytes(domain()), 0);
  assert.deepEqual(domain().activities[1], final);
  const saved = domain();
  host.close(); await host.drained;
  const reopened = f.open({ projection: transcriptProjection, budgets: { snapshotBytes: 34_000 } });
  assert.deepEqual(reopened.inspect(scope).snapshot.document.domain, saved);
  reopened.close(); await reopened.drained;
});
