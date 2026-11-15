import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { openLocalHost } from '@agentui/host';
import { createCodexSdkDriver } from '@agentui/host/codex-sdk';
import { CODEX_RUNTIME } from '@agentui/contracts/compatibility';
import { canonicalJson } from '@agentui/contracts';
import { createConversationStore } from '@agentui/client';
import { transcriptProjection } from '@agentui/contracts/conversation';
import { command, scope, until } from './fixture.mjs';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'agentui-sdk-driver-'));
  const executable = join(directory, 'codex.mjs');
  const fixtureUrl = new URL('./fixtures/codex-sdk-exec.mjs', import.meta.url).href;
  await writeFile(executable, `#!${process.execPath}\nawait import(${JSON.stringify(fixtureUrl)});\n`, { mode: 0o700 });
  const sessions = [];
  let failOutput;
  let failuresRemaining = 0;
  const open = () => {
    let host;
    const driver = createCodexSdkDriver({ cwd: directory, codexHome: directory, codexPathOverride: executable,
      currentRunId: value => host.inspect(value).snapshot.document.domain.currentRun?.runId ?? null,
      append(value, output) {
        if (failOutput?.(output)) {
          if (--failuresRemaining === 0) failOutput = undefined;
          throw new Error('Controlled storage failure');
        }
        host.append(value, output);
      },
    });
    host = openLocalHost({ path: join(directory, 'host.sqlite'), projection: transcriptProjection, driver, authorize: () => true });
    let closed = false;
    const session = { host, driver, port: host.conversation(scope), state: () => host.inspect(scope).snapshot.document.domain,
      async close() {
        if (closed) return;
        closed = true;
        await driver.close(); host.close(); await host.drained;
      },
    };
    sessions.push(session);
    return session;
  };
  t.after(async () => {
    for (const session of sessions) await session.close();
    await rm(directory, { recursive: true, force: true });
  });
  const calls = async () => (await readFile(join(directory, 'calls.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
  return { directory, open, calls, failOutput: (predicate, count = 1) => { failOutput = predicate; failuresRemaining = count; }, finish: () => writeFile(join(directory, 'finish'), '') };
}

test('SDK chat persists native admission, publishes message events and resumes the same owned thread after restart', { timeout: 15_000 }, async t => {
  const f = await fixture(t);
  const first = f.open();
  first.host.createConversation(scope, first.driver.installation);
  const send = command('sdk-first', { kind: 'send', text: 'hold-after-output' });
  const receipt = await first.port.submit(send);
  assert.equal(receipt.receipt.state.kind, 'completed');
  await until(() => first.state().messages.some(message => message.role === 'assistant' && message.text === 'First SDK reply' && !message.complete));
  assert.equal(first.state().currentRun.kind, 'running');
  assert.equal(first.driver.capability(command('overlap')).kind, 'unsupported');
  assert.deepEqual(await first.port.submit(send), receipt);
  assert.equal((await f.calls()).length, 1);
  await f.finish();
  await until(() => first.state().currentRun.kind === 'ended');
  const previous = first.state().currentRun.runId;
  await first.close();
  const reopened = f.open();
  assert.equal((await reopened.port.submit(command('sdk-next'))).receipt.state.kind, 'completed');
  await until(() => reopened.state().currentRun.kind === 'ended' && reopened.state().currentRun.runId !== previous);
  assert.deepEqual(reopened.state().messages.filter(message => message.role === 'assistant').map(message => message.text), ['First SDK reply', 'Resumed SDK reply']);
  const calls = await f.calls();
  assert.equal(calls.length, 2);
  assert.equal(calls[0].args.includes('resume'), false);
  assert.deepEqual(calls[1].args.slice(-2), ['resume', '00000000-0000-4000-8000-000000000001']);
  assert(calls.every(call => call.args.includes('gpt-6.1-sol')));
  assert.equal(reopened.driver.capability(command('approve', { kind: 'approve', pendingId: 'none', choiceId: 'accept' })).kind, 'unsupported');
});

test('SDK Stop ends an admitted run without inventing assistant text and an exact retry never starts another turn', { timeout: 10_000 }, async t => {
  const f = await fixture(t);
  const session = f.open();
  session.host.createConversation(scope, session.driver.installation);
  const send = command('sdk-held', { kind: 'send', text: 'wait-without-output' });
  const started = await session.port.submit(send);
  assert.equal(started.receipt.state.kind, 'completed');
  const runId = session.state().currentRun.runId;
  const stop = command('sdk-stop', { kind: 'cancel', runId });
  const stopped = await session.port.submit(stop);
  assert.equal(stopped.receipt.state.kind, 'completed');
  await until(() => session.state().currentRun.kind === 'ended');
  assert.equal(session.state().currentRun.outcome, 'interrupted');
  assert.deepEqual(session.state().messages.filter(message => message.role === 'assistant'), []);
  assert.deepEqual(await session.port.submit(stop), stopped);
  assert.deepEqual(await session.port.submit(send), started);
  assert.equal((await f.calls()).length, 1);
  assert.equal((await session.port.submit(command('sdk-follow-stop'))).receipt.state.kind, 'completed');
  await until(() => session.state().currentRun.kind === 'ended' && session.state().currentRun.runId !== runId);
  assert.equal((await f.calls()).length, 2);
});

test('an app-server conversation cannot reach the SDK route', async t => {
  const f = await fixture(t);
  const session = f.open();
  session.host.createConversation(scope, { installationId: 'codex-local-v1', binding: {
    engine: CODEX_RUNTIME.engine, nativeVersion: CODEX_RUNTIME.version, nativeFormat: CODEX_RUNTIME.format,
    account: 'local', authorizedScope: f.directory,
  } });
  const send = command('old-app-server');
  const result = await session.port.submit(send);
  assert.equal(result.kind, 'rejected');
  assert.match(result.reason, /different agent or workspace/);
  assert.equal(await session.port.receipt(send.clientCommandId), null);
  await assert.rejects(f.calls(), { code: 'ENOENT' });
});

test('failure before SDK admission retains uncertainty and does not replay the command', { timeout: 10_000 }, async t => {
  const f = await fixture(t);
  const session = f.open();
  session.host.createConversation(scope, session.driver.installation);
  const send = command('sdk-failed', { kind: 'send', text: 'fail-before-admission' });
  const receipt = await session.port.submit(send);
  assert.equal(receipt.receipt.state.kind, 'uncertain');
  assert.deepEqual(await session.port.submit(send), receipt);
  assert.equal(session.state().currentRun, null);
  assert.equal((await f.calls()).length, 1);
  assert.equal((await session.port.submit(command('sdk-recover'))).receipt.state.kind, 'completed');
  await until(() => session.state().currentRun?.kind === 'ended');
  assert.equal((await f.calls())[1].args.includes('resume'), false);
});

test('a transient output storage failure retains saved text and ends the SDK run as failed', { timeout: 10_000 }, async t => {
  const f = await fixture(t);
  const session = f.open();
  session.host.createConversation(scope, session.driver.installation);
  await session.port.submit(command('sdk-storage', { kind: 'send', text: 'hold-after-output' }));
  await until(() => session.state().messages.some(message => message.role === 'assistant' && !message.complete));
  f.failOutput(output => output.events.some(event => event.kind === 'message-updated' && event.role === 'assistant' && event.complete));
  await f.finish();
  await until(() => session.state().currentRun.kind === 'ended');
  assert.equal(session.state().currentRun.outcome, 'failed');
  assert.equal(session.state().messages.at(-1).text, 'First SDK reply');
  assert.equal(session.state().messages.every(message => message.complete), true);
});

test('storage failure at native admission publishes no phantom response or continuation', { timeout: 10_000 }, async t => {
  const f = await fixture(t);
  const session = f.open();
  session.host.createConversation(scope, session.driver.installation);
  f.failOutput(output => output.runs.length > 0);
  const send = command('sdk-admission-storage', { kind: 'send', text: 'hold-after-output' });
  const receipt = await session.port.submit(send);
  assert.equal(receipt.receipt.state.kind, 'uncertain');
  assert.deepEqual(session.state().messages, []);
  assert.equal(session.state().currentRun, null);
  assert.deepEqual(await session.port.submit(send), receipt);
  assert.equal((await f.calls()).length, 1);
  await f.finish();
  assert.equal((await session.port.submit(command('after-admission-storage'))).receipt.state.kind, 'completed');
  await until(() => session.state().currentRun?.kind === 'ended');
  assert.equal((await f.calls())[1].args.includes('resume'), false);
});

test('a failed Stop request write does not poison a later explicit Stop', { timeout: 10_000 }, async t => {
  const f = await fixture(t);
  const session = f.open();
  session.host.createConversation(scope, session.driver.installation);
  await session.port.submit(command('sdk-stop-storage-send', { kind: 'send', text: 'wait-without-output' }));
  const runId = session.state().currentRun.runId;
  f.failOutput(output => output.events.some(event => event.kind === 'run-stop-requested'));
  const failed = await session.port.submit(command('sdk-stop-storage-failed', { kind: 'cancel', runId }));
  assert.equal(failed.receipt.state.kind, 'rejected');
  assert.equal(session.state().currentRun.kind, 'running');
  const stop = command('sdk-stop-storage-retry', { kind: 'cancel', runId });
  assert.equal(session.driver.capability(stop).kind, 'supported');
  assert.equal((await session.port.submit(stop)).receipt.state.kind, 'completed');
  await until(() => session.state().currentRun.kind === 'ended');
  assert.equal(session.state().currentRun.outcome, 'interrupted');
});

test('a maximum-size command whose stored user event would overflow is rejected before native execution', async t => {
  const f = await fixture(t);
  const session = f.open();
  session.host.createConversation(scope, session.driver.installation);
  const blank = command('sdk-size-boundary', { kind: 'send', text: '' });
  const send = command('sdk-size-boundary', { kind: 'send', text: 'a'.repeat(64_000 - Buffer.byteLength(canonicalJson(blank))) });
  assert.equal(Buffer.byteLength(canonicalJson(send)), 64_000);
  assert.deepEqual(await session.port.submit(send), { kind: 'rejected', reason: 'message-too-large' });
  assert.equal(await session.port.receipt(send.clientCommandId), null);
  assert.deepEqual(session.state().messages, []);
  assert.equal(session.state().currentRun, null);
  await assert.rejects(f.calls(), { code: 'ENOENT' });
});

test('whitespace-only text is rejected before SDK dispatch for API clients', async t => {
  const f = await fixture(t);
  const session = f.open();
  session.host.createConversation(scope, session.driver.installation);
  const send = command('sdk-whitespace', { kind: 'send', text: ' \t\n ' });
  assert.deepEqual(await session.port.submit(send), { kind: 'rejected', reason: 'invalid-message' });
  assert.equal(await session.port.receipt(send.clientCommandId), null);
  await assert.rejects(f.calls(), { code: 'ENOENT' });
});

test('losing ChatGPT login after startup rejects before sending and preserves the native thread', { timeout: 10_000 }, async t => {
  const f = await fixture(t);
  const session = f.open();
  session.host.createConversation(scope, session.driver.installation);
  await session.port.submit(command('sdk-login-first'));
  await until(() => session.state().currentRun?.kind === 'ended');
  const previous = session.state().currentRun.runId;
  await writeFile(join(f.directory, 'signed-out'), '');
  const send = command('sdk-signed-out');
  const result = await session.port.submit(send);
  assert.equal(result.receipt.state.kind, 'rejected');
  assert.match(result.receipt.state.reason, /CLI version and ChatGPT login/);
  assert.equal((await f.calls()).length, 1);
  assert.equal(session.state().currentRun.runId, previous);
  assert.deepEqual(await session.port.submit(send), result);
  await rm(join(f.directory, 'signed-out'));
  assert.equal((await session.port.submit(command('sdk-signed-in'))).receipt.state.kind, 'completed');
  await until(() => session.state().currentRun.kind === 'ended' && session.state().currentRun.runId !== previous);
  assert((await f.calls())[1].args.includes('resume'));
});

test('the real client clears a failed Stop from its outbox so Stop remains actionable', { timeout: 10_000 }, async t => {
  let client;
  t.after(() => client?.disconnect());
  const f = await fixture(t);
  const session = f.open();
  session.host.createConversation(scope, session.driver.installation);
  let saved = null, serial = 0;
  client = createConversationStore({ scope, projection: transcriptProjection, port: session.port,
    createCommandId: () => `sdk-client-${++serial}`,
    drafts: { async load() { return saved; }, async save(value) { saved = structuredClone(value); } },
  });
  await client.connect();
  await until(() => client.getSnapshot().connection.kind === 'connected');
  await client.setDraft('wait-without-output');
  await client.send();
  await until(() => client.getSnapshot().document.domain.currentRun?.kind === 'running');
  const runId = client.getSnapshot().document.domain.currentRun.runId;
  f.failOutput(output => output.events.some(event => event.kind === 'run-stop-requested'));
  const failed = await client.cancel(runId);
  assert.equal(failed.receipt.state.kind, 'rejected');
  assert.match(failed.receipt.state.reason, /Try Stop again/);
  assert.deepEqual(client.getSnapshot().outbox, []);
  assert.deepEqual(client.getSnapshot().submitting, []);
  assert.equal(client.getSnapshot().document.domain.currentRun.kind, 'running');
  assert.equal((await client.cancel(runId)).receipt.state.kind, 'completed');
  await until(() => client.getSnapshot().document.domain.currentRun.kind === 'ended');
  assert.equal(client.getSnapshot().document.domain.currentRun.outcome, 'interrupted');
  assert.deepEqual(client.getSnapshot().outbox, []);
  assert.equal((await f.calls()).length, 1);
});

test('persistent terminal storage failure blocks another native turn until host restart', { timeout: 10_000 }, async t => {
  const f = await fixture(t);
  const session = f.open();
  session.host.createConversation(scope, session.driver.installation);
  await session.port.submit(command('sdk-end-storage-send', { kind: 'send', text: 'hold-after-output' }));
  const next = command('sdk-end-storage-next');
  f.failOutput(output => output.events.some(event => event.kind === 'run-ended'), 2);
  await f.finish();
  await until(() => session.driver.capability(next).reason?.includes('save the end'));
  assert.equal(session.state().currentRun.kind, 'running');
  assert.deepEqual(await session.port.submit(next), { kind: 'rejected', reason: 'Codex could not save the end of this response. Restart the host before continuing.' });
  assert.equal(await session.port.receipt(next.clientCommandId), null);
  assert.equal((await f.calls()).length, 1);
});
