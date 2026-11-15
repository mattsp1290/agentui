import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createCodexDriver, openLocalHost } from '@agentui/host';
import { transcriptProjection } from '@agentui/contracts/conversation';
import { command, scope, snapshot, until } from './fixture.mjs';

function fixture(t, mode = 'stream') {
  const directory = mkdtempSync(join(tmpdir(), 'agentui-codex-models-'));
  const logPath = join(directory, 'rpc.jsonl'), sessions = [];
  const records = () => existsSync(logPath) ? readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
  const open = async () => {
    let host;
    const owner = createCodexDriver({ cwd: directory, version: '0.167.2', executable: process.execPath,
      args: [fileURLToPath(new URL('./fixtures/codex-agent.mjs', import.meta.url)), logPath, mode],
      append: (conversation, output) => host.append(conversation, output),
    });
    const session = { owner, close() { owner.close(); host?.close(); } };
    sessions.push(session);
    const choices = await owner.models();
    host = openLocalHost({ path: join(directory, 'host.sqlite'), projection: transcriptProjection,
      driver: [owner, ...choices.map(choice => choice.driver)], authorize: () => true });
    return { ...session, host, choices, port: host.conversation(scope) };
  };
  t.after(async () => {
    for (const session of sessions) session.close();
    await new Promise(resolve => setTimeout(resolve, 30));
    rmSync(directory, { recursive: true, force: true });
  });
  return { open, records,
    finish(id) { writeFileSync(`${logPath}.complete-${id}`, ''); },
    async ended(port) {
      for (let attempt = 0; attempt < 200; attempt++) {
        const value = await snapshot(port, transcriptProjection.version);
        if (value.document.domain.currentRun?.kind === 'ended') return;
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      assert.fail('Model turn did not complete');
    },
  };
}

test('discovers every visible model page once and shares one Codex process', async t => {
  const f = fixture(t), session = await f.open();
  assert.deepEqual(session.choices.map(choice => choice.model), [
    { id: 'remote-sol', label: 'Remote Sol' }, { id: 'remote-astra', label: 'Remote Astra' },
  ]);
  assert.equal(await session.owner.models(), session.choices);
  assert.equal(new Set([session.owner.installation, ...session.choices.map(choice => choice.driver.installation)].map(value => value.installationId)).size, 3);
  const incoming = f.records().filter(value => value.direction === 'in');
  assert.equal(incoming.filter(value => value.method === 'initialize').length, 1);
  assert.deepEqual(incoming.filter(value => value.method === 'model/list').map(value => value.params), [
    { includeHidden: false }, { includeHidden: false, cursor: 'next-model-page' },
  ]);
  assert.equal(new Set(incoming.map(value => value.pid)).size, 1);
});

for (const mode of ['models-repeat', 'models-malformed', 'models-error']) {
  test(`catalog failure ${mode} rejects instead of returning only the host default`, async t => {
    await assert.rejects(fixture(t, mode).open(), /model|catalog|fixture/i);
  });
}

test('selected model survives persisted routing and reaches thread start, resume, and turns', async t => {
  const f = fixture(t), first = await f.open();
  const selected = first.choices.find(choice => choice.model.id === 'remote-astra');
  first.host.createConversation(scope, selected.driver.installation);
  assert.equal((await first.port.submit(command('first-model'))).receipt.state.kind, 'completed');
  const firstRun = first.host.inspect(scope).snapshot.document.domain.currentRun.runId;
  f.finish(firstRun);
  await f.ended(first.port);
  first.close();
  await first.host.drained;
  const reopened = await f.open();
  assert.deepEqual(reopened.host.installation(scope), selected.driver.installation);
  assert.equal((await reopened.port.submit(command('resumed-model'))).receipt.state.kind, 'completed');
  const run = reopened.host.inspect(scope).snapshot.document.domain.currentRun;
  assert.equal(run.kind, 'running');
  const incoming = f.records().filter(value => value.direction === 'in');
  for (const method of ['thread/start', 'thread/resume', 'turn/start']) {
    const requests = incoming.filter(value => value.method === method);
    assert.ok(requests.length > 0, method);
    assert.ok(requests.every(value => value.params.model === 'remote-astra'), method);
  }
  f.finish(run.runId);
  await f.ended(reopened.port);
});
