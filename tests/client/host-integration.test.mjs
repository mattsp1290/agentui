import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalJson } from '@agentui/contracts';
import { createConversationStore } from '@agentui/client';
import { openLocalHost, createRecordedDriver } from '@agentui/host';
import { scope, other, installed, projection, deferred } from '../host/fixture.mjs';

const recording = JSON.parse(readFileSync(new URL('./recordings/approval-v1.json', import.meta.url), 'utf8'));

function observe(store, predicate) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { unsubscribe(); reject(new Error('Client milestone timed out')); }, 5000);
    const check = () => {
      const view = store.getSnapshot();
      if (predicate(view)) { clearTimeout(timer); unsubscribe(); resolve(view); }
    };
    const unsubscribe = store.subscribe(check);
    check();
  });
}
function harness(t, afterAcceptance) {
  assert.equal(recording.recordingVersion, 1);
  assert.equal(recording.provider, 'agentui-recorded');
  assert.equal(recording.projectionVersion, projection.version);
  const directory = mkdtempSync(join(tmpdir(), 'agentui-public-integration-'));
  const backendPath = join(directory, 'external-acceptances.jsonl');
  const hosts = [], clients = [];
  t.after(() => {
    for (const client of clients) client.disconnect();
    for (const host of hosts) host.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const open = () => {
    const driver = createRecordedDriver({ installation: installed, backendPath, decodeEvent: projection.decodeEvent,
      resolve: async command => structuredClone(recording[command.body.kind]), afterAcceptance });
    const host = openLocalHost({ path: join(directory, 'host.sqlite'), projection, driver,
      authorize: value => value.hostId === scope.hostId, budgets: { pollMs: 10 } });
    hosts.push(host);
    return host;
  };
  const client = (host, name, selectedScope = scope, decorate = port => port) => {
    const path = join(directory, `${name}.json`);
    let serial = 0;
    const store = createConversationStore({ scope: selectedScope, projection,
      port: decorate(host.conversation(selectedScope)), createCommandId: () => `${name}-${++serial}`,
      drafts: {
        async load() { return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null; },
        async save(value) { writeFileSync(path, canonicalJson(value)); },
      } });
    clients.push(store);
    return store;
  };
  const entries = () => existsSync(backendPath) ? readFileSync(backendPath, 'utf8').trim().split('\n').map(JSON.parse) : [];
  return { open, client, entries };
}

test('public clients converge through SQLite and a versioned recording while approval admits one winner', { timeout: 10_000 }, async t => {
  const entered = deferred(), release = deferred();
  t.after(() => release.resolve());
  const f = harness(t, async command => {
    if (command.body.kind === 'approve') { entered.resolve(); await release.promise; }
  });
  const a = f.open(), b = f.open();
  a.createConversation(scope, installed);
  a.createConversation(other, installed);
  const alice = f.client(a, 'alice'), bob = f.client(b, 'bob'), isolated = f.client(b, 'isolated', other);
  await Promise.all([alice.connect(), bob.connect(), isolated.connect()]);
  await Promise.all([alice, bob, isolated].map(store => observe(store, view => view.connection.kind === 'connected')));
  await alice.setDraft('Start the recorded run');
  const sent = await alice.send();
  assert.equal(sent.receipt.state.kind, 'completed');
  await Promise.all([alice, bob].map(store => observe(store, view => Boolean(view.document.decisions['question-a']))));
  assert.deepEqual(alice.getSnapshot().document, bob.getSnapshot().document);
  assert.deepEqual(alice.getSnapshot().document.domain, ['Recorded response awaiting approval']);
  assert.deepEqual(bob.getSnapshot().document.receipts['alice-1'], sent.receipt);
  const winning = alice.approve('question-a', 'yes');
  await entered.promise;
  const losing = await bob.approve('question-a', 'no');
  assert.deepEqual(losing, { kind: 'rejected', reason: 'decision-unavailable' });
  assert.deepEqual(bob.getSnapshot().outbox, []);
  const recreatedBob = f.client(b, 'bob');
  await recreatedBob.ready;
  assert.deepEqual(recreatedBob.getSnapshot().outbox, []);
  release.resolve();
  const approved = await winning;
  await Promise.all([alice, bob].map(store => observe(store,
    view => view.document.receipts['alice-2']?.state.kind === 'completed')));
  assert.deepEqual(alice.getSnapshot().document, bob.getSnapshot().document);
  assert.deepEqual(bob.getSnapshot().document.receipts['alice-2'], approved.receipt);
  assert.deepEqual(bob.getSnapshot().document.decisions, {});
  assert.deepEqual(bob.getSnapshot().document.domain, ['Recorded response awaiting approval', 'Recorded approval completed']);
  isolated.disconnect();
  await isolated.connect();
  await observe(isolated, view => view.connection.kind === 'connected');
  assert.deepEqual(isolated.getSnapshot().document, { domain: [], receipts: {}, decisions: {} });
  assert.equal(isolated.getSnapshot().cursor, 0);
  assert.equal(f.entries().length, 2);
});

test('lost reply survives host, database and client recreation and same-ID retry adds no external entry', { timeout: 10_000 }, async t => {
  const f = harness(t);
  let host = f.open();
  host.createConversation(scope, installed);
  const submitted = [];
  const original = f.client(host, 'restart', scope, port => ({ ...port,
    async submit(command) {
      submitted.push(structuredClone(command));
      await port.submit(command);
      throw new Error('Reply lost after durable host completion');
    },
  }));
  await original.connect();
  await observe(original, view => view.connection.kind === 'connected');
  await original.setDraft('Original command body');
  original.disconnect();
  await assert.rejects(original.send(), /Reply lost/);
  await original.setDraft('A newer unsent draft');
  const saved = original.getSnapshot().outbox;
  assert.equal(saved.length, 1);
  assert.deepEqual(saved[0].command, submitted[0]);
  assert.equal(f.entries().length, 1);
  host.close();
  host = f.open();
  const recreated = f.client(host, 'restart', scope, port => ({ ...port,
    submit(command) { submitted.push(structuredClone(command)); return port.submit(command); },
  }));
  await recreated.connect();
  await observe(recreated, view => view.connection.kind === 'connected' && Boolean(view.document.decisions['question-a']));
  assert.equal(recreated.getSnapshot().draft, 'A newer unsent draft');
  assert.deepEqual(recreated.getSnapshot().outbox, saved);
  const hostReceipt = await host.conversation(scope).receipt(saved[0].command.clientCommandId);
  assert.equal(hostReceipt.state.kind, 'completed');
  assert.deepEqual(recreated.getSnapshot().document.receipts[hostReceipt.clientCommandId], hostReceipt);
  const retry = await recreated.retry(saved[0].command.clientCommandId);
  assert.deepEqual(retry.receipt, hostReceipt);
  assert.deepEqual(submitted[1], submitted[0]);
  assert.equal(f.entries().length, 1);
  assert.equal(recreated.getSnapshot().draft, 'A newer unsent draft');
  assert.deepEqual(recreated.getSnapshot().outbox, []);
  const before = recreated.getSnapshot().document;
  recreated.disconnect();
  await recreated.connect();
  await observe(recreated, view => view.connection.kind === 'connected');
  assert.deepEqual(recreated.getSnapshot().document, before);
  assert.ok(recreated.getSnapshot().document.decisions['question-a']);
});
