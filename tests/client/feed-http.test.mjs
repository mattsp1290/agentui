import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import test from 'node:test';
import { createBrowserConnection } from '@agentui/client/service';
import { transcriptProjection } from '@agentui/contracts/conversation';
import { fixture, scope } from './support.mjs';

const baseline = { kind: 'snapshot', snapshot: { scope, projectionVersion: 3, cursor: 0,
  document: { domain: transcriptProjection.initial(), receipts: {}, decisions: {} } } };
const foreignReceiptPage = { kind: 'events', events: [
  { scope, sequence: 1, event: { kind: 'domain', event: { kind: 'message-updated', messageId: 'unpublished',
    revision: 1, role: 'assistant', text: 'Must remain unpublished', complete: true } } },
  { scope, sequence: 2, event: { kind: 'receipt', receipt: { scope: { ...scope, hostId: 'foreign' },
    clientCommandId: 'command', hostOperationId: 'operation', sequence: 2, state: { kind: 'accepted' } } } },
] };
async function until(predicate) {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() > deadline) assert.fail('Feed did not reach expected state');
    await new Promise(resolve => setTimeout(resolve, 2));
  }
}

test('real HTTP foreign receipt events retain the direct-delivery mismatch and block sends after failed reconnect', { timeout: 10_000 }, async t => {
  let reconnecting = false, submissions = 0, closes = 0;
  const acknowledgements = [];
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    const input = JSON.parse(body);
    let value;
    if (input.op === 'watch') value = { feedId: 'feed' };
    else if (input.op === 'close') { closes++; value = null; }
    else if (input.op === 'submit') { submissions++; value = null; }
    else {
      acknowledgements.push(input.ack);
      if (reconnecting) { response.destroy(); return; }
      value = { kind: 'page', page: input.ack === null ? 1 : 2, item: input.ack === null ? baseline : foreignReceiptPage };
    }
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ ok: true, value }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const connection = createBrowserConnection({ fetch: (path, options) => fetch(new URL(path, origin), options) });
  const browser = fixture({ port: connection.conversation(scope), selectedProjection: transcriptProjection });
  const direct = fixture({ selectedProjection: transcriptProjection });
  t.after(() => { browser.store.disconnect(); direct.store.disconnect(); });
  await direct.store.connect();
  const stream = direct.port.watches.at(-1);
  await stream.receive(baseline);
  await assert.rejects(stream.receive(foreignReceiptPage), /scope mismatch/);
  await browser.store.connect();
  await until(() => browser.store.getSnapshot().connection.kind === 'mismatch');
  assert.deepEqual(browser.store.getSnapshot().connection, direct.store.getSnapshot().connection);
  for (const { store } of [browser, direct]) {
    assert.equal(store.getSnapshot().cursor, 0);
    assert.deepEqual(store.getSnapshot().document, baseline.snapshot.document);
  }
  assert.deepEqual(acknowledgements, [null, 1]);
  await until(() => closes === 1);
  reconnecting = true;
  await browser.store.connect();
  await until(() => browser.store.getSnapshot().connection.kind === 'failed');
  await browser.store.setDraft('Keep this draft');
  await assert.rejects(browser.store.send(), /scope mismatch/);
  assert.equal(browser.store.getSnapshot().draft, 'Keep this draft');
  assert.equal(submissions, 0);
});
