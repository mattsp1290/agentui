import assert from 'node:assert/strict';
import test from 'node:test';
import { canonicalJson } from '@agentui/contracts';
import { frontendToolsFor } from '@agentui/host/frontend-tools';
import { observationFixture, actor, scope, events, command } from './provider-observations-fixture.mjs';
import { until } from '../host/fixture.mjs';
const bytes = value => Buffer.byteLength(canonicalJson(value));
const revision = f => JSON.parse(f.dump().provider_checkpoints[0].data).revision;
const original = (f, operation) => ({ operationId: operation.operationId, threadId: operation.request.threadId,
  run: { binding: f.binding, ref: { kind: 'run', instance: f.provider.presentation.instance, opaqueId: operation.request.runId } } });
function capacityEvents(operation) {
  const list = [events(operation)[0]];
  for (let index = 0; index < 16; index++) list.push({ type: 'TOOL_CALL_START', toolCallId: `call-${index}`, toolCallName: 'test__inspect' },
    { type: 'TOOL_CALL_ARGS', toolCallId: `call-${index}`, delta: '"' + 'x'.repeat(61998) + '"' });
  return list;
}
async function append(f, operation, list, first = 1) {
  for (let index = 0; index < list.length; index += 4) assert.equal(await f.emit([f.batch(operation, list.slice(index, index + 4), first + index)]), true);
}
for (const mode of ['complete', 'unavailable', 'explicit-excluded']) test(`129 originals have bounded ${mode} coverage and sticky exclusion`, async t => {
  let supplied = [], f;
  f = await observationFixture(t, { configure(provider) { provider.mappings.snapshot = (_state, originals) => {
    supplied = originals;
    const result = originals.map(value => ({ ...value, kind: mode === 'unavailable' ? 'unavailable' : 'complete', ...(mode === 'unavailable' ? {} : { events: [] }) }));
    if (mode === 'explicit-excluded' && f?.submissions.length === 129 && originals.length === 128) {
      const excluded = f.submissions.find(operation => !originals.some(value => value.operationId === operation.operationId));
      if (excluded) result[0] = { ...original(f, excluded), kind: 'complete', events: [] };
    }
    return result;
  }; } });
  for (let i = 0; i < 129; i++) await f.submit(`send-${String(i).padStart(3, '0')}`);
  const before = revision(f); assert.equal((await f.resnapshot()).kind, 'observing');
  assert.equal(supplied.length, 128); assert.equal(revision(f), before + 1);
  const faults = f.dump().frontend_observation_runs.filter(row => row.fault);
  assert.equal(faults.length, mode === 'unavailable' ? 129 : mode === 'explicit-excluded' ? 2 : 1);
  assert(faults.every(row => row.fault === 'history-unavailable'));
  assert(faults.some(row => row.command_id === 'send-128'));
  assert.equal((await f.resnapshot()).kind, 'observing');
  assert.equal(f.dump().frontend_observation_runs.filter(row => row.fault).length, faults.length);
});

test('closed ID pages cover mixed terminal and sticky rows across the 128 boundary', async t => {
  let supplied;
  const f = await observationFixture(t, { configure(provider) { provider.mappings.snapshot = (_state, originals) => {
    supplied = originals; return originals.map(value => ({ ...value, kind: 'complete', events: [] }));
  }; } });
  for (let i = 0; i < 131; i++) await f.submit(`send-${String(i).padStart(3, '0')}`);
  await f.emit([f.batch(f.submissions[0])]);
  await f.emit([f.batch(f.submissions[1], [events(f.submissions[1])[0]], 2)]);
  assert.equal((await f.resnapshot()).kind, 'observing'); assert.equal(supplied.length, 128);
  assert.equal(f.inspect(f.submissions[0]).status, 'ready');
  assert.equal(f.inspect(f.submissions[1]).status, 'blocked');
  assert.equal(f.inspect(f.submissions[130]).status, 'blocked');
  assert.deepEqual(f.dump().frontend_observation_runs.filter(row => row.fault).map(row => row.command_id).sort(), ['send-001', 'send-130']);
});

for (const mode of ['zero-fit', 'later-small', 'all-unavailable']) test(`public large-binding selection obeys bytes for ${mode}`, async t => {
  let supplied;
  const f = await observationFixture(t, { sessionId: 's'.repeat(mode === 'all-unavailable' ? 50000 : 122000), budgets: { maxCommandBytes: 256000 }, configure(provider) {
    provider.mappings.snapshot = (_state, originals) => { supplied = originals; return originals.map(value => ({ ...value, kind: 'unavailable' })); };
  } });
  const largeId = '\0'.repeat(1024);
  await f.submit(largeId);
  if (mode === 'later-small') await f.submit('small');
  if (mode === 'all-unavailable') for (let i = 0; i < 4; i++) await f.submit(`small-${i}`);
  const before = revision(f); assert.equal((await f.resnapshot()).kind, 'observing'); assert.equal(revision(f), before + 1);
  assert.equal(supplied.length, mode === 'zero-fit' ? 0 : mode === 'later-small' ? 1 : 2);
  if (mode === 'later-small') assert.equal(supplied[0].operationId, f.submissions[1].operationId);
  assert(bytes(supplied.map(value => ({ ...value, kind: 'unavailable' }))) <= 128000);
  assert.equal(f.dump().frontend_observation_runs.filter(row => row.fault).length, f.submissions.length);
});

test('all compact markers fit with 128 maximally escaped command IDs', async t => {
  let f;
  f = await observationFixture(t, { configure(provider) { provider.mappings.snapshot = () => (f?.submissions ?? []).map(operation => ({ ...original(f, operation), kind: 'unavailable' })); } });
  for (let i = 0; i < 128; i++) await f.submit(String.fromCharCode(i % 32).repeat(1020) + String(i).padStart(4, '0'));
  const before = revision(f); assert.equal((await f.resnapshot()).kind, 'observing'); assert.equal(revision(f), before + 1);
  assert.equal(f.dump().frontend_observation_runs.filter(row => row.fault).length, 128);
});

for (const change of ['new-129th', 'excluded-command', 'terminal']) test(`complete fingerprint rejects callback change to ${change}`, async t => {
  let f, armed = false, mutation;
  f = await observationFixture(t, { configure(provider) { provider.mappings.snapshot = (_state, originals) => {
    const result = originals.map(value => ({ ...value, kind: 'complete', events: [] }));
    if (armed) {
      armed = false;
      if (change === 'new-129th') mutation = f.submit('send-128');
      else if (change === 'excluded-command') f.database(db => {
        const row = db.prepare("SELECT intent FROM commands WHERE id='send-128'").get(), value = JSON.parse(row.intent);
        value.body.text = 'Changed outside callback membership'; db.prepare("UPDATE commands SET intent=? WHERE id='send-128'").run(canonicalJson(value));
      });
      else { const op = f.submissions[0], producer = frontendToolsFor(f.host).producer(scope); producer.observe({ threadId: op.request.threadId, runId: op.request.runId }, 2, events(op).at(-1)); }
    }
    return result;
  }; } });
  const total = change === 'excluded-command' ? 129 : change === 'new-129th' ? 128 : 1;
  for (let i = 0; i < total; i++) await f.submit(`send-${String(i).padStart(3, '0')}`);
  if (change === 'terminal') await append(f, f.submissions[0], [events(f.submissions[0])[0]]);
  const before = f.dump(); armed = true; assert.equal((await f.resnapshot()).kind, 'stopped'); await mutation;
  assert.deepEqual(f.dump().provider_checkpoints, before.provider_checkpoints);
  assert.deepEqual(f.dump().frontend_observation_events, before.frontend_observation_events);
});

for (const bad of ['outer-getter', 'outer-sparse', 'header-getter', 'frame-getter', 'frame-sparse', 'late-invalid', 'late-json', 'duplicate', 'foreign', '129-results']) test(`snapshot ${bad} rejects even after capacity loss`, async t => {
  const f = await observationFixture(t); await f.submit(); const before = f.dump(); let getters = 0;
  f.provider.mappings.snapshot = (_state, originals) => {
    const frames = Array.from({ length: 17 }, () => ({ type: 'RAW', event: 'x'.repeat(63000) }));
    const entry = { ...originals[0], kind: 'complete', events: frames }, result = [entry];
    if (bad === 'outer-getter') Object.defineProperty(result, '0', { get() { getters++; return entry; } });
    if (bad === 'outer-sparse') delete result[0];
    if (bad === 'header-getter') Object.defineProperty(entry, 'events', { get() { getters++; return frames; } });
    if (bad === 'frame-getter') Object.defineProperty(frames, '16', { get() { getters++; return { type: 'RAW', event: '' }; } });
    if (bad === 'frame-sparse') delete frames[16];
    if (bad === 'late-invalid') frames.push({ type: 'NOT_AN_EVENT' });
    if (bad === 'late-json') frames.push({ type: 'RAW', event: undefined });
    if (bad === 'duplicate') result.push(entry);
    if (bad === 'foreign') entry.threadId = 'foreign';
    if (bad === '129-results') result.push(...Array(128).fill(entry));
    return result;
  };
  assert.equal((await f.resnapshot()).kind, 'stopped'); assert.deepEqual(f.dump(), before); assert.equal(getters, 0);
});

test('two 504258-byte histories keep the first complete history and advance snapshot', async t => {
  let retained = [];
  const f = await observationFixture(t, { configure(provider) { provider.mappings.snapshot = (_state, originals) => originals.map((value, index) => ({ ...value, kind: 'complete', events: retained[index] ?? [] })); } });
  await f.submit('first'); await f.submit('second');
  retained = f.submissions.map(operation => [events(operation)[0], ...Array.from({ length: 8 }, () => ({ type: 'RAW', event: 'x'.repeat(63000) }))]);
  assert.deepEqual(retained.map(list => list.reduce((sum, value) => sum + bytes(value), 0)), [504258, 504258]);
  for (let i = 0; i < 2; i++) await append(f, f.submissions[i], retained[i]);
  const before = revision(f); assert.equal((await f.resnapshot()).kind, 'observing'); assert.equal(revision(f), before + 1);
  assert.deepEqual(f.submissions.map(operation => f.inspect(operation).status), ['collecting', 'blocked']);
});

for (const target of [990000, 999800]) test(`near-million history ${target} commits a canonical resnapshot`, async t => {
  let retained = [];
  const f = await observationFixture(t, { configure(provider) { provider.mappings.snapshot = (_state, originals) => originals.map(value => ({ ...value, kind: 'complete', events: retained })); } });
  await f.submit(); retained = [events(f.submissions[0])[0]];
  while (bytes(retained) < target) { const room = target - bytes(retained); if (room < 30) break; retained.push({ type: 'RAW', event: 'x'.repeat(Math.max(0, Math.min(62000, room - 27))) }); }
  await append(f, f.submissions[0], retained);
  const before = revision(f); assert.equal((await f.resnapshot()).kind, 'observing'); assert.equal(revision(f), before + 1);
  assert.equal(f.inspect().status, target === 990000 ? 'collecting' : 'blocked');
});

for (const stage of ['confirmed', 'held', 'pending-reopen']) test(`10305-byte accepted command faults capacity during ${stage} with raw history intact`, async t => {
  const f = await observationFixture(t, { held: stage === 'held', outcome: stage === 'pending-reopen' ? 'pending' : 'confirmed' });
  const input = command(); input.body.frontend.tools[0].definition.description = 'd'.repeat(10000); assert.equal(bytes(input), 10305);
  const submitted = f.host.conversation(scope, actor).submit(input); await until(() => f.submissions.length === 1);
  if (stage !== 'held') await submitted;
  const op = f.submissions[0], history = capacityEvents(op); assert.equal(history.length, 33);
  const before = revision(f);
  if (stage === 'confirmed') for (const [index, event] of history.entries()) assert.equal(await f.emit([f.batch(op, [event], index + 1)]), true);
  else await append(f, op, history);
  assert.equal(revision(f), before + (stage === 'confirmed' ? 33 : 9));
  if (stage === 'confirmed') assert.equal(f.dump().provider_event_ids.length, 33);
  if (stage === 'held') { assert.equal(f.dump().frontend_runs.length, 0); f.release(); await submitted; }
  if (stage === 'pending-reopen') { await f.restart(); f.release('confirmed'); await f.host.reconcile(scope, 'send', actor); }
  assert.equal(f.inspect(op).status, 'faulted');
  assert.equal(f.dump().frontend_observation_events.length, 33);
  assert.equal((await f.host.conversation(scope, actor).receipt('send')).state.kind, 'completed');
  assert.equal(f.dump().frontend_events.length, 32); assert.equal(JSON.parse(f.dump().frontend_runs[0].data).cursor, 32);
});

for (const failure of ['event', 'run', 'run-update', 'receipt', 'capacity-fault', 'settlement', 'settlement-capacity']) test(`${failure} SQL failure rolls back and exact retry commits once`, async t => {
  const held = failure.startsWith('settlement'), f = await observationFixture(t, { held });
  const input = command(); if (failure === 'capacity-fault' || failure === 'settlement-capacity') input.body.frontend.tools[0].definition.description = 'd'.repeat(10000);
  const submission = f.host.conversation(scope, actor).submit(input); await until(() => f.submissions.length === 1); if (!held) await submission;
  const op = f.submissions[0]; let list = events(op), position = 1;
  if (failure === 'receipt') list[2].delta = '{';
  if (failure === 'run-update') { await append(f, op, [list[0]]); list = list.slice(1); position = 2; }
  if (failure === 'settlement-capacity') list = capacityEvents(op);
  if (failure === 'capacity-fault') { const history = capacityEvents(op); await append(f, op, history.slice(0, 32)); list = history.slice(32); position = 33; }
  if (held) await append(f, op, list);
  const before = f.dump();
  const table = failure === 'receipt' ? 'frontend_receipts' : failure === 'run' || failure === 'run-update' || failure === 'capacity-fault' || failure === 'settlement-capacity' ? 'frontend_runs' : 'frontend_events';
  const operation = failure === 'capacity-fault' || failure === 'run-update' || failure === 'settlement-capacity' ? 'UPDATE' : 'INSERT';
  const when = failure === 'settlement-capacity' ? "WHEN json_extract(NEW.data,'$.status')='faulted'" : '';
  f.database(db => db.exec(`CREATE TRIGGER fail_capacity BEFORE ${operation} ON ${table} ${when} BEGIN SELECT RAISE(ABORT,'bounded SQL failure'); END`));
  if (held) { f.release(); await assert.rejects(submission, /bounded SQL failure/); }
  else assert.equal(await f.emit([f.batch(op, list, position)], 'exact-retry'), false);
  assert.deepEqual(f.dump(), before);
  f.database(db => db.exec('DROP TRIGGER fail_capacity'));
  if (held) await f.host.reconcile(scope, 'send', actor);
  else { await f.restart(); assert.equal(await f.emit([f.batch(op, list, position)], 'exact-retry'), true); }
  assert.equal(f.inspect(op).status, failure === 'capacity-fault' || failure === 'settlement-capacity' ? 'faulted' : 'ready');
  if (!held) assert.equal(f.dump().provider_event_ids.filter(row => row.id === 'exact-retry').length, 1);
});

for (const excess of [0, 1]) test(`prepared snapshot exact million-byte boundary plus ${excess}`, async t => {
  const f = await observationFixture(t); await f.submit();
  let history;
  f.provider.mappings.snapshot = (_state, originals) => {
    const member = { commandId: 'send', commandDigest: '0'.repeat(64) };
    history = [events(f.submissions[0])[0], ...Array.from({ length: 16 }, () => ({ type: 'RAW', event: 'x'.repeat(60000) })), { type: 'RAW', event: '' }];
    const envelope = () => ({ kind: 'snapshot', fingerprint: '0'.repeat(64), supplied: [member], runs: [{ ...member, kind: 'events', first: 1,
      frames: history.map(input => ({ encoded: canonicalJson(input), bytes: bytes(input) })) }] });
    let padding = 1_000_000 + excess - bytes(envelope());
    history.at(-1).event = 'x'.repeat(padding);
    padding += 1_000_000 + excess - bytes(envelope()); history.at(-1).event = 'x'.repeat(padding);
    assert.equal(bytes(envelope()), 1_000_000 + excess);
    assert(history.every(input => bytes(input) <= 64000));
    return [{ ...originals[0], kind: 'complete', events: history }];
  };
  const before = revision(f); assert.equal((await f.resnapshot()).kind, 'observing'); assert.equal(revision(f), before + 1);
  assert.equal(f.inspect().status, excess ? 'blocked' : 'collecting');
  assert.equal(f.dump().frontend_observation_events.length, excess ? 0 : history.length);
});

test('oversized first history releases its frames so a later small history fits', async t => {
  const f = await observationFixture(t); await f.submit('first'); await f.submit('second');
  f.provider.mappings.snapshot = (_state, originals) => originals.map((value, index) => ({ ...value, kind: 'complete', events: index
    ? [events(f.submissions[1])[0]] : Array.from({ length: 17 }, () => ({ type: 'RAW', event: 'x'.repeat(63000) })) }));
  assert.equal((await f.resnapshot()).kind, 'observing');
  assert.deepEqual(f.submissions.map(op => f.inspect(op).status), ['blocked', 'collecting']);
  assert.equal(f.dump().frontend_observation_events.length, 1);
});

for (const damage of ['foreign', 'unknown']) test(`legacy ${damage} evidence rejects while same-original progress succeeds`, async t => {
  const f = await observationFixture(t, { enabled: false }); await f.submit(); await f.restart(true);
  assert.equal(await f.emit([f.batch()], 'legacy-valid'), true);
  assert.equal(f.dump().frontend_observation_runs.length, 0);
  const invalid = f.batch(), before = f.dump();
  if (damage === 'foreign') invalid.threadId = 'foreign'; else invalid.operationId = 'unknown';
  assert.equal(await f.emit([invalid], 'legacy-invalid'), false); assert.deepEqual(f.dump(), before);
});

test('a non-send original remains invalid observation evidence after strict correlation', async t => {
  const f = await observationFixture(t, { configure(provider) {
    provider.connected.capabilities.cancel = { kind: 'supported' };
    const submit = provider.connected.submit;
    provider.connected.submit = value => value.kind === 'cancel'
      ? Promise.resolve({ kind: 'confirmed', value: { kind: 'cancel', state: 'completed' }, evidence: null }) : submit(value);
  } });
  await f.submit();
  const receipt = await f.host.conversation(scope, actor).submit({ version: 1, scope, clientCommandId: 'cancel', body: { kind: 'cancel', runId: f.submissions[0].request.runId } });
  assert.equal(receipt.kind, 'receipt');
  const operationId = f.database(db => db.prepare("SELECT operation FROM commands WHERE id='cancel'").get().operation);
  const invalid = { ...f.batch(), operationId }, before = f.dump();
  assert.equal(await f.emit([invalid]), false); assert.deepEqual(f.dump(), before);
});

test('a captured generic untagged send cannot acquire observation history after mapper installation', async t => {
  let generic = true;
  const f = await observationFixture(t, { configure(provider) {
    if (generic) provider.activate = context => { context.providers.add('fixture', provider.backend, provider.presentation); return { dispose() {} }; };
  } });
  assert.equal((await f.host.conversation(scope, actor).submit({ version: 1, scope, clientCommandId: 'generic', body: { kind: 'send', text: 'Observe' } })).kind, 'receipt');
  generic = false; await f.restart();
  const before = f.dump(); assert.equal(await f.emit([f.batch()]), false); assert.deepEqual(f.dump(), before);
});

for (const overflow of ['frame-size', 'frame-count']) test(`snapshot ${overflow} becomes unavailable without losing canonical progress`, async t => {
  const f = await observationFixture(t); await f.submit();
  f.provider.mappings.snapshot = (_state, originals) => originals.map(value => ({ ...value, kind: 'complete', events: overflow === 'frame-size'
    ? [{ type: 'RAW', event: 'x'.repeat(64000) }] : Array.from({ length: 4097 }, () => ({ type: 'RAW', event: '' })) }));
  const before = revision(f); assert.equal((await f.resnapshot()).kind, 'observing'); assert.equal(revision(f), before + 1);
  assert.equal(f.inspect().status, 'blocked'); assert.equal(f.dump().frontend_observation_events.length, 0);
});

for (const excess of [0, 1]) test(`joint descriptor and membership admission at 128000 bytes plus ${excess}`, async t => {
  const probe = await observationFixture(t, { sessionId: 's' }); await probe.submit();
  const member = { commandId: 'send', commandDigest: '0'.repeat(64) };
  const base = bytes([{ ...original(probe, probe.submissions[0]), kind: 'unavailable' }]) + bytes([member]);
  let supplied;
  const f = await observationFixture(t, { sessionId: 's'.repeat(128000 + excess - base + 1), budgets: { maxCommandBytes: 256000 }, configure(provider) {
    provider.mappings.snapshot = (_state, originals) => { supplied = originals; return originals.map(value => ({ ...value, kind: 'unavailable' })); };
  } });
  await f.submit();
  assert.equal(bytes([{ ...original(f, f.submissions[0]), kind: 'unavailable' }]) + bytes([member]), 128000 + excess);
  assert.equal((await f.resnapshot()).kind, 'observing'); assert.equal(supplied.length, excess ? 0 : 1);
  assert.equal(f.inspect().status, 'blocked');
});

test('an opted-in send without an offered frontend remains opaque after exact correlation', async t => {
  const f = await observationFixture(t);
  assert.equal((await f.host.conversation(scope, actor).submit({ version: 1, scope, clientCommandId: 'plain', body: { kind: 'send', text: 'Observe' } })).kind, 'receipt');
  const before = revision(f); assert.equal(await f.emit([f.batch()]), true); assert.equal(revision(f), before + 1);
  assert.equal(f.dump().frontend_observation_runs.length, 0); assert.equal(f.dump().frontend_runs.length, 0);
});
