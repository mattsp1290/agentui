import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { openLocalHost } from '@agentui/host';
import { createPiDriver } from '@agentui/host/pi';
import { transcriptProjection } from '@agentui/contracts/conversation';
import { command, scope, until } from './fixture.mjs';

const frame = (content, finish_reason = null) => `data: ${JSON.stringify({
  id: 'fixture', object: 'chat.completion.chunk', created: 1, model: 'glm-5.3',
  choices: [{ index: 0, delta: content === null ? {} : { role: 'assistant', content }, finish_reason }],
})}\n\n`;
const key = 'fixture-provider-key-never-persist';
async function fixture(t, budgets = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'agentui-pi-driver-'));
  const requests = [];
  let release;
  let emitText;
  let held = false;
  let withholdFirstText = false;
  let failFirstAppend = false;
  let rejectOutput = null;
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    assert.equal(String(input), 'https://opencode.ai/inference/go/openai/v1/chat/completions');
    assert.equal(new Headers(init.headers).get('authorization'), `Bearer ${key}`);
    requests.push(JSON.parse(init.body));
    return new Response(new ReadableStream({ start(controller) {
      const emit = value => controller.enqueue(new TextEncoder().encode(value));
      emitText = text => emit(frame(text));
      if (!withholdFirstText) emit(frame('Hello from Pi'));
      if (!held) { emit(frame(null, 'stop')); emit('data: [DONE]\n\n'); controller.close(); return; }
      release = () => { emit(frame(null, 'stop')); emit('data: [DONE]\n\n'); controller.close(); };
      init.signal?.addEventListener('abort', () => controller.error(new DOMException('Aborted', 'AbortError')), { once: true });
    } }), { headers: { 'content-type': 'text/event-stream' } });
  };
  const instances = [];
  const open = async () => {
    let host;
    const driver = await createPiDriver({ cwd: directory, sessionDirectory: join(directory, 'pi'), apiKey: key,
      currentRunId: value => host.inspect(value).snapshot.document.domain.currentRun?.runId ?? null,
      append: (value, output) => {
        if (rejectOutput?.(output)) { rejectOutput = null; throw new Error('Output storage unavailable'); }
        host.append(value, output);
        if (failFirstAppend && output.events.some(event => event.kind === 'run-started')) {
          failFirstAppend = false;
          throw new Error('Storage acknowledgement failed before native prompt');
        }
      } });
    host = openLocalHost({ path: join(directory, 'host.sqlite'), projection: transcriptProjection, driver, authorize: () => true, budgets });
    let closed = false;
    const instance = { host, driver, port: host.conversation(scope), async close() {
      if (closed) return;
      closed = true;
      try { await driver.close(); } finally { host.close(); await host.drained; }
    } };
    instances.push(instance);
    return instance;
  };
  t.after(async () => {
    for (const instance of instances) await instance.close();
    globalThis.fetch = original;
    await rm(directory, { recursive: true, force: true });
  });
  return { directory, requests, open, failOutput: predicate => { rejectOutput = predicate; }, failBeforePrompt: () => { failFirstAppend = true; }, hold: () => { held = true; }, holdWithoutText: () => { held = true; withholdFirstText = true; }, more: text => emitText(text), finish: () => release() };
}

test('Pi host streams with one dispatch per command, follows up, resumes and preserves native Stop outcome', { timeout: 15_000 }, async t => {
  const f = await fixture(t);
  const first = await f.open();
  first.host.createConversation(scope, first.driver.installation);
  f.hold();
  const send = command('pi-first', { kind: 'send', text: 'First question' });
  const receipt = await first.port.submit(send);
  assert.equal(receipt.receipt.state.kind, 'completed');
  const state = () => first.host.inspect(scope).snapshot.document.domain;
  await until(() => state().messages.some(message => message.role === 'assistant' && message.text === 'Hello from Pi' && !message.complete));
  assert.equal(first.driver.capability(command('overlap')).kind, 'unsupported');
  assert.deepEqual(await first.port.submit(send), receipt);
  assert.equal(f.requests.length, 1);
  f.finish();
  await until(() => state().currentRun.kind === 'ended');
  assert.equal(state().currentRun.outcome, 'completed');
  const native = state().currentRun.runId;
  await first.close();
  const reopened = await f.open();
  await reopened.port.submit(command('pi-second', { kind: 'send', text: 'Remember our first question' }));
  const current = () => reopened.host.inspect(scope).snapshot.document.domain;
  await until(() => current().messages.filter(message => message.role === 'assistant').length === 2);
  assert.equal(f.requests[1].messages.filter(message => message.role === 'user').length, 2);
  assert.notEqual(current().currentRun.runId, native);
  const runId = current().currentRun.runId;
  const cancelled = await reopened.port.submit(command('pi-stop', { kind: 'cancel', runId }));
  assert.equal(cancelled.receipt.state.kind, 'completed');
  await until(() => current().currentRun.kind === 'ended');
  assert.equal(current().currentRun.outcome, 'interrupted');
  assert.equal(current().messages.filter(message => message.role === 'assistant').at(-1).text, 'Hello from Pi');
  assert.equal(current().messages.every(message => message.complete), true);
  assert.equal(reopened.driver.capability(command('approval', { kind: 'approve', pendingId: 'none', choiceId: 'accept' })).kind, 'unsupported');
  await reopened.close();
  const files = await readdir(f.directory, { recursive: true, withFileTypes: true });
  for (const entry of files) if (entry.isFile()) {
    assert(!(await readFile(join(entry.parentPath, entry.name))).includes(Buffer.from(key)), 'Provider key must not persist');
  }
});

test('Pi accepts a follow-up as soon as the previous run visibly ends', async t => {
  const f = await fixture(t);
  const current = await f.open();
  current.host.createConversation(scope, current.driver.installation);
  await current.port.submit(command('immediate-first'));
  const state = () => current.host.inspect(scope).snapshot.document.domain;
  await until(() => state().currentRun?.kind === 'ended');
  const previousRunId = state().currentRun.runId;
  assert.equal((await current.port.submit(command('immediate-follow-up'))).receipt.state.kind, 'completed');
  await until(() => state().currentRun?.kind === 'ended' && state().currentRun.runId !== previousRunId);
  assert.equal(state().currentRun.outcome, 'completed');
  assert.equal(f.requests.length, 2);
  assert.equal(f.requests[1].messages.filter(message => message.role === 'user').length, 2);
});

test('a journal-less first failure does not poison native references or transcript ancestry after reopening', async t => {
  const f = await fixture(t);
  const first = await f.open();
  first.host.createConversation(scope, first.driver.installation);
  f.failBeforePrompt();
  const send = command('journal-less-first');
  const receipt = await first.port.submit(send);
  assert.equal(receipt.receipt.state.kind, 'uncertain');
  await until(() => first.host.inspect(scope).snapshot.document.domain.currentRun?.kind === 'ended');
  const failedRunId = first.host.inspect(scope).snapshot.document.domain.currentRun.runId;
  assert.deepEqual((await readdir(join(f.directory, 'pi'))).filter(file => file.endsWith('.jsonl')), []);
  assert.equal(f.requests.length, 0);
  await first.close();
  const reopened = await f.open();
  assert.deepEqual(await reopened.port.submit(send), receipt);
  const next = await reopened.port.submit(command('journal-less-recovery'));
  assert.equal(next.receipt.state.kind, 'completed');
  const state = () => reopened.host.inspect(scope).snapshot.document.domain;
  await until(() => state().currentRun?.kind === 'ended' && state().currentRun.runId !== failedRunId);
  assert.equal(state().currentRun.outcome, 'completed');
  assert.equal(f.requests.length, 1);
  assert.deepEqual(await reopened.port.submit(send), receipt);
  assert.equal(f.requests.length, 1);
});

for (const stage of ['stream', 'seal', 'terminal']) {
  test(`Pi seals partial output and ends failed when ${stage} storage fails once`, async t => {
    const f = await fixture(t);
    const current = await f.open();
    current.host.createConversation(scope, current.driver.installation);
    f.hold();
    if (stage === 'stream') f.failOutput(output => output.events.some(event => event.kind === 'message-updated' && event.role === 'assistant'));
    await current.port.submit(command(`storage-${stage}`));
    const state = () => current.host.inspect(scope).snapshot.document.domain;
    if (stage !== 'stream') {
      await until(() => state().messages.some(message => message.role === 'assistant' && !message.complete));
      f.failOutput(output => output.events.some(event => stage === 'terminal' ? event.kind === 'run-ended'
        : event.kind === 'message-updated' && event.role === 'assistant' && event.complete));
      f.finish();
    }
    await until(() => state().currentRun?.kind === 'ended');
    assert.equal(state().currentRun.outcome, 'failed');
    assert.equal(state().messages.filter(message => message.role === 'assistant').at(-1).text, 'Hello from Pi');
    assert.equal(state().messages.every(message => message.complete), true);
    assert.equal(f.requests.length, 1);
  });
}

test('Pi keeps the run active until native cleanup completes and shutdown waits for final output', async t => {
  const { AgentSession } = await import('@earendil-works/pi-coding-agent');
  const original = AgentSession.prototype.waitForIdle;
  const cleanupEntered = Promise.withResolvers();
  const cleanupReleased = Promise.withResolvers();
  let idleCalls = 0;
  t.mock.method(AgentSession.prototype, 'waitForIdle', async function (...args) {
    await original.apply(this, args);
    if (++idleCalls === 2) { cleanupEntered.resolve(); await cleanupReleased.promise; }
  });
  const f = await fixture(t);
  const current = await f.open();
  current.host.createConversation(scope, current.driver.installation);
  await current.port.submit(command('pending-cleanup'));
  await cleanupEntered.promise;
  assert.equal(current.host.inspect(scope).snapshot.document.domain.currentRun.kind, 'running');
  const closed = current.close();
  cleanupReleased.resolve();
  await closed;
  const reopened = await f.open();
  const state = reopened.host.inspect(scope).snapshot.document.domain;
  assert.equal(state.currentRun.kind, 'ended');
  assert.equal(state.currentRun.outcome, 'completed');
  assert.equal(state.messages.every(message => message.complete), true);
});

test('Pi reports failed cleanup and reserves the conversation until restart', async t => {
  const { AgentSession } = await import('@earendil-works/pi-coding-agent');
  const original = AgentSession.prototype.dispose;
  t.mock.method(AgentSession.prototype, 'dispose', function () {
    original.call(this);
    throw new Error('Native cleanup result unavailable');
  });
  const f = await fixture(t);
  const current = await f.open();
  current.host.createConversation(scope, current.driver.installation);
  await current.port.submit(command('cleanup-failed'));
  const state = () => current.host.inspect(scope).snapshot.document.domain;
  await until(() => state().currentRun?.kind === 'ended');
  assert.equal(state().currentRun.outcome, 'failed');
  assert.match(state().messages.at(-1).text, /Pi session cleanup failed. Restart the host/);
  assert.deepEqual(current.driver.capability(command('cleanup-follow-up')), {
    kind: 'unsupported', reason: 'Pi session cleanup failed. Restart the host before continuing.',
  });
  assert.equal(f.requests.length, 1);
  await assert.rejects(current.close(), /Pi session cleanup failed/);
});

test('Pi refuses to replace a missing journal that was already recorded', async t => {
  const f = await fixture(t);
  const first = await f.open();
  first.host.createConversation(scope, first.driver.installation);
  await first.port.submit(command('persisted-first'));
  await until(() => first.host.inspect(scope).snapshot.document.domain.currentRun?.kind === 'ended');
  await first.close();
  const journals = (await readdir(join(f.directory, 'pi'))).filter(file => file.endsWith('.jsonl'));
  assert.equal(journals.length, 1);
  await rm(join(f.directory, 'pi', journals[0]));
  const reopened = await f.open();
  assert.equal((await reopened.port.submit(command('persisted-missing'))).receipt.state.kind, 'uncertain');
  assert.equal(f.requests.length, 1);
  assert.deepEqual((await readdir(join(f.directory, 'pi'))).filter(file => file.endsWith('.jsonl')), []);
});

test('Pi host closes active output before releasing SQLite ownership', async t => {
  const f = await fixture(t);
  const first = await f.open();
  first.host.createConversation(scope, first.driver.installation);
  f.hold();
  await first.port.submit(command('close-active'));
  await until(() => first.host.inspect(scope).snapshot.document.domain.messages.some(message => message.role === 'assistant'));
  await first.close();
  const reopened = await f.open();
  const document = reopened.host.inspect(scope).snapshot.document.domain;
  assert.equal(document.currentRun.kind, 'ended');
  assert.equal(document.currentRun.outcome, 'connection-lost');
  assert.equal(document.messages.every(message => message.complete), true);
});

test('Pi releases idle sessions across more than 32 conversations and reopens earlier history', { timeout: 20_000 }, async t => {
  const f = await fixture(t);
  const current = await f.open();
  for (let index = 0; index < 36; index++) {
    const conversation = { ...scope, conversationId: `pi-many-${index}` };
    current.host.createConversation(conversation, current.driver.installation);
    const send = command(`many-send-${index}`, { kind: 'send', text: `Question ${index}` }, conversation);
    assert.equal((await current.host.conversation(conversation).submit(send)).receipt.state.kind, 'completed');
    await until(() => current.host.inspect(conversation).snapshot.document.domain.currentRun?.kind === 'ended');
  }
  const first = { ...scope, conversationId: 'pi-many-0' };
  assert.equal((await current.host.conversation(first).submit(command('many-follow-up', { kind: 'send', text: 'Remember question zero' }, first))).receipt.state.kind, 'completed');
  await until(() => current.host.inspect(first).snapshot.document.domain.currentRun?.kind === 'ended');
  assert.equal(f.requests.length, 37);
  assert.equal(f.requests.at(-1).messages.filter(message => message.role === 'user').length, 2);
});

test('the host core imports without evaluating the Pi SDK', async () => {
  const { spawnSync } = await import('node:child_process');
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { registerHooks } from 'node:module';
    registerHooks({ resolve(specifier, context, next) {
      assert(!specifier.startsWith('@earendil-works/'), 'Core must not load native Pi dependencies');
      assert(!specifier.startsWith('@agentui/switchboard-pi'), 'Core must not load Pi adapter');
      return next(specifier, context);
    } });
    const core = await import('@agentui/host');
    assert.equal(typeof core.openLocalHost, 'function');
  `], { cwd: new URL('../../', import.meta.url), encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});


test('Pi Stop works during first-token latency immediately after send admission', { timeout: 10_000 }, async t => {
  const f = await fixture(t);
  const current = await f.open();
  current.host.createConversation(scope, current.driver.installation);
  f.holdWithoutText();
  const submitted = await current.port.submit(command('held-before-text'));
  assert.equal(submitted.receipt.state.kind, 'completed');
  await until(() => f.requests.length === 1);
  const runId = current.host.inspect(scope).snapshot.document.domain.currentRun.runId;
  const stop = await current.port.submit(command('stop-before-text', { kind: 'cancel', runId }));
  assert.equal(stop.kind, 'receipt');
  assert.equal(stop.receipt.state.kind, 'completed');
  await until(() => current.host.inspect(scope).snapshot.document.domain.currentRun.kind === 'ended');
  assert.equal(current.host.inspect(scope).snapshot.document.domain.currentRun.outcome, 'interrupted');
});


test('snapshot exhaustion seals the last saved Pi text across reopen', { timeout: 10_000 }, async t => {
  const f = await fixture(t, { snapshotBytes: 5000 });
  const current = await f.open();
  current.host.createConversation(scope, current.driver.installation);
  f.hold();
  assert.equal((await current.port.submit(command('snapshot-full'))).receipt.state.kind, 'completed');
  const state = () => current.host.inspect(scope).snapshot.document.domain;
  await until(() => state().messages.some(message => message.role === 'assistant' && message.text === 'Hello from Pi' && !message.complete));
  f.more('x'.repeat(6000));
  await until(() => state().currentRun.kind === 'ended');
  assert.equal(state().currentRun.outcome, 'failed');
  assert.equal(state().messages.at(-1).text, 'Hello from Pi');
  assert.equal(state().messages.every(message => message.complete), true);
  await current.close();
  const reopened = await f.open();
  const saved = reopened.host.inspect(scope).snapshot.document.domain;
  assert.equal(saved.currentRun.outcome, 'failed');
  assert.equal(saved.messages.at(-1).text, 'Hello from Pi');
  assert.equal(saved.messages.every(message => message.complete), true);
});
