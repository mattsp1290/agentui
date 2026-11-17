import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, rmSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { registerHooks } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { chromium } from 'playwright';
import { EXTENSION_SDK_VERSION } from '@agentui/sdk';
import { crew, crewBackend, crewPresentation } from '../extensions/providers/contracts/crew.ts';
import { repository, buildCustom, root } from '../customization/build/support.mjs';
import { connected, draft, wait } from './browser-support.mjs';

const artifact = new URL('../../apps/host/build/tsc/artifact.js', import.meta.url).href;
registerHooks({ resolve(specifier, context, next) {
  if (specifier === './artifact.js' && context.parentURL?.endsWith('/server.js')) return { shortCircuit: true,
    url: `data:text/javascript,${encodeURIComponent(`export * from ${JSON.stringify(artifact)};import {readInstalledArtifact as read} from ${JSON.stringify(artifact)};export function readInstalledArtifact(){return read(${JSON.stringify(join(root, 'apps/host/dist'))});}`)}` };
  return next(specifier, context);
} });
const { startBrowserHost } = await import('../../apps/host/build/tsc/server.js');
async function records(page) {
  return page.evaluate(async () => {
    const opening = indexedDB.open('agentui-browser-views', 1);
    const db = await new Promise((resolve, reject) => { opening.onsuccess = () => resolve(opening.result); opening.onerror = () => reject(opening.error); });
    try { const request = db.transaction('records').objectStore('records').getAll(); return await new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); }); }
    finally { db.close(); }
  });
}
async function setup(t) {
  const custom = repository(), directory = mkdtempSync(join(tmpdir(), 'agentui-captured-browser-'));
  t.after(() => { rmSync(custom.directory, { recursive: true, force: true }); rmSync(directory, { recursive: true, force: true }); });
  custom.write('desktop/index.tsx', readFileSync(join(root, 'tests/application/fixtures/frontend-capture.tsx'), 'utf8'));
  const commit = custom.commit(); buildCustom(custom, commit);
  custom.write('desktop/index.tsx', 'throw new Error("Dirty source cannot enter this artifact");');
  const inputs = [], operations = [], confirmed = new Set(); let translations = 0;
  const remote = createServer(async (request, response) => {
    let body = ''; for await (const part of request) body += part;
    inputs.push(JSON.parse(body)); response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ kind: 'pending', evidence: {} }));
  });
  await new Promise(resolve => remote.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => remote.close(resolve)));
  const origin = `http://127.0.0.1:${remote.address().port}`, instance = crewPresentation.instance;
  const effect = operation => ({ kind: 'confirmed', value: { kind: 'send', state: 'completed', run: { binding: operation.binding,
    ref: { kind: 'run', instance, opaqueId: operation.request.runId } } }, evidence: { actual: true } });
  const backend = { ...crewBackend, async snapshot(binding) { return { kind: 'available', snapshot: { binding, cursor: { kind: 'provider-cursor', binding, opaque: { checkpoint: 'start', stream: 1 } }, projectionVersion: 1, state: { messages: [] }, decisions: [] } }; },
    async submit(operation) { operations.push(operation); return (await fetch(origin, { method: 'POST', body: JSON.stringify(operation.request) })).json(); },
    async reconcileCommand(operation) { return confirmed.has(operation.request.runId) ? effect(operation) : { kind: 'pending', evidence: {} }; } };
  const extension = { manifest: { namespace: instance.namespace, trust: 'full', sdkVersion: EXTENSION_SDK_VERSION, entries: [{ kind: 'server', module: './server.js' }] },
    entry: { kind: 'server', sdkVersion: EXTENSION_SDK_VERSION, activate({ providers }) {
      providers.addAgui('service', { ...crew, async connect() { return { kind: 'connected', backend }; } }, { ...crewPresentation,
        request(text) { const id = ++translations; return { runId: `actual-run-${id}`, threadId: `actual-thread-${id}`, messages: [{ id: 'user', role: 'user', content: text }], tools: [{ name: 'server', description: 'Existing' }], context: [], state: {}, forwardedProps: {} }; }, decodeRequest: value => value });
      return { dispose() {} };
    } }, installations: [{ id: 'service', instance, service: origin, expectedAuthority: 'remote-provider', authentication: { kind: 'secret', revision: '1', resolve: async () => 'fixture-secret' } }] };
  const host = await startBrowserHost({ agentStartup: { kind: 'recorded' }, directory, port: 0, assetsDirectory: join(custom.directory, 'browser'), extensions: { kind: 'transient', entries: [extension] } });
  t.after(() => host.close());
  const browser = await chromium.launch(); t.after(() => browser.close()); const context = await browser.newContext(), page = await context.newPage();
  page.setDefaultTimeout(15_000);
  await page.goto(`${host.origin}/browser.html`);
  await wait(() => page.getByRole('button', { name: 'New recorded conversation', exact: true }).isEnabled(), 'connected host');
  const inspect = action => { const db = new DatabaseSync(join(directory, 'host.sqlite')); try { return action(db); } finally { db.close(); } };
  const create = async (target = page) => {
    const previous = (await records(target)).find(row => row.route)?.route.conversationId;
    await target.getByRole('button', { name: 'Chats', exact: true }).click();
    if (await target.getByRole('button', { name: 'New conversation', exact: true }).count()) await target.getByRole('button', { name: 'New conversation', exact: true }).click();
    else {
      await target.getByRole('button', { name: 'Harness, Recorded', exact: true }).click();
      await target.getByRole('button', { name: 'Provider', exact: true }).click();
      await target.getByRole('button', { name: 'Start new chat with Crew researcher', exact: true }).click();
    }
    await wait(async () => (await records(target)).some(row => row.route && row.route.conversationId !== previous), 'new conversation route');
    await connected(target);
  };
  return { page, context, browser, host, inputs, operations, confirmed, inspect, create, translations: () => translations };
}

test('committed production browser captures both actual send paths and retains original A across confirmation, replacement, navigation and release', { timeout: 90_000 }, async t => {
  const f = await setup(t), { page } = f, errors = []; page.on('pageerror', error => errors.push(error.message));
  await f.create();
  let lostSubmission = false, lostBinding = false;
  await page.route('**/api/v1', async route => {
    const request = route.request().postDataJSON();
    if (request.op === 'submit' && !lostSubmission) { lostSubmission = true; await route.fetch(); await route.abort(); }
    else if (request.op === 'frontend-binding' && request.action === 'recover') {
      const response = await route.fetch(), body = await response.json();
      if (body.ok && body.value.kind === 'bound' && !lostBinding) { lostBinding = true; await route.abort(); }
      else await route.fulfill({ response });
    } else await route.continue();
  });
  await page.getByText('Capture activation 1', { exact: true }).waitFor();
  await draft(page, 'Composer capture'); await page.getByRole('button', { name: 'Send', exact: true }).click();
  await wait(() => f.inputs.length === 1, 'actual composer HTTP input');
  const original = (await records(page)).find(row => row.frontendSends?.length).frontendSends[0];
  assert.equal(original.command.version, 2); assert.equal(original.command.body.text, 'Composer capture');
  assert.deepEqual(f.inputs[0].tools.slice(1), original.command.body.frontend.tools.map(tool => tool.definition));
  assert.deepEqual(f.inspect(db => JSON.parse(db.prepare('SELECT target FROM commands WHERE id=?').get(original.command.clientCommandId).target).operation.request), f.inputs[0]);
  await page.getByRole('status').filter({ hasText: 'Waiting for confirmed run' }).waitFor();
  const originalView = await page.evaluate(() => sessionStorage.getItem('agentui.viewId'));
  const other = await f.context.newPage(); await other.goto(`${f.host.origin}/browser.html`);
  await other.getByRole('button', { name: 'New recorded conversation', exact: true }).click(); await connected(other);
  const otherView = await other.evaluate(() => sessionStorage.getItem('agentui.viewId'));
  await other.getByRole('button', { name: `Reopen saved view ${originalView}`, exact: true }).click();
  await other.getByRole('alert').filter({ hasText: 'already open in another tab' }).waitFor();
  await other.close();
  await page.getByRole('button', { name: 'Settings', exact: true }).click(); await page.getByRole('button', { name: 'Reconnect', exact: true }).click();
  await page.getByRole('button', { name: 'Chats', exact: true }).click();
  await page.getByRole('button', { name: `Reopen saved view ${otherView}`, exact: true }).click(); await connected(page);
  assert.ok((await page.evaluate(() => navigator.locks.query())).held.some(lock => lock.name === `agentui-view:${originalView}`));
  await page.getByRole('button', { name: `Reopen saved view ${originalView}`, exact: true }).click(); await connected(page);
  assert.equal(await page.evaluate(() => sessionStorage.getItem('agentui.viewId')), originalView);
  assert.equal(await page.getByRole('textbox', { name: 'Message', exact: true }).inputValue(), 'Composer capture');

  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByLabel('Enable customizations', { exact: true }).uncheck();
  assert.deepEqual(await page.evaluate(() => window.captureFixture.disposed), []);
  await page.getByLabel('Enable customizations', { exact: true }).check();
  await page.getByRole('button', { name: 'Chats', exact: true }).click(); await page.getByText('Capture activation 2', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Retry original command', exact: true }).click();
  await wait(() => page.getByRole('button', { name: 'New conversation', exact: true }).isEnabled(), 'original retry settled');
  await f.create(); await page.getByRole('button', { name: 'Send captured extension message', exact: true }).click();
  await wait(() => f.inputs.length === 2, 'actual extension HTTP input');
  const extension = (await records(page)).flatMap(row => row.frontendSends ?? []).find(entry => entry.command.body.text === 'Extension capture');
  assert.notEqual(extension.command.body.frontend.tools[0].activationId, original.command.body.frontend.tools[0].activationId);
  f.confirmed.add(f.inputs[0].runId); f.confirmed.add(f.inputs[1].runId);
  await wait(async () => await page.getByRole('status').filter({ hasText: 'Bound to confirmed run' }).count() === 2, 'original actual run bindings');
  await page.getByText(`Run ${f.inputs[0].runId}`, { exact: true }).waitFor();
  assert.deepEqual(await page.evaluate(() => window.captureFixture.disposed), []);
  assert.equal(f.translations(), 2); assert.equal(f.operations.length, 2); assert.equal(lostSubmission, true); assert.equal(lostBinding, true);
  await page.getByRole('button', { name: 'Reconcile command', exact: true }).click();
  await wait(async () => (await records(page)).some(row => row.scope?.conversationId === extension.command.scope.conversationId && row.outbox.length === 0), 'completed extension outbox settlement');
  await page.getByRole('button', { name: new RegExp(`Open conversation ${original.command.scope.conversationId}$`) }).click(); await connected(page);
  await page.getByRole('button', { name: 'Reconcile command', exact: true }).click();
  await wait(async () => (await records(page)).some(row => row.scope?.conversationId === original.command.scope.conversationId && row.outbox.length === 0), 'completed original outbox settlement');
  assert.deepEqual(await page.evaluate(() => window.captureFixture.disposed), []);

  const row = page.locator(`[data-captured-command="${original.command.clientCommandId}"]`);
  await row.getByRole('button', { name: 'Release captured tools', exact: true }).click();
  await row.getByRole('status').filter({ hasText: 'Captured tools unavailable' }).waitFor();
  await wait(() => page.evaluate(() => window.captureFixture.disposed.includes(1)), 'original A disposal');
  await wait(async () => (await records(page)).flatMap(row => row.frontendSends ?? []).find(entry => entry.command.clientCommandId === original.command.clientCommandId)?.state === 'unavailable-confirmed', 'durable release acknowledgment');
  assert.equal(await page.evaluate(() => window.captureFixture.executions), 0);
  for (const table of ['frontend_events', 'frontend_receipts']) assert.equal(f.inspect(db => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n), 0);
  await page.getByRole('button', { name: new RegExp(`Open conversation ${extension.command.scope.conversationId}$`) }).click(); await connected(page);
  await wait(async () => (await records(page)).some(row => row.route?.conversationId === extension.command.scope.conversationId), 'saved extension route');
  await page.reload(); await connected(page);
  await page.locator(`[data-captured-command="${extension.command.clientCommandId}"]`).getByRole('status').filter({ hasText: 'Captured tools unavailable' }).waitFor();
  await wait(async () => (await records(page)).flatMap(row => row.frontendSends ?? []).find(entry => entry.command.clientCommandId === extension.command.clientCommandId)?.state === 'unavailable-confirmed', 'reload acknowledges lost closure');
  assert.equal(f.operations.length, 2); assert.equal(await page.evaluate(() => window.captureFixture.executions), 0); assert.deepEqual(errors, []);
});

test('actual browser release precedes a delayed submission and repeats lost unavailable replies without dispatch', { timeout: 60_000 }, async t => {
  const f = await setup(t), { page } = f;
  let resume, submitted = false, lost = false;
  const gate = new Promise(resolve => { resume = resolve; });
  await page.route('**/api/v1', async route => {
    const request = route.request().postDataJSON();
    if (request.op === 'submit') { submitted = true; await gate; await route.continue(); }
    else if (request.op === 'frontend-binding' && request.action === 'unavailable' && !lost) { lost = true; await route.fetch(); await route.abort(); }
    else await route.continue();
  });
  t.after(() => resume());
  await f.create(); await draft(page, 'Release before dispatch'); await page.getByRole('button', { name: 'Send', exact: true }).click();
  await wait(() => submitted, 'delayed original submission');
  const reference = (await records(page)).flatMap(row => row.frontendSends ?? [])[0];
  await page.getByRole('button', { name: 'Release captured tools', exact: true }).click();
  await wait(() => lost, 'lost unavailable reply');
  await wait(async () => (await records(page)).flatMap(row => row.frontendSends ?? [])[0].state === 'unavailable-confirmed', 'repeated unavailable acknowledgment');
  resume();
  await wait(async () => (await records(page)).filter(row => row.outbox).every(row => row.outbox.length === 0), 'late submission refusal');
  assert.equal(f.inspect(db => db.prepare('SELECT COUNT(*) AS n FROM frontend_send_tombstones WHERE command_id=? AND actor_id=?').get(reference.command.clientCommandId, reference.ownerId).n), 1);
  assert.equal(f.inspect(db => db.prepare('SELECT COUNT(*) AS n FROM frontend_send_owners WHERE command_id=?').get(reference.command.clientCommandId).n), 0);
  assert.equal(f.operations.length, 0); assert.equal(f.translations(), 0); assert.equal(await page.evaluate(() => window.captureFixture.executions), 0);
});

for (const phase of ['admission', 'release']) test(`production browser ${phase} storage failure releases captures and blocks effects`, { timeout: 60_000 }, async t => {
  const f = await setup(t), { page } = f; await f.create(); await draft(page, 'Storage failure');
  if (phase === 'release') { await page.getByRole('button', { name: 'Send', exact: true }).click(); await wait(() => f.inputs.length === 1, 'captured dispatch'); }
  await page.evaluate(() => {
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function(value, key) { if (Array.isArray(key) && key[0] === 'draft') throw new Error('Injected local storage failure'); return put.call(this, value, key); };
  });
  if (phase === 'admission') await page.getByRole('button', { name: 'Send', exact: true }).click();
  else await page.getByRole('button', { name: 'Release captured tools', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: 'Local storage unavailable. Commands are blocked.' }).waitFor();
  await page.getByRole('button', { name: 'Settings', exact: true }).click(); await page.getByLabel('Enable customizations', { exact: true }).uncheck();
  await wait(() => page.evaluate(() => window.captureFixture.disposed.length === 1), 'failed storage releases closure');
  assert.equal(f.operations.length, phase === 'release' ? 1 : 0); assert.equal(await page.evaluate(() => window.captureFixture.executions), 0);
});

for (const loss of ['pagehide', 'crash-retained']) test(`production reload in B recovers both A and B after ${loss}`, { timeout: 90_000 }, async t => {
  const f = await setup(t), { page } = f;
  await f.create(); await draft(page, 'Conversation A'); await page.getByRole('button', { name: 'Send', exact: true }).click();
  await wait(() => f.inputs.length === 1, 'A capture');
  await f.create(); await draft(page, 'Conversation B'); await page.getByRole('button', { name: 'Send', exact: true }).click();
  await wait(() => f.inputs.length === 2, 'B capture');
  const original = (await records(page)).flatMap(row => row.frontendSends ?? []);
  assert.equal(original.length, 2);
  if (loss === 'crash-retained') await page.evaluate(() => {
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function(value, key) {
      if (Array.isArray(key) && key[0] === 'draft') value = { ...value, frontendSends: value.frontendSends.map(entry => ({ ...entry, state: 'retained' })) };
      return put.call(this, value, key);
    };
  });
  await page.reload(); await connected(page);
  await wait(async () => (await records(page)).flatMap(row => row.frontendSends ?? []).filter(entry => entry.state === 'unavailable-confirmed').length === 2, 'both original journals confirmed without reopening A');
  for (const reference of original) assert.equal(f.inspect(db => db.prepare('SELECT state FROM frontend_send_owners WHERE command_id=?').get(reference.command.clientCommandId).state), 'unavailable');
  const recovered = (await records(page)).flatMap(row => row.frontendSends ?? []);
  assert.deepEqual(recovered.map(({ command, ownerId }) => ({ command, ownerId })), original.map(({ command, ownerId }) => ({ command, ownerId })));
  for (const reference of original) await page.locator(`[data-captured-command="${reference.command.clientCommandId}"]`).getByRole('status').filter({ hasText: 'Captured tools unavailable' }).waitFor();
  assert.equal(f.operations.length, 2); assert.equal(f.translations(), 2);
  assert.equal(await page.evaluate(() => window.captureFixture.executions), 0);
  for (const table of ['frontend_events', 'frontend_receipts']) assert.equal(f.inspect(db => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n), 0);
});


test('production browser switches recovery views and releases the old lock before a held unavailable reply', { timeout: 60_000 }, async t => {
  const f = await setup(t), { page } = f, requests = [];
  await f.create(); await draft(page, 'Original physical view'); await page.getByRole('button', { name: 'Send', exact: true }).click();
  await wait(() => f.inputs.length === 1, 'original view dispatch');
  const oldView = await page.evaluate(() => sessionStorage.getItem('agentui.viewId'));
  const original = (await records(page)).flatMap(row => row.frontendSends ?? [])[0];
  const other = await f.context.newPage(); await other.goto(`${f.host.origin}/browser.html`);
  await f.create(other); await draft(other, 'Next physical view'); await other.getByRole('button', { name: 'Send', exact: true }).click();
  await wait(() => f.inputs.length === 2, 'next view dispatch');
  const nextView = await other.evaluate(() => sessionStorage.getItem('agentui.viewId'));
  const successor = (await records(page)).flatMap(row => row.frontendSends ?? []).find(row => row.command.clientCommandId !== original.command.clientCommandId);
  await other.route('**/api/v1', async route => {
    const request = route.request().postDataJSON();
    if (request.op === 'frontend-binding' && request.action === 'unavailable') await route.abort(); else await route.continue();
  });
  await other.locator(`[data-captured-command="${successor.command.clientCommandId}"]`).getByRole('button', { name: 'Release captured tools', exact: true }).click();
  await wait(async () => (await records(page)).flatMap(row => row.frontendSends ?? []).find(row => row.command.clientCommandId === successor.command.clientCommandId).state === 'unavailable-pending', 'next view closure release');
  await other.close();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Reconnect', exact: true }).click();
  await wait(() => page.getByRole('button', { name: 'Reconnect', exact: true }).isEnabled(), 'saved view listing');
  await page.getByRole('button', { name: 'Chats', exact: true }).click();
  let releaseOld, releaseNext;
  const oldGate = new Promise(resolve => { releaseOld = resolve; }), nextGate = new Promise(resolve => { releaseNext = resolve; });
  t.after(() => { releaseOld(); releaseNext(); });
  await page.route('**/api/v1', async route => {
    const request = route.request().postDataJSON();
    if (request.op === 'frontend-binding' && request.action === 'unavailable') {
      requests.push(request);
      await (request.id === original.command.clientCommandId ? oldGate : nextGate);
    }
    await route.continue();
  });
  const oldRequest = page.waitForRequest(request => request.postDataJSON()?.op === 'frontend-binding' && request.postDataJSON()?.action === 'unavailable', { timeout: 5_000 });
  await page.locator(`[data-captured-command="${original.command.clientCommandId}"]`).getByRole('button', { name: 'Release captured tools', exact: true }).click();
  await oldRequest;
  const nextRequest = page.waitForRequest(request => request.postDataJSON()?.op === 'frontend-binding' && request.postDataJSON()?.id === successor.command.clientCommandId, { timeout: 5_000 });
  await page.getByRole('button', { name: `Reopen saved view ${nextView}`, exact: true }).click();
  await nextRequest; await connected(page);
  await page.waitForFunction(async id => !(await navigator.locks.query()).held.some(lock => lock.name === `agentui-view:${id}`), oldView, { timeout: 5_000 });
  assert.equal(await page.evaluate(id => navigator.locks.request(`agentui-view:${id}`, { ifAvailable: true }, lock => Boolean(lock)), oldView), true);
  const before = (await records(page)).flatMap(row => row.frontendSends ?? []);
  releaseOld();
  await wait(() => f.inspect(db => db.prepare('SELECT state FROM frontend_send_owners WHERE command_id=?').get(original.command.clientCommandId).state) === 'unavailable', 'late original host response');
  assert.deepEqual((await records(page)).flatMap(row => row.frontendSends ?? []), before);
  releaseNext();
  await wait(async () => (await records(page)).flatMap(row => row.frontendSends ?? []).find(row => row.command.clientCommandId === successor.command.clientCommandId).state === 'unavailable-confirmed', 'successor view acknowledgment');
  const after = (await records(page)).flatMap(row => row.frontendSends ?? []);
  assert.equal(after.find(row => row.command.clientCommandId === original.command.clientCommandId).state, 'unavailable-pending');
  assert.deepEqual(after.map(({ command, ownerId }) => ({ command, ownerId })), before.map(({ command, ownerId }) => ({ command, ownerId })));
  assert.deepEqual(requests.map(request => request.id), [original.command.clientCommandId, successor.command.clientCommandId]);
  assert.equal(f.operations.length, 2); assert.equal(f.translations(), 2); assert.equal(await page.evaluate(() => window.captureFixture.executions), 0);
  for (const table of ['frontend_events', 'frontend_receipts']) assert.equal(f.inspect(db => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n), 0);
});
