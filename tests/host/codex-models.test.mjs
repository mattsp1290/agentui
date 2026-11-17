import { SqliteStore } from '../../packages/host/dist/sqlite-store.js';
import { budgets } from '../../packages/host/dist/durable-model.js';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createCodexDriver, openLocalHost } from '@agentui/host';
import { transcriptProjection } from '@agentui/contracts/conversation';
import { command, scope, snapshot } from './fixture.mjs';
import { png } from './image-fixtures.mjs';

function fixture(t, mode = 'stream', readImage) {
  const directory = mkdtempSync(join(tmpdir(), 'agentui-codex-models-'));
  const logPath = join(directory, 'rpc.jsonl'), sessions = [];
  const records = () => existsSync(logPath) ? readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
  const open = async () => {
    let host;
    const owner = createCodexDriver({ cwd: directory, version: '0.167.2', executable: process.execPath,
      args: [fileURLToPath(new URL('./fixtures/codex-agent.mjs', import.meta.url)), logPath, mode],
      append: (conversation, output) => host.append(conversation, output),
      ...(readImage ? { readImage: readImage === true ? (conversation, imageId) => host.readImage(conversation, imageId) : readImage } : {}),
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
  return { open, records, path: join(directory, 'host.sqlite'),
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

test('image modalities enable image input only with a reader and send the image as a data URL', async t => {
  const plain = await fixture(t, 'images').open();
  assert.equal(Object.hasOwn(plain.choices[0].driver, 'imageInput'), false);
  plain.close();
  const f = fixture(t, 'images', true), session = await f.open();
  const [sol, astra] = session.choices;
  assert.deepEqual(sol.model, { id: 'gpt-9.2-sol', label: 'GPT-9.2 Sol', inputModalities: ['text', 'image'] });
  assert.equal(sol.driver.imageInput, true);
  assert.deepEqual(astra.model, { id: 'gpt-9.1-astra', label: 'GPT-9.1 Astra' });
  assert.equal(Object.hasOwn(astra.driver, 'imageInput'), false);
  session.host.createConversation(scope, sol.driver.installation);
  const bytes = png(), attachment = session.host.uploadImage(scope, 'owner', randomUUID(), 'Screen.png', bytes);
  assert.equal((await session.port.submit(command('image', { kind: 'send', text: 'Look', imageId: attachment.imageId }))).receipt.state.kind, 'completed');
  const turnStart = f.records().find(value => value.direction === 'in' && value.method === 'turn/start').params;
  assert.deepEqual(turnStart.input, [{ type: 'text', text: 'Look', text_elements: [] }, { type: 'image', url: `data:image/png;base64,${bytes.toString('base64')}` }]);
  const user = session.host.inspect(scope).snapshot.document.domain.messages.find(message => message.role === 'user');
  assert.deepEqual(user.image, attachment);
  assert.equal(JSON.stringify(session.host.inspect(scope).snapshot).includes(bytes.toString('base64')), false);
  const run = session.host.inspect(scope).snapshot.document.domain.currentRun.runId;
  f.finish(run); await f.ended(session.port);
});

test('a Codex model without image input refuses image sends before storing a command', async t => {
  const f = fixture(t, 'images', true), session = await f.open();
  const astra = session.choices.find(choice => choice.model.id === 'gpt-9.1-astra');
  session.host.createConversation(scope, astra.driver.installation);
  assert.throws(() => session.host.uploadImage(scope, 'owner', randomUUID(), 'Screen.png', png()), { code: 'image-unsupported' });
  const store = new SqliteStore(f.path, transcriptProjection, budgets());
  let attachment;
  try { attachment = store.uploadImage(scope, 'retained-fixture', randomUUID(), 'Screen.png', png(), { kind: 'supported', format: 'png-jpeg-v1' }); }
  finally { store.close(); }

  assert.deepEqual(await session.port.submit(command('image', { kind: 'send', text: 'Look', imageId: attachment.imageId })), { kind: 'rejected', reason: 'This model cannot read images.' });
  assert.equal(await session.port.receipt('image'), null);
  assert.equal(f.records().some(value => value.direction === 'in' && (value.method === 'thread/start' || value.method === 'turn/start')), false);
});

test('text-only turn start parameters stay unchanged on an image-capable model', async t => {
  const f = fixture(t, 'images', true), session = await f.open();
  session.host.createConversation(scope, session.choices[0].driver.installation);
  assert.equal((await session.port.submit(command('text'))).receipt.state.kind, 'completed');
  const turnStart = f.records().find(value => value.direction === 'in' && value.method === 'turn/start').params;
  assert.deepEqual(turnStart, { threadId: turnStart.threadId, model: 'gpt-9.2-sol', input: [{ type: 'text', text: 'hello', text_elements: [] }], clientUserMessageId: 'text' });
  f.finish(session.host.inspect(scope).snapshot.document.domain.currentRun.runId); await f.ended(session.port);
});

test('an unreadable image is not dispatched and sends no thread or turn request', async t => {
  const f = fixture(t, 'images', () => { throw new Error('/private/path decoder detail'); }), session = await f.open();
  session.host.createConversation(scope, session.choices[0].driver.installation);
  const attachment = session.host.uploadImage(scope, 'owner', randomUUID(), 'Screen.png', png());
  const result = await session.port.submit(command('image', { kind: 'send', text: '', imageId: attachment.imageId }));
  assert.deepEqual(result.receipt.state, { kind: 'not-dispatched', reason: 'This image could not be read. Attach it again.' });
  const methods = f.records().filter(value => value.direction === 'in').map(value => value.method);
  assert.equal(methods.filter(method => method === 'initialize').length, 1);
  assert.equal(methods.some(method => method === 'thread/start' || method === 'turn/start'), false);
  assert.equal(session.host.inspect(scope).snapshot.document.domain.messages.length, 0);
  assert.equal((await session.port.submit(command('after'))).receipt.state.kind, 'completed');
  f.finish(session.host.inspect(scope).snapshot.document.domain.currentRun.runId); await f.ended(session.port);
});
