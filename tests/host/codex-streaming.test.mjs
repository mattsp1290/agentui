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
  const driver = createCodexDriver({ cwd: dir, version: '0.167.2', executable: process.execPath,
    args: [fileURLToPath(new URL('./fixtures/codex-streaming-agent.mjs', import.meta.url)), logPath, mode],
    append: (conversation, output) => {
      if (rejectAppend(conversation, output)) throw new Error('Fixture storage failure');
      host.append(conversation, output);
      outputs.push({ scope: conversation, ...output });
    },
  });
  host = openLocalHost({ path: join(dir, 'host.sqlite'), projection: transcriptProjection,
    driver, budgets: defaultHostBudgets(), authorize: () => true });
  host.createConversation(scope, driver.installation);
  host.createConversation(other, driver.installation);
  t.after(() => { driver.close(); host.close(); rmSync(dir, { recursive: true, force: true }); });
  return { host, driver, outputs, port: host.conversation(scope),
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

test('transport loss after turn/start remains uncertain', async t => {
  const f = fixture(t, 'lost-start');
  const send = command('lost');
  const result = await f.port.submit(send);
  assert.equal(result.receipt.state.kind, 'uncertain');
  assert.deepEqual(await f.port.submit(send), result);
  assert.equal(f.log().filter(message => message.method === 'turn/start').length, 1);
  assert.match(f.driver.capability(command('later')).reason, /Restart the host/);
});

for (const mode of ['file-approval', 'command-approval', 'fallback-approval']) {
  test(`${mode} describes the requested permission and preserves native confirmation`, async t => {
    const f = fixture(t, mode);
    await f.port.submit(command('send'));
    await until(() => Object.keys(f.document().decisions).length === 1);
    const decision = Object.values(f.document().decisions)[0];
    if (mode === 'file-approval') {
      for (const detail of ['/workspace', '/workspace/src/main.ts', '/workspace/new.txt', '(update)', '(add)', '-old\n+new']) {
        assert.ok(decision.prompt.includes(detail), detail);
      }
    } else {
      assert.match(decision.prompt, /Working directory: \/workspace\/subdirectory/);
      assert.match(decision.prompt, mode === 'fallback-approval' ? /run a command/ : /printf hello/);
    }
    const result = await f.port.submit(command('approve', { kind: 'approve', pendingId: decision.pendingId, choiceId: 'accept' }));
    assert.equal(result.receipt.state.kind, 'completed');
    await until(() => f.messages().some(message => message.text === 'Approved.' && message.complete));
    assert.deepEqual(f.document().decisions, {});
  });
}

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
