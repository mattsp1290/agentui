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
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'agentui-pi-driver-'));
  const requests = [];
  let release;
  let held = false;
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    assert.equal(String(input), 'https://opencode.ai/inference/go/openai/v1/chat/completions');
    assert.equal(new Headers(init.headers).get('authorization'), `Bearer ${key}`);
    requests.push(JSON.parse(init.body));
    return new Response(new ReadableStream({ start(controller) {
      const emit = value => controller.enqueue(new TextEncoder().encode(value));
      emit(frame('Hello from Pi'));
      if (!held) { emit(frame(null, 'stop')); emit('data: [DONE]\n\n'); controller.close(); return; }
      release = () => { emit(frame(null, 'stop')); emit('data: [DONE]\n\n'); controller.close(); };
      init.signal?.addEventListener('abort', () => controller.error(new DOMException('Aborted', 'AbortError')), { once: true });
    } }), { headers: { 'content-type': 'text/event-stream' } });
  };
  const instances = [];
  const open = async () => {
    let host;
    const driver = await createPiDriver({ cwd: directory, sessionDirectory: join(directory, 'pi'), apiKey: key,
      append: (value, output) => host.append(value, output) });
    host = openLocalHost({ path: join(directory, 'host.sqlite'), projection: transcriptProjection, driver, authorize: () => true });
    const instance = { host, driver, port: host.conversation(scope), async close() { await driver.close(); host.close(); await host.drained; } };
    instances.push(instance);
    return instance;
  };
  t.after(async () => {
    for (const instance of instances) await instance.close();
    globalThis.fetch = original;
    await rm(directory, { recursive: true, force: true });
  });
  return { directory, requests, open, hold: () => { held = true; }, finish: () => release() };
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
    await until(() => current.host.inspect(conversation).snapshot.document.domain.currentRun?.kind === 'ended' &&
      current.driver.capability(command(`next-${index}`, { kind: 'send', text: 'Next' }, conversation)).kind === 'supported');
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
