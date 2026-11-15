import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { transcriptProjection } from '@agentui/contracts/conversation';
import { openLocalHost, createCodexDriver } from '@agentui/host';
import { budgets as defaultHostBudgets } from '../../packages/host/dist/durable-model.js';
import { command, scope, other, until } from './fixture.mjs';

const longText = '🙂汉"\\\n\u0000'.repeat(8_000);
function fixture(t, mode, rejectAppend = () => false) {
  const dir = mkdtempSync(join(tmpdir(), 'agentui-codex-streaming-'));
  const logPath = join(dir, 'rpc.jsonl');
  const outputs = [];
  let host;
  const createDriver = () => createCodexDriver({ cwd: dir, version: '0.167.2', executable: process.execPath,
    args: [fileURLToPath(new URL('./fixtures/codex-streaming-agent.mjs', import.meta.url)), logPath, mode],
    append: (conversation, output) => {
      if (rejectAppend(conversation, output)) throw new Error('Fixture storage failure');
      host.append(conversation, output);
      outputs.push({ scope: conversation, ...output });
    },
  });
  let driver = createDriver();
  host = openLocalHost({ path: join(dir, 'host.sqlite'), projection: transcriptProjection,
    driver, budgets: defaultHostBudgets(), authorize: () => true });
  host.createConversation(scope, driver.installation);
  host.createConversation(other, driver.installation);
  t.after(() => { driver.close(); host.close(); rmSync(dir, { recursive: true, force: true }); });
  return { get host() { return host; }, get driver() { return driver; }, outputs, get port() { return host.conversation(scope); },
    async reopen(freshDriver = false) {
      if (freshDriver) driver.close();
      host.close();
      await host.drained;
      if (freshDriver) driver = createDriver();
      host = openLocalHost({ path: join(dir, 'host.sqlite'), projection: transcriptProjection,
        driver, budgets: defaultHostBudgets(), authorize: () => true });
    },
    document: (conversation = scope) => host.inspect(conversation).snapshot.document,
    messages: (conversation = scope) => host.inspect(conversation).snapshot.document.domain.messages.filter(message => message.role === 'assistant'),
    log: () => existsSync(logPath) ? readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [],
    trigger: marker => writeFileSync(`${logPath}.${marker}`, ''),
  };
}

for (const mode of ['long', 'short-correction']) {
  test(`${mode} preserves large Unicode replies as revisable bounded parts under the real projection`, { timeout: 6_000 }, async t => {
    const f = fixture(t, mode);
    assert.ok(Buffer.byteLength(longText) > 70_000);
    assert.equal((await f.port.submit(command('first'))).receipt.state.kind, 'completed');
    await until(() => f.messages().map(message => message.text).join('') === longText);
    assert.ok(f.messages().length > 1);
    assert.ok(f.messages().every(message => !message.complete));
    const streamedEvents = f.outputs.flatMap(output => output.events).filter(event => event.role === 'assistant');
    assert.ok(streamedEvents.length < 30, 'a burst of 800 deltas is coalesced into bounded parts');
    for (const event of streamedEvents) assert.ok(Buffer.byteLength(JSON.stringify(event)) < defaultHostBudgets().maxEventBytes);
    f.trigger('item');
    const finalText = mode === 'long' ? `${longText} Final correction.` : 'Corrected shorter reply 🙂';
    await until(() => f.messages().map(message => message.text).join('') === finalText);
    assert.ok(f.messages().some(message => !message.complete), 'item completion must not enable Send');
    assert.equal(f.driver.capability(command('still-busy')).kind, 'unsupported');
    if (mode === 'long') {
      const firstPartId = f.messages()[0].messageId;
      assert.equal(f.outputs.flatMap(output => output.events).filter(event => event.messageId === firstPartId && event.text !== '').length, 1,
        'an unchanged full prefix is not republished when the last part changes');
    }
    f.trigger('finish');
    await until(() => f.messages().every(message => message.complete));
    assert.equal(f.messages().map(message => message.text).join(''), finalText);
    assert.equal(f.driver.capability(command('next')).kind, 'supported');
  });
}

test('one failed append seals stored parts and interrupts only its turn', async t => {
  let rejected = false;
  const f = fixture(t, 'ordinary', (conversation, output) => {
    if (!rejected && conversation.conversationId === scope.conversationId && output.events.some(event => event.text === 'Hello')) {
      rejected = true;
      return true;
    }
    return false;
  });
  await f.port.submit(command('first'));
  await until(() => rejected && f.messages().some(message => /could not store/.test(message.text)));
  assert.ok(f.messages().every(message => message.complete));
  assert.equal(f.document().domain.currentRun.kind, 'ended');
  assert.equal(f.document().domain.currentRun.outcome, 'failed');
  const second = await f.host.conversation(other).submit(command('second', { kind: 'send', text: 'hello' }, other));
  assert.equal(second.receipt.state.kind, 'completed');
  await until(() => f.messages(other).some(message => message.text === 'Hello' && message.complete));
  assert.deepEqual(f.log().filter(message => message.method === 'turn/interrupt').map(message => message.params.threadId), ['thread-1']);
  assert.equal(f.driver.capability(command('still-connected')).kind, 'supported');
});

for (const method of ['initialize', 'thread/start', 'turn/start']) {
  test(`a native ${method} rejection is conclusive and a distinct send can proceed`, async t => {
    const f = fixture(t, `reject-${method}`);
    const first = command('rejected');
    const result = await f.port.submit(first);
    assert.equal(result.receipt.state.kind, 'rejected');
    assert.match(result.receipt.state.reason, /Fixture denied this request/);
    assert.deepEqual(await f.port.submit(first), result);
    assert.equal((await f.port.submit(command('retry-new-id'))).receipt.state.kind, 'completed');
    await until(() => f.messages().some(message => message.text === 'Hello' && message.complete));
    if (method === 'initialize') assert.equal(f.log().filter(message => message.method === method).length, 2);
  });
}

test('transport loss after turn/start stores one completed uncertain notice across restart and exact retries', async t => {
  const f = fixture(t, 'lost-start');
  const send = command('lost');
  const result = await f.port.submit(send);
  assert.equal(result.receipt.state.kind, 'uncertain');
  assert.equal(f.document().domain.currentRun, null);
  assert.equal(f.messages().length, 1);
  assert.equal(f.messages()[0].text, 'Codex did not confirm whether this response started. Check command recovery and any unconfirmed actions before trying again.');
  assert.equal(f.messages()[0].complete, true);
  assert.match(f.messages()[0].messageId, /:assistant-unconfirmed$/);
  assert.equal(f.outputs.flatMap(output => output.runs).length, 0);
  assert.equal(f.outputs.flatMap(output => output.events).filter(event => event.kind.startsWith('run-')).length, 0);
  const stored = f.document();
  const requests = f.log();
  assert.deepEqual(await f.port.submit(send), result);
  await f.reopen();
  assert.deepEqual(await f.port.submit(send), result);
  assert.deepEqual(f.document(), stored);
  assert.deepEqual(f.log(), requests);
  assert.match(f.driver.capability(command('later')).reason, /Restart the host/);
});

for (const mode of ['expire-complete', 'expire-resolved', 'expire-disconnect', 'expire-close']) {
  test(`${mode} removes stale approvals before a cached click can enter Codex`, async t => {
    const f = fixture(t, mode);
    await f.port.submit(command('send'));
    await until(() => Object.keys(f.document().decisions).length === 1);
    const decision = Object.values(f.document().decisions)[0];
    if (mode === 'expire-close') f.driver.close();
    else f.trigger('finish');
    await until(() => Object.keys(f.document().decisions).length === 0);
    const result = await f.port.submit(command('stale', { kind: 'approve', pendingId: decision.pendingId, choiceId: 'accept' }));
    assert.equal(result.kind, 'rejected');
    assert.equal(f.log().filter(message => !('method' in message)).length, 0);
  });
}

for (const mode of ['pending-complete', 'pending-disconnect']) {
  test(`${mode} promptly releases an approval waiter without inventing native acceptance`, { timeout: 3_000 }, async t => {
    const f = fixture(t, mode);
    await f.port.submit(command('send'));
    await until(() => Object.keys(f.document().decisions).length === 1);
    const decision = Object.values(f.document().decisions)[0];
    const result = await f.port.submit(command('approve', { kind: 'approve', pendingId: decision.pendingId, choiceId: 'accept' }));
    assert.equal(result.receipt.state.kind, 'uncertain');
    assert.deepEqual(f.document().decisions, {});
  });
}

for (const method of ['initialize', 'thread/start', 'turn/start']) {
  test(`a ${method} rejection stores one completed notice across restart and exact retries`, async t => {
    const f = fixture(t, `reject-${method}`);
    const send = command('rejected-visible');
    const result = await f.port.submit(send);
    assert.equal(result.receipt.state.kind, 'rejected');
    assert.equal(f.document().domain.currentRun, null);
    assert.equal(f.document().domain.messages.filter(message => message.role === 'user').length, method === 'turn/start' ? 1 : 0);
    assert.equal(f.messages().length, 1);
    assert.match(f.messages()[0].text, /Codex rejected this request: Fixture denied this request/);
    assert.equal(f.messages()[0].complete, true);
    assert.match(f.messages()[0].messageId, /:assistant-rejection$/);
    assert.equal(f.outputs.flatMap(output => output.runs).length, 0);
    assert.equal(f.outputs.flatMap(output => output.events).filter(event => event.kind.startsWith('run-')).length, 0);
    const stored = f.document();
    const requests = f.log();
    assert.deepEqual(await f.port.submit(send), result);
    await f.reopen();
    assert.deepEqual(f.document(), stored);
    assert.deepEqual(await f.port.submit(send), result);
    assert.deepEqual(f.document(), stored);
    assert.deepEqual(f.log(), requests);
    assert.equal((await f.port.submit(command('distinct-send'))).receipt.state.kind, 'completed');
    await until(() => f.messages().some(message => message.text === 'Hello' && message.complete));
  });
}

test('a resume rejection retains the previous completed run and messages across exact retries', async t => {
  const f = fixture(t, 'reject-thread/resume');
  await f.port.submit(command('first'));
  await until(() => f.document().domain.currentRun?.kind === 'ended');
  const previous = f.document().domain;
  const runs = f.outputs.flatMap(output => output.runs);
  const lifecycle = f.outputs.flatMap(output => output.events).filter(event => event.kind.startsWith('run-'));
  await f.reopen(true);
  const send = command('resume-rejected');
  const result = await f.port.submit(send);
  assert.equal(result.receipt.state.kind, 'rejected');
  assert.deepEqual(f.document().domain.currentRun, previous.currentRun);
  assert.deepEqual(f.document().domain.messages.slice(0, -1), previous.messages);
  assert.match(f.messages().at(-1).text, /Codex rejected this request: Fixture denied this request/);
  assert.equal(f.messages().at(-1).complete, true);
  assert.deepEqual(f.outputs.flatMap(output => output.runs), runs);
  assert.deepEqual(f.outputs.flatMap(output => output.events).filter(event => event.kind.startsWith('run-')), lifecycle);
  const stored = f.document();
  const requests = f.log();
  assert.deepEqual(await f.port.submit(send), result);
  await f.reopen();
  assert.deepEqual(await f.port.submit(send), result);
  assert.deepEqual(f.document(), stored);
  assert.deepEqual(f.log(), requests);
  assert.equal((await f.port.submit(command('resume-new-id'))).receipt.state.kind, 'completed');
  await until(() => f.messages().filter(message => message.text === 'Hello' && message.complete).length === 2);
  assert.deepEqual(f.log().filter(message => message.method === 'thread/resume').map(message => message.params.threadId),
    [runs[0].reference.opaque, runs[0].reference.opaque]);
});

for (const { mode, includes, excludes } of [
  { mode: 'item-command-approval', includes: [/Run: printf from-item/, /Working directory: \/workspace\/item/], excludes: [] },
  { mode: 'scoped-command-approval', includes: [/Allow Codex to run a command/, /Workspace:/], excludes: [/from-item|workspace\/item|Working directory:/] },
]) {
  test(`${mode} uses only the matching turn item and preserves native confirmation`, async t => {
    const f = fixture(t, mode);
    if (mode === 'scoped-command-approval') {
      await f.host.conversation(other).submit(command('other-send', { kind: 'send', text: 'hello' }, other));
      await until(() => Object.keys(f.document(other).decisions).length === 1);
    }
    await f.port.submit(command('send'));
    await until(() => Object.keys(f.document().decisions).length === 1);
    const decision = Object.values(f.document().decisions)[0];
    for (const pattern of includes) assert.match(decision.prompt, pattern);
    for (const pattern of excludes) assert.doesNotMatch(decision.prompt, pattern);
    const result = await f.port.submit(command('approve', { kind: 'approve', pendingId: decision.pendingId, choiceId: 'accept' }));
    assert.equal(result.receipt.state.kind, 'completed');
    await until(() => f.messages().some(message => message.text === 'Approved.' && message.complete));
    assert.equal(f.log().filter(message => !('method' in message)).at(-1).id, 'command-request');
  });
}

for (const { mode, requestId, detail } of [
  { mode: 'file-approval', requestId: 0, detail: /\/workspace\/src\/main.ts/ },
  { mode: 'malformed-file-approval', requestId: '0', detail: /Codex did not provide file details/ },
]) {
  test(`${mode} keeps approval live and confirms its typed native ID`, async t => {
    const f = fixture(t, mode);
    await f.port.submit(command('send'));
    await until(() => Object.keys(f.document().decisions).length === 1);
    const decision = Object.values(f.document().decisions)[0];
    assert.match(decision.prompt, detail);
    assert.equal(f.document().domain.currentRun.kind, 'running');
    assert.equal(f.log().filter(message => message.method === 'turn/interrupt').length, 0);
    const result = await f.port.submit(command('approve', { kind: 'approve', pendingId: decision.pendingId, choiceId: 'accept' }));
    assert.equal(result.receipt.state.kind, 'completed');
    await until(() => f.messages().some(message => message.text === 'Approved.' && message.complete));
    assert.deepEqual(f.document().decisions, {});
    assert.equal(f.log().filter(message => !('method' in message)).at(-1).id, requestId);
  });
}

test('a rejected follow-up preserves the previous native run', async t => {
  const f = fixture(t, 'reject-followup');
  await f.port.submit(command('first'));
  await until(() => f.messages().some(message => message.complete));
  const previousRun = f.document().domain.currentRun;
  assert.equal(previousRun.kind, 'ended');
  const runEvents = f.outputs.flatMap(output => output.events).filter(event => event.kind.startsWith('run-'));
  const result = await f.port.submit(command('followup'));
  assert.equal(result.receipt.state.kind, 'rejected');
  assert.deepEqual(f.document().domain.currentRun, previousRun);
  assert.deepEqual(f.outputs.flatMap(output => output.events).filter(event => event.kind.startsWith('run-')), runEvents);
  assert.match(f.messages().at(-1).text, /Codex rejected this request/);
  assert.equal(f.messages().at(-1).complete, true);
});

test('a failed rejection-notice append preserves the conclusive native rejection', async t => {
  const f = fixture(t, 'reject-turn/start', (_scope, output) => output.events.some(event => event.kind === 'message-updated' && /Codex rejected this request/.test(event.text)));
  const send = command('rejected-storage');
  const result = await f.port.submit(send);
  assert.equal(result.receipt.state.kind, 'rejected');
  assert.deepEqual(await f.port.submit(send), result);
  assert.equal(f.document().domain.currentRun, null);
  assert.equal(f.log().filter(message => message.method === 'turn/start').length, 1);
  assert.equal(f.log().filter(message => message.method === 'turn/interrupt').length, 0);
  assert.deepEqual(f.messages().map(message => message.text),
    ['This response stopped because AgentUI could not store more output. Try a new conversation.']);
});

for (const mode of ['reject-initialize', 'reject-thread/start', 'lost-start']) {
  test(`${mode} notice storage failure preserves its native outcome without interrupting`, async t => {
    let attempted = 0;
    const f = fixture(t, mode, (_scope, output) => {
      if (!output.events.some(event => event.role === 'assistant')) return false;
      attempted++;
      return true;
    });
    const send = command('notice-storage-failure');
    const result = await f.port.submit(send);
    assert.equal(result.receipt.state.kind, mode === 'lost-start' ? 'uncertain' : 'rejected');
    assert.ok(attempted > 0);
    assert.deepEqual(await f.port.submit(send), result);
    assert.equal(f.document().domain.currentRun, null);
    assert.deepEqual(f.messages(), []);
    assert.equal(f.log().filter(message => message.method === 'turn/interrupt').length, 0);
  });
}

test('closing during initialization does not append a failed-send notice', async t => {
  const f = fixture(t, 'ordinary');
  const pending = f.port.submit(command('closing'));
  f.driver.close();
  assert.equal((await pending).receipt.state.kind, 'uncertain');
  assert.deepEqual(f.messages(), []);
  assert.equal(f.document().domain.currentRun, null);
});

for (const mode of ['activity-empty', 'activity-fallback']) {
  test(`${mode} retains scoped command observations, bounded output and late terminal callbacks across reopening`, async t => {
    const f = fixture(t, mode);
    await f.port.submit(command('activity'));
    await until(() => f.document().domain.activities?.[0]?.output === 'early🙂delta');
    assert.equal(f.document().domain.activities[0].status.kind, 'running');
    const firstId = f.document().domain.activities[0].activityId;
    f.trigger('finish');
    await until(() => f.document().domain.activities?.[2]?.status.kind === 'declined');
    await until(() => mode === 'activity-empty' || f.document().domain.activities[0].output.endsWith('after-close'));
    const domain = f.document().domain;
    assert.equal(domain.activities.length, 3);
    assert.equal(domain.activities[0].activityId, firstId);
    assert.deepEqual(domain.activities[0].status, { kind: 'completed', exitCode: 3 });
    assert.equal(domain.activities[0].output, mode === 'activity-empty' ? '' : 'early🙂deltalateafter-close');
    assert.deepEqual(domain.activities[1].status, { kind: 'failed', exitCode: 7 });
    assert.ok(domain.activities[1].outputTruncated);
    assert.ok(Buffer.byteLength(JSON.stringify(domain.activities[1].output)) - 2 <= 8_000);
    assert.equal(domain.currentRun.kind, 'ended');
    assert.ok(f.outputs.flatMap(value => value.events).filter(event => event.kind === 'command-updated').every(event => Buffer.byteLength(JSON.stringify(event)) < 64_000));
    await f.reopen();
    assert.deepEqual(f.document().domain, domain);
  });
}


for (const rejectLate of [false, true]) {
  test(`late command completion ${rejectLate ? 'capacity failure' : 'success'} cannot affect a newer turn`, async t => {
    let attempted = 0;
    const f = fixture(t, 'activity-late-context', (_scope, output) => {
      if (output.events.some(event => event.kind === 'command-updated' && event.activity.status.kind === 'completed')) {
        attempted++;
        return rejectLate;
      }
      return false;
    });
    await f.port.submit(command('old'));
    await until(() => f.document().domain.activities?.length === 1);
    f.trigger('finish');
    await until(() => f.document().domain.currentRun?.kind === 'ended');
    await f.port.submit(command('new'));
    await until(() => f.messages().some(message => message.text === 'Current turn remains live'));
    const current = f.document().domain.currentRun;
    f.trigger('late');
    await until(() => attempted > 0);
    await new Promise(resolve => setTimeout(resolve, 30));
    const domain = f.document().domain;
    assert.deepEqual(domain.currentRun, current);
    assert.equal(current.kind, 'running');
    assert.equal(domain.activities[0].status.kind, rejectLate ? 'running' : 'completed');
    assert.equal(domain.activities[0].output, rejectLate ? '' : 'Late final output');
    assert.ok(f.messages().some(message => message.text === 'Current turn remains live'));
    assert.ok(f.messages().every(message => !message.text.includes('Old assistant text')));
  });
}
