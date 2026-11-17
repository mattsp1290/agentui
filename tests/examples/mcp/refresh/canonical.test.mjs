import assert from 'node:assert/strict';
import { join, relative } from 'node:path';
import test from 'node:test';
import { assertInstalledFresh } from './freshness.mjs';
import { startControl } from '../../../../apps/host/build/tsc/control.js';
import { realFixture, deferred, rows } from '../../../host/refresh-support.mjs';
import { client, installed, recordResource, until } from './support.mjs';

async function setup(t, waitMs) {
  await assertInstalledFresh();
  const f = await realFixture(t), owner = await f.open(), copy = await installed(t);
  await recordResource({ type: 'canonical-fixture', source: f.first.repository, artifactRoot: f.artifactRoot });
  let promotions = 0;
  const original = owner.selection.select;
  owner.selection.select = async (...args) => { promotions++; return original(...args); };
  const control = await startControl(join(copy.root, 'control.sock'), {}, {}, () => false, owner.selection, async () => [], owner);
  t.after(() => control.close());
  const connection = await client(t, copy.entry, copy.root, waitMs);
  return { ...f, ...copy, ...connection, owner, promotions: () => promotions };
}
const request = (id, reference, expectedSelectionRevision) => ({ kind: 'request', id, reference, expectedSelectionRevision });
const receipt = result => { assert.equal(result.isError, undefined, JSON.stringify(result)); assert.equal(result.structuredContent.kind, 'receipt'); return result.structuredContent.receipt; };

test('actual MCP stdio and copied installed CLI build committed source, preserve replay and saved promotion', { timeout: 40000 }, async t => {
  const f = await setup(t), entered = deferred(), release = deferred();
  const initial = receipt(await f.call(request('initial', { ...f.first, repository: relative(process.cwd(), f.first.repository), commit: f.first.commit.toUpperCase() }, 0)));
  assert.deepEqual(initial.job.request.reference, f.first);
  const rejected = await f.call(request('dash', { ...f.first, repository: '-repo' }, 0));
  assert.equal(rejected.structuredContent.reason, 'cli-exit');
  assert.equal(f.commands.length, 1);
  assert.equal(initial.job.promotion.kind, 'selected');
  assert.equal(initial.selectionStatus.desiredRevision, 1);
  assert.equal(f.commands.length, 1); assert.equal(f.promotions(), 1);
  f.setRun(async command => { entered.resolve(); await release.promise; return f.actual(command); });
  t.after(() => release.resolve());
  const intent = request('next', f.second, 1), running = f.call(intent);
  await Promise.race([entered.promise, running.then(result => { throw new Error('Request finished before build admission: '+JSON.stringify(result)); })]);
  const saved = rows(f.database);
  assert.equal(receipt(await f.call(intent)).job.build.kind, 'building');
  assert.equal(receipt(await f.call({ kind: 'status', id: 'next' })).job.build.kind, 'building');
  assert.deepEqual(rows(f.database), saved); assert.equal(f.commands.length, 2); assert.equal(f.promotions(), 1);
  const conflict = await f.call({ ...intent, reference: f.first });
  assert.equal(conflict.isError, true); assert.equal(conflict.structuredContent.reason, 'cli-exit');
  release.resolve();
  const built = receipt(await running);
  assert.equal(built.job.promotion.kind, 'selected');
  assert.equal(built.selectionStatus.runtime.kind, 'withheld');
  const completed = rows(f.database);
  assert.deepEqual(receipt(await f.call(intent)), built);
  assert.deepEqual(receipt(await f.call({ kind: 'status', id: 'next' })), built);
  assert.deepEqual(rows(f.database), completed); assert.equal(f.commands.length, 2); assert.equal(f.promotions(), 2);
  const refused = receipt(await f.call(request('stale', f.first, 0)));
  assert.equal(refused.job.promotion.kind, 'refused');
  assert.equal(refused.job.promotion.reason, 'revision-conflict');
  const promoted = receipt(await f.call({ kind: 'promote', id: 'stale' }));
  assert.deepEqual(promoted.job.promotion.command, refused.job.promotion.command);
  assert.deepEqual(promoted.job.build.pin, refused.job.build.pin);
  assert.equal(promoted.job.promotion.kind, 'refused');
  assert.equal(f.commands.length, 3); assert.equal(f.promotions(), 4);
  assert.equal(f.replacements(), 0);
});

for (const mode of ['disconnect', 'timeout', 'cancel']) test(`actual host work survives MCP ${mode} and original-ID inspection`, { timeout: 40000 }, async t => {
  const f = await setup(t, mode === 'timeout' ? 200 : 10000), entered = deferred(), release = deferred();
  f.setRun(async command => { entered.resolve(); await release.promise; return f.actual(command); });
  t.after(() => release.resolve());
  const abort = new AbortController();
  const intent = request(`lost-${mode}`, f.first, 0);
  const running = f.client.callTool({ name: 'agentui_refresh', arguments: { operation: intent } }, undefined, { signal: abort.signal }).catch(error => error);
  await Promise.race([entered.promise, running.then(result => { throw new Error('Request finished before build admission: '+JSON.stringify(result)); })]);
  if (mode === 'disconnect') await f.client.close();
  if (mode === 'cancel') abort.abort();
  const lost = await running;
  if (mode === 'timeout') { assert.equal(lost.isError, true); assert.equal(lost.structuredContent.requestId, intent.id); }
  else assert.ok(lost instanceof Error);
  const inspected = await f.owner.inspect(intent.id);
  assert.equal(inspected.job.build.kind, 'building');
  assert.equal(f.commands.length, 1);
  release.resolve();
  await until(() => f.owner.inspect(intent.id), value => value.job.promotion.kind === 'selected');
  const recovered = await client(t, f.entry, f.root);
  assert.equal(receipt(await recovered.call({ kind: 'status', id: intent.id })).job.promotion.kind, 'selected');
  assert.equal(receipt(await recovered.call(intent)).job.promotion.kind, 'selected');
  assert.equal(f.commands.length, 1); assert.equal(f.promotions(), 1); assert.equal(f.replacements(), 0);
});
