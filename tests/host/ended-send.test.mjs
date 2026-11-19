import assert from 'node:assert/strict';
import { join } from 'node:path';
import test from 'node:test';
import { transcriptProjection } from '@agentui/contracts/conversation';
import { SqliteStore } from '../../packages/host/dist/sqlite-store.js';
import { budgets } from '../../packages/host/dist/durable-model.js';
import { actualInput, aguiExtension, create, fixture, offered, send } from '../application/provider-send-fixture.mjs';

const run = 'shared-run';
// An offered send settles before the later plain send, and both name the run the transcript shows as ended.
async function ended(t) {
  const a = aguiExtension({ request: text => ({ ...actualInput(text), threadId: `thread-${text}`, runId: run }),
    submit: (operation, { effect }) => effect(operation, operation.request.threadId === 'thread-Hello' ? 'completed' : 'accepted', run) });
  const f = await fixture(t, [a]), scope = await create(f);
  assert.equal((await f.client.conversation(scope).submit(offered(scope))).receipt.state.kind, 'completed');
  assert.equal((await f.client.conversation(scope).submit(send(scope, 'send', 'Later'))).receipt.state.kind, 'accepted');
  const store = new SqliteStore(join(f.directory, 'host.sqlite'), transcriptProjection, budgets()); t.after(() => store.close());
  store.db.prepare("UPDATE conversations SET document=json_set(document, '$.domain.currentRun', json(?)) WHERE conversation=?")
    .run(JSON.stringify({ kind: 'ended', runId: run, outcome: 'completed' }), scope.conversationId);
  const earlier = (id, columns) => {
    const values = { intent: 'intent', target: 'target', observation: 'observation', ...columns };
    store.db.prepare(`INSERT INTO commands(host,conversation,id,operation,intent,target,observation,receipt)
      SELECT host,conversation,?,?,${values.intent},${values.target},${values.observation},receipt FROM commands WHERE id='send'`).run(id, `${id}-operation`);
    store.db.prepare("UPDATE commands SET rowid=(SELECT MAX(rowid)+1 FROM commands) WHERE id='send'").run();
  };
  return { scope, store, earlier };
}
const offeredRunId = store => store.db.prepare("SELECT json_extract(observation, '$.evidence.source.run.identity.runId') AS id FROM commands WHERE id='offered'").get().id;

test('ended send skips an offered row that names the run and returns the next plain match', async t => {
  const { scope, store } = await ended(t);
  assert.equal(offeredRunId(store), run);
  assert.equal(store.db.prepare("SELECT id FROM commands WHERE conversation=? ORDER BY rowid").all(scope.conversationId)[0].id, 'offered');
  assert.equal(store.endedSend(scope)?.command.clientCommandId, 'send');
});

test('ended send does not let non-JSON observation text hide a later match', async t => {
  const { scope, store, earlier } = await ended(t);
  earlier('garbled', { observation: "'not json'" });
  assert.equal(store.endedSend(scope)?.command.clientCommandId, 'send');
});

test('ended send does not let a native string evidence source hide a later match', async t => {
  const { scope, store, earlier } = await ended(t);
  earlier('native', { observation: `'${JSON.stringify({ kind: 'accepted', evidence: { source: 'native-reply' } })}'` });
  assert.equal(store.endedSend(scope)?.command.clientCommandId, 'send');
});

test('ended send throws on a row that names the run but cannot decode, and does not return a later match', async t => {
  const { scope, store, earlier } = await ended(t);
  earlier('corrupt', { intent: "'not json'" });
  assert.throws(() => store.endedSend(scope), SyntaxError);
});
