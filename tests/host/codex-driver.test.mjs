import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { openLocalHost } from '@agentui/host';
import { transcriptProjection } from '@agentui/contracts/conversation';
import { createCodexDriver } from '../../packages/host/dist/codex-driver.js';
import { command, scope, snapshot as genericSnapshot, until } from './fixture.mjs';

const projection = transcriptProjection;
const snapshot = port => genericSnapshot(port, projection.version);

function fixture(t, mode = 'stream') {
  const dir = mkdtempSync(join(tmpdir(), 'agentui-codex-driver-'));
  const logPath = join(dir, 'rpc.jsonl');
  const sessions = [];
  const open = () => {
    let host;
    const driver = createCodexDriver({ cwd: dir, version: '0.167.2',
      executable: process.execPath,
      args: [fileURLToPath(new URL('./fixtures/codex-agent.mjs', import.meta.url)), logPath, mode],
      append: (conversation, output) => host.append(conversation, output),
    });
    host = openLocalHost({ path: join(dir, 'host.sqlite'), projection, driver, authorize: () => true });
    const session = { host, driver, port: host.conversation(scope),
      close() { driver.close(); host.close(); },
    };
    sessions.push(session);
    return session;
  };
  t.after(() => {
    for (const session of sessions) session.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const log = () => existsSync(logPath) ? readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
  return { open,
    records() {
      const db = new DatabaseSync(join(dir, 'host.sqlite'));
      try {
        return {
          observations: Object.fromEntries(db.prepare('SELECT id, observation FROM commands').all()
            .map(row => [row.id, JSON.parse(row.observation)])),
          events: db.prepare('SELECT payload FROM events ORDER BY sequence').all().map(row => JSON.parse(row.payload).event),
        };
      } finally { db.close(); }
    },
    legacySnapshot() {
      const db = new DatabaseSync(join(dir, 'host.sqlite'));
      try {
        const document = JSON.parse(db.prepare('SELECT document FROM conversations WHERE host=? AND conversation=?').get(scope.hostId, scope.conversationId).document);
        delete document.domain.currentRun;
        const encoded = JSON.stringify(document);
        db.prepare('UPDATE conversations SET document=?, bytes=? WHERE host=? AND conversation=?').run(encoded, Buffer.byteLength(encoded), scope.hostId, scope.conversationId);
      } finally { db.close(); }
    },
    log: () => log().filter(message => message.direction === 'in'),
    turnIds: () => log().filter(message => message.direction === 'out' && message.method === 'turn/started' && message.params.turn.status === 'inProgress').map(message => message.params.turn.id),
    finishMessage: runId => writeFileSync(`${logPath}.item-${runId}`, ''),
    finish: runId => writeFileSync(`${logPath}.complete-${runId}`, ''),
  };
}

async function observe(port, predicate) {
  let latest;
  const feed = port.watch({ after: null, projectionVersion: 2 }, async item => {
    if (item.kind === 'snapshot') latest = item.snapshot.document;
    else latest = (await snapshot(port)).document;
  });
  try {
    await until(() => latest && predicate(latest), 3000).catch(error => {
      throw new Error(`${error.message}. Last document: ${JSON.stringify(latest)}`);
    });
    return latest;
  } finally {
    feed.close();
    await feed.ended;
  }
}

const messages = document => document.domain.messages;
const assistant = document => messages(document).filter(message => message.role === 'assistant');

test('passes the caller environment to its Codex process', { timeout: 4000 }, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'agentui-codex-environment-'));
  const path = join(dir, 'environment.json');
  const env = { PATH: process.env.PATH ?? '', OPENAI_API_KEY: 'explicit-provider-credential',
    OTEL_EXPORTER_OTLP_HEADERS: 'explicit-collector-header', AGENTUI_DATADOG_LLMOBS: 'true' };
  const driver = createCodexDriver({ cwd: dir, version: '0.167.2', executable: process.execPath,
    args: ['--eval', `const fs = require('node:fs'); const temporary = process.argv[1] + '.tmp'; fs.writeFileSync(temporary, JSON.stringify(process.env)); fs.renameSync(temporary, process.argv[1]); setInterval(() => {}, 1000);`, path],
    env, append() {},
  });
  t.after(() => { driver.close(); rmSync(dir, { recursive: true, force: true }); });
  await until(() => existsSync(path));
  const actual = JSON.parse(readFileSync(path, 'utf8'));
  assert.deepEqual(Object.fromEntries(Object.keys(env).map(key => [key, actual[key]])), env);
});

test('streams before completion, reuses its thread, resumes from legacy SQLite and cancels an active turn', { timeout: 10_000 }, async t => {
  const f = fixture(t);
  const first = f.open();
  first.host.createConversation(scope, first.driver.installation);
  const send = command('first', { kind: 'send', text: 'First question' });
  const accepted = await first.port.submit(send);
  assert.equal(accepted.receipt.state.kind, 'completed');
  const partial = await observe(first.port, document => assistant(document).some(message => message.text === 'Hello' && !message.complete));
  const [runId] = f.turnIds();
  assert.equal(messages(partial).find(message => message.role === 'user').text, 'First question');
  assert.deepEqual(await first.port.submit(command('too-soon')), { kind: 'rejected', reason: 'Codex is still responding. Wait for it to finish.' });
  assert.deepEqual(await first.port.submit(send), accepted);
  assert.equal(f.log().filter(message => message.method === 'turn/start').length, 1);
  f.finishMessage(runId);
  await observe(first.port, document => assistant(document).some(message => message.text === 'Hello from the fixture.' && !message.complete));
  assert.equal(first.driver.capability(command('still-finishing')).kind, 'unsupported');
  f.finish(runId);
  await observe(first.port, document => assistant(document).some(message => message.text === 'Hello from the fixture.' && message.complete));
  await until(() => first.driver.capability(command('second')).kind === 'supported');

  const second = await first.port.submit(command('second'));
  assert.equal(second.kind, 'receipt', JSON.stringify(second));
  assert.equal(second.receipt.state.kind, 'completed');
  await observe(first.port, document => assistant(document).length === 2 && assistant(document).some(message => !message.complete));
  const secondRunId = f.turnIds()[1];
  f.finish(secondRunId);
  await observe(first.port, document => assistant(document).filter(message => message.complete).length === 2);
  await until(() => first.driver.capability(command('third')).kind === 'supported');
  assert.equal(f.log().filter(message => message.method === 'thread/start').length, 1);
  assert.equal(f.log().filter(message => message.method === 'thread/resume').length, 0);
  first.close();
  f.legacySnapshot();

  const resumed = f.open();
  const before = await snapshot(resumed.port);
  assert.equal(assistant(before.document).filter(message => message.complete).length, 2);
  assert.equal(before.document.domain.currentRun, null);
  assert.deepEqual(await resumed.port.submit(send), accepted);
  assert.equal((await resumed.port.submit(command('third'))).receipt.state.kind, 'completed');
  await observe(resumed.port, document => assistant(document).length === 3 && assistant(document).some(message => !message.complete));
  const thirdRunId = f.turnIds()[2];
  assert.deepEqual((await snapshot(resumed.port)).document.domain.currentRun, { kind: 'running', runId: thirdRunId });
  const cancellation = await resumed.port.submit(command('cancel-third', { kind: 'cancel', runId: thirdRunId }));
  assert.equal(cancellation.receipt.state.kind, 'completed');
  await observe(resumed.port, document => assistant(document).some(message => /stopped/.test(message.text)));
  const log = f.log();
  assert.equal(log.filter(message => message.method === 'thread/start').length, 1);
  assert.deepEqual(log.filter(message => message.method === 'thread/resume').map(message => message.params.threadId), ['fixture-thread']);
  assert.deepEqual(log.filter(message => message.method === 'turn/start').map(message => message.params.threadId), Array(3).fill('fixture-thread'));
  assert.equal(new Set(log.filter(message => message.method === 'initialize').map(message => message.pid)).size, 2);
  assert.deepEqual(log.find(message => message.method === 'turn/interrupt').params, { threadId: 'fixture-thread', turnId: thirdRunId });
});

for (const [mode, id, choice] of [['command-approval', 0, 'accept'], ['file-approval', 'file-request', 'decline']]) {
  test(`${mode} remains actionable after send acknowledgement and replies once with the exact request ID`, { timeout: 5000 }, async t => {
    const f = fixture(t, mode), session = f.open();
    session.host.createConversation(scope, session.driver.installation);
    const accepted = await session.port.submit(command('send'));
    assert.equal(accepted.receipt.state.kind, 'completed');
    const waiting = await observe(session.port, document => Object.keys(document.decisions).length === 1);
    const decision = Object.values(waiting.decisions)[0];
    assert.deepEqual(decision.choices, ['accept', 'decline']);
    assert.match(decision.prompt, mode === 'command-approval' ? /printf hello/ : /change files/);
    const approval = command('decision', { kind: 'approve', pendingId: decision.pendingId, choiceId: choice });
    const result = await session.port.submit(approval);
    assert.equal(result.receipt.state.kind, 'completed');
    const done = await observe(session.port, document => Object.keys(document.decisions).length === 0 &&
      assistant(document).some(message => message.text === `Approval ${choice}.` && message.complete));
    assert.deepEqual(done.decisions, {});
    assert.deepEqual(await session.port.submit(approval), result);
    assert.deepEqual(f.log().filter(message => !('method' in message)).map(({ id, result }) => ({ id, result })),
      [{ id, result: { decision: choice } }]);
  });
}

test('exit after a send effect shows interruption and an exact retry never starts another turn', { timeout: 5000 }, async t => {
  const f = fixture(t, 'exit'), session = f.open();
  session.host.createConversation(scope, session.driver.installation);
  const send = command('send-once');
  const accepted = await session.port.submit(send);
  assert.equal(accepted.receipt.state.kind, 'completed');
  const ended = await observe(session.port, document => assistant(document).some(message => /interrupted/i.test(message.text)));
  assert.deepEqual(ended.domain.currentRun, { kind: 'ended', runId: f.turnIds()[0], outcome: 'connection-lost' });
  assert.deepEqual(await session.port.submit(send), accepted);
  assert.equal(f.log().filter(message => message.method === 'turn/start').length, 1);
  session.close();
  const reopened = f.open();
  assert.deepEqual(await reopened.port.submit(send), accepted);
  assert.equal(f.log().filter(message => message.method === 'turn/start').length, 1);
});

for (const [mode, outcome] of [['delayed-stop', 'interrupted'], ['natural-race', 'completed']]) {
  test(`${mode} keeps the run stopping after ACK, interrupts once and permits a same-thread follow-up`, { timeout: 5000 }, async t => {
    const f = fixture(t, mode), session = f.open();
    session.host.createConversation(scope, session.driver.installation);
    await session.port.submit(command('send'));
    const partial = await observe(session.port, document => assistant(document).some(message => message.text === 'Hello'));
    const runId = partial.domain.currentRun.runId;
    const cancel = command('stop-once', { kind: 'cancel', runId });
    const duplicate = command('stop-twice', { kind: 'cancel', runId });
    const [first, second] = await Promise.all([
      session.port.submit(cancel), session.port.submit(duplicate),
    ]);
    assert.equal(first.receipt.state.kind, 'completed');
    assert.equal(second.kind, 'receipt');
    assert.deepEqual(second.receipt.state, { kind: 'not-dispatched', reason: 'Codex is already stopping this response.' });
    const records = f.records();
    assert.deepEqual(records.observations['stop-twice'], second.receipt.state);
    assert.deepEqual(records.events.filter(event => event.kind === 'domain' && event.event.kind === 'run-stop-requested')
      .map(event => event.event), [{ kind: 'run-stop-requested', runId, clientCommandId: 'stop-once' }]);
    assert.deepEqual((await snapshot(session.port)).document.domain.currentRun,
      { kind: 'stopping', runId, clientCommandId: 'stop-once' });
    assert.equal(session.driver.capability(command('too-soon')).kind, 'unsupported');
    assert.deepEqual(await session.port.submit(cancel), first);
    assert.deepEqual(await session.port.submit(duplicate), second);
    const done = await observe(session.port, document => document.domain.currentRun.kind === 'ended');
    assert.deepEqual(done.domain.currentRun, { kind: 'ended', runId, outcome });
    assert.ok(assistant(done).some(message => message.text.startsWith('Hello') && message.complete));
    assert.equal(f.log().filter(message => message.method === 'turn/interrupt').length, 1);
    await session.port.submit(command('follow-up'));
    const next = await observe(session.port, document => document.domain.currentRun.kind === 'running');
    assert.notEqual(next.domain.currentRun.runId, runId);
    assert.equal(f.log().filter(message => message.method === 'thread/start').length, 1);
    assert.equal(f.log().filter(message => message.method === 'thread/resume').length, 0);
  });
}

test('run is authoritative before response text and persists in a fresh snapshot', { timeout: 5000 }, async t => {
  const f = fixture(t, 'before-text'), session = f.open();
  session.host.createConversation(scope, session.driver.installation);
  await session.port.submit(command('send'));
  const beforeText = (await snapshot(session.port)).document;
  assert.deepEqual(beforeText.domain.currentRun, { kind: 'running', runId: f.turnIds()[0] });
  assert.deepEqual(assistant(beforeText), []);
  assert.deepEqual((await snapshot(session.host.conversation(scope))).document.domain, beforeText.domain);
});

test('Stop admitted before turn completion refuses without native or output effects after completion', { timeout: 5000 }, async t => {
  const f = fixture(t), session = f.open();
  session.host.createConversation(scope, session.driver.installation);
  await session.port.submit(command('send'));
  const running = await observe(session.port, document => assistant(document).some(message => message.text === 'Hello'));
  const runId = running.domain.currentRun.runId;
  const cancel = command('late-stop', { kind: 'cancel', runId });
  const dispatch = session.driver.dispatch;
  let dispatches = 0, lookups = 0;
  session.driver.lookup = async () => { lookups++; throw new Error('Terminal refusal must not be looked up'); };
  session.driver.dispatch = async (cmd, target) => {
    dispatches++;
    f.finish(runId);
    await observe(session.port, document => document.domain.currentRun.kind === 'ended');
    const events = f.records().events;
    const requests = f.log();
    const result = await dispatch(cmd, target);
    assert.deepEqual(f.records().events, events);
    assert.deepEqual(f.log(), requests);
    return result;
  };
  const refused = await session.port.submit(cancel);
  assert.equal(refused.kind, 'receipt');
  assert.deepEqual(refused.receipt.state, { kind: 'not-dispatched', reason: 'Codex turn is no longer active' });
  assert.deepEqual(f.records().observations['late-stop'], refused.receipt.state);
  assert.deepEqual(await session.port.submit(cancel), refused);
  assert.deepEqual(await session.host.reconcile(scope, cancel.clientCommandId), refused.receipt);
  assert.equal(dispatches, 1);
  assert.equal(lookups, 0);
  assert.equal(f.log().filter(message => message.method === 'turn/interrupt').length, 0);
  assert.equal(f.records().events.some(event => event.kind === 'domain' && event.event.kind === 'run-stop-requested'), false);
});

test('approval admitted before connection closure refuses without native or output effects after expiry', { timeout: 5000 }, async t => {
  const f = fixture(t, 'command-approval'), session = f.open();
  session.host.createConversation(scope, session.driver.installation);
  await session.port.submit(command('send'));
  const waiting = await observe(session.port, document => Object.keys(document.decisions).length === 1);
  const decision = Object.values(waiting.decisions)[0];
  const approval = command('expired-approval', { kind: 'approve', pendingId: decision.pendingId, choiceId: 'accept' });
  const dispatch = session.driver.dispatch;
  let dispatches = 0, lookups = 0;
  session.driver.lookup = async () => { lookups++; throw new Error('Terminal refusal must not be looked up'); };
  session.driver.dispatch = async (cmd, target) => {
    dispatches++;
    session.driver.close();
    const events = f.records().events;
    const requests = f.log();
    const result = await dispatch(cmd, target);
    assert.deepEqual(f.records().events, events);
    assert.deepEqual(f.log(), requests);
    return result;
  };
  const refused = await session.port.submit(approval);
  assert.equal(refused.kind, 'receipt');
  assert.deepEqual(refused.receipt.state, { kind: 'not-dispatched', reason: 'Codex approval expired with its connection' });
  assert.deepEqual(f.records().observations['expired-approval'], refused.receipt.state);
  assert.deepEqual(await session.port.submit(approval), refused);
  assert.deepEqual(await session.host.reconcile(scope, approval.clientCommandId), refused.receipt);
  assert.equal(dispatches, 1);
  assert.equal(lookups, 0);
  assert.equal(f.log().filter(message => !('method' in message)).length, 0);
  assert.deepEqual((await snapshot(session.port)).document.decisions, {});
});

test('a definite interrupt rejection restores running and allows another Stop', { timeout: 5000 }, async t => {
  const f = fixture(t, 'reject-stop'), session = f.open();
  session.host.createConversation(scope, session.driver.installation);
  await session.port.submit(command('send'));
  const runId = (await snapshot(session.port)).document.domain.currentRun.runId;
  const rejected = await session.port.submit(command('stop', { kind: 'cancel', runId }));
  assert.equal(rejected.receipt.state.kind, 'rejected');
  assert.deepEqual((await snapshot(session.port)).document.domain.currentRun, { kind: 'running', runId });
  const again = await session.port.submit(command('stop-again', { kind: 'cancel', runId }));
  assert.equal(again.receipt.state.kind, 'rejected');
  assert.equal(f.log().filter(message => message.method === 'turn/interrupt').length, 2);
});
