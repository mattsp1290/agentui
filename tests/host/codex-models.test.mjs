import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createCodexDriver, openLocalHost } from '@agentui/host';
import { transcriptProjection } from '@agentui/contracts/conversation';
import { command, scope, snapshot } from './fixture.mjs';

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
    { id: 'gpt-9.2-sol', label: 'GPT-9.2 Sol' }, { id: 'gpt-9.1-astra', label: 'GPT-9.1 Astra' },
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
    await assert.rejects(fixture(t, mode).open(), /invalid model catalog|repeated a model catalog cursor|Fixture model catalog unavailable/);
  });
}

test('selected model survives persisted routing and reaches thread start, resume, and turns', async t => {
  const f = fixture(t), first = await f.open();
  const selected = first.choices.find(choice => choice.model.id === 'gpt-9.1-astra');
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
    assert.ok(requests.every(value => value.params.model === 'gpt-9.1-astra'), method);
  }
  f.finish(run.runId);
  await f.ended(reopened.port);
});

test('latest three numeric generations follow the catalog order while older models keep routing', async () => {
  const { discoverCodexModels } = await import('../../packages/host/dist/codex-models.js');
  const ids = ['gpt-12.1-sol', 'gpt-12-astra', 'gpt-12.1-terra', 'gpt-11.10-sol', 'gpt-11.9-sol', 'gpt-2-sol', 'custom-latest'];
  const catalog = await discoverCodexModels(async () => ({
    data: ids.map(model => ({ model, displayName: model, hidden: false, isDefault: model === 'gpt-2-sol' })), nextCursor: null,
  }));
  assert.deepEqual(catalog.map(entry => entry.model.id), ids);
  assert.deepEqual(catalog.filter(entry => entry.selectable).map(entry => entry.model.id), ids.filter(id => !['gpt-11.9-sol', 'gpt-2-sol'].includes(id)));
  assert.equal(catalog.find(entry => entry.model.id === 'gpt-2-sol').isDefault, true);
  const future = await discoverCodexModels(async () => ({
    data: [{ model: 'gpt-13-sol', displayName: 'Future', hidden: false }, ...ids.map(model => ({ model, displayName: model, hidden: false }))], nextCursor: null,
  }));
  assert.deepEqual(future.filter(entry => entry.selectable).map(entry => entry.model.id), ['gpt-13-sol', 'gpt-12.1-sol', 'gpt-12-astra', 'gpt-12.1-terra', 'custom-latest']);
});
