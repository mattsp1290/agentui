import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { openLocalHost } from '@agentui/host';
import { createClaudeSdkDriver } from '@agentui/host/claude-sdk';
import { CLAUDE_SDK_RUNTIMES } from '@agentui/contracts/compatibility';
import { transcriptProjection } from '@agentui/contracts/conversation';
import { command, scope, until } from './fixture.mjs';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'agentui-claude-driver-'));
  const executable = join(directory, 'claude.mjs');
  const fixtureUrl = new URL('./fixtures/claude-sdk-exec.mjs', import.meta.url).href;
  await writeFile(executable, `#!${process.execPath}\nawait import(${JSON.stringify(fixtureUrl)});\n`, { mode: 0o700 });
  const sessions = [];
  let failOutput;
  let failuresRemaining = 0;
  const open = (model = 'sonnet') => {
    let host;
    const driver = createClaudeSdkDriver({ cwd: directory, sessionDirectory: directory, apiKey: 'fixture-api-key-must-never-persist', model, claudePathOverride: executable,
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

for (const model of ['opus', 'sonnet']) {
  test(`Claude ${model} persists native admission with resolved model and resumes the same thread after restart`, { timeout: 15_000 }, async t => {
    const f = await fixture(t);
    const first = f.open(model);
    first.host.createConversation(scope, first.driver.installation);
    assert.equal(first.driver.installation.binding.nativeFormat, CLAUDE_SDK_RUNTIMES[model].format);
    assert.equal(first.driver.installation.binding.account, `anthropic-api-key:${model}`);
    const send = command(`claude-${model}-first`, { kind: 'send', text: 'hold-after-output' });
    const receipt = await first.port.submit(send);
    assert.equal(receipt.receipt.state.kind, 'completed');
    const db = new DatabaseSync(join(f.directory, 'host.sqlite'), { readOnly: true });
    const record = JSON.parse(db.prepare('SELECT observation FROM commands').get().observation);
    db.close();
    assert.equal(record.evidence.observation.namespace, 'claude-sdk');
    assert.equal(record.evidence.nativeOperation.namespace, 'claude-sdk-session');
    assert.equal(record.evidence.observation.data.model, `claude-${model}-fixture`);
    await until(() => first.state().messages.some(message => message.role === 'assistant' && !message.complete));
    assert.deepEqual(await first.port.submit(send), receipt);
    assert.equal((await f.calls()).length, 1);
    await f.finish();
    await until(() => first.state().currentRun.kind === 'ended');
    const previous = first.state().currentRun.runId;
    await first.close();
    const reopened = f.open(model);
    assert.equal((await reopened.port.submit(command(`claude-${model}-next`))).receipt.state.kind, 'completed');
    await until(() => reopened.state().currentRun.kind === 'ended' && reopened.state().currentRun.runId !== previous);
    assert.deepEqual(reopened.state().messages.filter(message => message.role === 'assistant').map(message => message.text),
      ['First Claude reply', 'Resumed Claude reply']);
    const calls = await f.calls();
    assert.equal(calls.length, 2);
    assert(calls[1].args.includes('--resume=00000000-0000-4000-8000-000000000001'));
    assert(calls.every(call => call.args.includes(`--model=${model}`)));
    await reopened.close();
    const persisted = await readFile(join(f.directory, 'host.sqlite'));
    assert.equal(persisted.includes(Buffer.from('fixture-api-key-must-never-persist')), false);
  });
}

test('Claude Stop is durable and retry never starts another turn', { timeout: 10_000 }, async t => {
  const f = await fixture(t);
  const session = f.open();
  session.host.createConversation(scope, session.driver.installation);
  const send = command('claude-held', { kind: 'send', text: 'wait-without-output' });
  const started = await session.port.submit(send);
  assert.equal(started.receipt.state.kind, 'completed');
  const runId = session.state().currentRun.runId;
  const stop = command('claude-stop', { kind: 'cancel', runId });
  const stopped = await session.port.submit(stop);
  assert.equal(stopped.receipt.state.kind, 'completed');
  await until(() => session.state().currentRun.kind === 'ended');
  assert.equal(session.state().currentRun.outcome, 'interrupted');
  assert.deepEqual(session.state().messages.filter(message => message.role === 'assistant'), []);
  assert.deepEqual(await session.port.submit(stop), stopped);
  assert.deepEqual(await session.port.submit(send), started);
  assert.equal((await f.calls()).length, 1);
});

test('Claude family installations cannot dispatch into another family', async t => {
  const f = await fixture(t);
  const session = f.open('sonnet');
  const other = f.open('opus');
  assert.notDeepEqual(session.driver.installation, other.driver.installation);
  session.host.createConversation(scope, other.driver.installation);
  const result = await session.port.submit(command('wrong-family'));
  assert.equal(result.kind, 'rejected');
  await assert.rejects(f.calls(), { code: 'ENOENT' });
});

test('Claude storage failure during admission never exposes an unrecorded session', { timeout: 10_000 }, async t => {
  const f = await fixture(t);
  const session = f.open();
  session.host.createConversation(scope, session.driver.installation);
  f.failOutput(output => output.events.some(event => event.kind === 'run-started'));
  const send = command('claude-admission-failure', { kind: 'send', text: 'hold-after-output' });
  const receipt = await session.port.submit(send);
  assert.equal(receipt.receipt.state.kind, 'uncertain');
  assert.equal(session.state().currentRun, null);
  assert.deepEqual(session.state().messages, []);
  assert.deepEqual(await session.port.submit(send), receipt);
  assert.equal((await f.calls()).length, 1);
});

test('Claude failed Stop write leaves the next explicit Stop actionable', { timeout: 10_000 }, async t => {
  const f = await fixture(t);
  const session = f.open();
  session.host.createConversation(scope, session.driver.installation);
  await session.port.submit(command('claude-stop-send', { kind: 'send', text: 'wait-without-output' }));
  const runId = session.state().currentRun.runId;
  f.failOutput(output => output.events.some(event => event.kind === 'run-stop-requested'));
  const failed = await session.port.submit(command('claude-stop-storage', { kind: 'cancel', runId }));
  assert.equal(failed.receipt.state.kind, 'rejected');
  assert.equal(session.state().currentRun.kind, 'running');
  const stop = command('claude-stop-retry', { kind: 'cancel', runId });
  assert.equal(session.driver.capability(stop).kind, 'supported');
  assert.equal((await session.port.submit(stop)).receipt.state.kind, 'completed');
  await until(() => session.state().currentRun.kind === 'ended');
  assert.equal(session.state().currentRun.outcome, 'interrupted');
});

test('Claude diagnostic text before admission is suppressed and the uncertain command is never replayed', { timeout: 10_000 }, async t => {
  const f = await fixture(t);
  const session = f.open();
  session.host.createConversation(scope, session.driver.installation);
  const send = command('claude-native-failure', { kind: 'send', text: 'fail-before-admission' });
  const result = await session.port.submit(send);
  assert.equal(result.receipt.state.kind, 'uncertain');
  assert.deepEqual(await session.port.submit(send), result);
  assert.deepEqual(session.state().messages, []);
  assert.equal(session.state().currentRun, null);
  assert.equal(JSON.stringify(result).includes('fixture-api-key-must-never-persist'), false);
  assert.equal((await f.calls()).length, 1);
  await session.close();
  assert.equal((await readFile(join(f.directory, 'host.sqlite'))).includes(Buffer.from('fixture-api-key-must-never-persist')), false);
});

test('Claude output storage failure preserves saved text and ends the run as failed', { timeout: 10_000 }, async t => {
  const f = await fixture(t);
  const session = f.open();
  session.host.createConversation(scope, session.driver.installation);
  await session.port.submit(command('claude-output-storage', { kind: 'send', text: 'hold-after-output' }));
  await until(() => session.state().messages.some(message => message.role === 'assistant' && !message.complete));
  f.failOutput(output => output.events.some(event => event.kind === 'message-updated' && event.role === 'assistant' && event.complete));
  await f.finish();
  await until(() => session.state().currentRun.kind === 'ended');
  assert.equal(session.state().currentRun.outcome, 'failed');
  assert.equal(session.state().messages.at(-1).text, 'First Claude reply');
  assert.equal(session.state().messages.every(message => message.complete), true);
});
