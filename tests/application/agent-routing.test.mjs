import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createServer } from 'node:http';
import { chromium } from 'playwright';
import { repository, buildCustom } from '../customization/build/support.mjs';
import { readArtifactBytes } from '../../apps/host/build/tsc/artifact.js';
import { serviceEndpoint } from '../../apps/host/build/tsc/service-endpoint.js';
import { CODEX_RUNTIME, CLAUDE_SDK_RUNTIMES } from '@agentui/contracts/compatibility';
import { parseServiceRequest, parseServiceResponse } from '@agentui/contracts/service';
import { transcriptProjection } from '@agentui/contracts/conversation';
import { openLocalHost, createRecordedDriver } from '@agentui/host';
import { Access } from '../../apps/host/build/tsc/access.js';
import { openAccessDatabase } from '../../apps/host/build/tsc/access-database.js';
import { createApi } from '../../apps/host/build/tsc/api.js';
import { FeedRegistry } from '../../apps/host/build/tsc/feed-registry.js';

const installed = (runtime, account) => ({ installationId: 'same-installation-id', binding: {
  engine: runtime.engine, nativeVersion: runtime.version, nativeFormat: runtime.format,
  account, authorizedScope: '/private/workspace',
} });
test('authorized agent API and browser route two recorded agents and retain unavailable history', { timeout: 60000 }, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'agentui-agent-routing-'));
  const path = join(directory, 'host.sqlite'), access = new Access(openAccessDatabase(path));
  const feeds = new FeedRegistry(), calls = [];
  const a = installed(CODEX_RUNTIME, 'private-account-a'), b = installed(CLAUDE_SDK_RUNTIMES.sonnet, 'private-account-b');
  const c = installed(CLAUDE_SDK_RUNTIMES.opus, 'private-account-c'), d = installed(CODEX_RUNTIME, 'private-account-d');
  const driver = (installation, name) => ({ ...createRecordedDriver({ installation, backendPath: join(directory, `${name}.jsonl`), decodeEvent: transcriptProjection.decodeEvent,
    resolve: async cmd => { calls.push(name); return { kind: 'completed', output: { events: [
      { kind: 'message-updated', messageId: cmd.clientCommandId, revision: 1, role: 'user', text: cmd.body.text, complete: true },
      { kind: 'message-updated', messageId: `${cmd.clientCommandId}:reply`, revision: 1, role: 'assistant', text: `${name} recorded response`, complete: true },
    ], runs: [], decisions: [] } }; } }), installation });
  let host = openLocalHost({ path, projection: transcriptProjection, driver: [driver(a, 'codex'), driver(b, 'sonnet'), driver(d, 'other-codex')], authorize: scope => scope.hostId === access.hostId });
  t.after(async () => { feeds.dispose(); host.close(); await host.drained; access.close(); rmSync(directory, { recursive: true, force: true }); });
  const paired = access.pair(access.invite('browser-development'), 'browser-development');
  const { principal } = paired;
  const options = { access, feeds, credentialClass: 'browser-development', isClosing: () => false,
    compatibility: { wireVersion: 2, extensionSdkVersion: '0.0.0', nativeRuntime: CODEX_RUNTIME,
      desiredGitRevision: 'test', appliedArtifact: { artifactId: 'test', gitRevision: 'test' } } };
  let api = createApi({ ...options, host, installation: a, agents: [
    { installation: a, name: 'Project A', availability: { kind: 'ready' } }, { installation: b, availability: { kind: 'ready' } },
    { installation: c, availability: { kind: 'unavailable', reason: 'Optional agent unavailable' } },
    { installation: d, name: 'Project B', availability: { kind: 'ready' } },
  ] });
  const call = async request => parseServiceResponse(request, { ok: true, value: await api(principal, parseServiceRequest(request)) }).value;
  const metadata = await call({ op: 'metadata' });
  assert.doesNotMatch(JSON.stringify(metadata), /private-account|private\/workspace|same-installation-id/);
  const [codex, sonnet, opus] = metadata.agents;
  assert.equal(new Set(metadata.agents.map(agent => agent.id)).size, 4);
  assert.match(sonnet.label, /Sonnet/); assert.match(opus.label, /Opus/);
  assert.deepEqual(sonnet.commands, ['send', 'cancel']);
  const scopeA = { hostId: access.hostId, conversationId: 'a' }, scopeB = { ...scopeA, conversationId: 'b' };
  await assert.rejects(call({ op: 'conversation-agent', scope: { ...scopeA, hostId: 'foreign' } }), /another host/);
  assert.equal(await call({ op: 'conversation-agent', scope: scopeB }), null);
  await assert.rejects(call({ op: 'create', scope: scopeB, agentId: opus.id }), /Optional agent unavailable/);
  await call({ op: 'create', scope: scopeA, agentId: codex.id });
  await call({ op: 'create', scope: scopeB, agentId: sonnet.id });
  for (const scope of [scopeA, scopeB]) await call({ op: 'submit', command: { version: 1, scope, clientCommandId: 'same-id', body: { kind: 'send', text: 'hello' } } });
  assert.deepEqual(calls, ['codex', 'sonnet']);
  assert.equal((await call({ op: 'search', query: 'no matches', after: null })).items.length, 0);
  assert.equal((await call({ op: 'conversation-agent', scope: scopeB })).id, sonnet.id);
  const custom = repository();
  t.after(() => rmSync(custom.directory, { recursive: true, force: true }));
  buildCustom(custom);
  const assets = readArtifactBytes(join(custom.directory, 'browser'), 'browser-development');
  const handler = serviceEndpoint({ access, api: (principal, request) => api(principal, request), credentialClass: 'browser-development', files: assets.files, isClosing: () => false });
  const server = createServer((request, response) => { void handler(request, response); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch();
  t.after(async () => { await browser.close(); await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); });
  const context = await browser.newContext();
  await context.addCookies([{ name: `agentui_device_${access.hostId}`, value: paired.secret, url: origin }]);
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  await page.goto(`${origin}/browser.html`);
  const open = async id => {
    await page.getByRole('button', { name: new RegExp(`Open conversation ${id}$`) }).click();
    await page.waitForFunction(expected => document.querySelector('.scope-label')?.textContent === expected, id);
    await page.getByRole('status').filter({ hasText: 'Conversation connected' }).first().waitFor();
  };
  const message = page.getByRole('textbox', { name: 'Message', exact: true });
  await open('a');
  assert.match(await page.locator('.composer-footer').textContent(), /Local Codex/);
  await message.fill('Draft for Codex');
  await open('b');
  assert.match(await page.locator('.composer-footer').textContent(), /Claude.*Sonnet/);
  await message.fill('Draft for Sonnet');
  await page.screenshot({ path: '.audit/mvp/native-agent-routing-sonnet.png' });
  await open('a');
  assert.equal(await message.inputValue(), 'Draft for Codex');
  const chooser = page.getByRole('combobox', { name: 'Agent for new chat', exact: true });
  assert.equal(await chooser.locator('option').filter({ hasText: 'Opus' }).isDisabled(), true);
  assert.equal(await chooser.locator('option', { hasText: 'Project A · Codex' }).count(), 1);
  assert.equal(await chooser.locator('option', { hasText: 'Project B · Codex' }).count(), 1);
  await chooser.selectOption(sonnet.id);
  assert.match(await page.locator('.composer-footer').textContent(), /Local Codex/);
  let loseCreate = true, dropCreate = false, droppedScope;
  await page.route('**/api/v1', async route => {
    if (dropCreate && route.request().postDataJSON().op === 'create') {
      dropCreate = false; droppedScope = route.request().postDataJSON().scope; await route.abort();
    } else if (loseCreate && route.request().postDataJSON().op === 'create') {
      loseCreate = false; await route.fetch(); await route.abort();
    } else await route.continue();
  });
  await page.getByRole('button', { name: 'New conversation', exact: true }).click();
  await page.getByRole('button', { name: 'Recover creation', exact: true }).waitFor();
  await page.reload();
  await page.getByRole('combobox', { name: 'Agent for pending creation', exact: true }).selectOption(codex.id);
  await page.getByRole('button', { name: 'Recover creation', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.composer-footer')?.textContent?.includes('Sonnet'));
  await page.getByRole('heading', { name: 'Plan review', exact: true }).waitFor();
  await message.fill('Unsent selected Sonnet draft');
  await page.getByRole('button', { name: 'Review the plan', exact: true }).click();
  await page.getByText('sonnet recorded response', { exact: true }).waitFor();
  assert.equal(calls.at(-1), 'sonnet');
  await page.reload();
  await page.getByRole('status').filter({ hasText: 'Conversation connected' }).first().waitFor();
  assert.equal(await message.inputValue(), 'Unsent selected Sonnet draft');
  await page.screenshot({ path: '.audit/mvp/native-agent-routing-chooser.png' });
  await page.setViewportSize({ width: 360, height: 480 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.setViewportSize({ width: 1280, height: 720 });
  await open('a');
  assert.equal(await message.inputValue(), 'Draft for Codex');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page.locator('.message-user p').filter({ hasText: 'Draft for Codex' }).waitFor();
  assert.deepEqual(calls, ['codex', 'sonnet', 'sonnet', 'codex']);
  await open('b');
  assert.equal(await message.inputValue(), 'Draft for Sonnet');
  await open('a');
  await page.evaluate(hostId => new Promise((resolve, reject) => {
    const request = indexedDB.open('agentui-browser-views', 1);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result, transaction = db.transaction('records', 'readwrite');
      transaction.objectStore('records').put({ version: 1, route: { hostId, conversationId: 'a' },
        pendingCreation: { hostId, conversationId: 'legacy-absent' } }, ['view', sessionStorage.getItem('agentui.viewId'), hostId]);
      transaction.oncomplete = () => { db.close(); resolve(); };
    };
  }), access.hostId);
  await page.reload();
  await page.getByRole('button', { name: 'Recover creation', exact: true }).click();
  await page.getByText(/Choose an agent explicitly/).waitFor();
  assert.equal(host.installation({ ...scopeA, conversationId: 'legacy-absent' }), null);
  await page.getByRole('combobox', { name: 'Agent for pending creation', exact: true }).selectOption(sonnet.id);
  await page.getByRole('button', { name: 'Recover creation', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.scope-label')?.textContent === 'legacy-absent');
  assert.deepEqual(host.installation({ ...scopeA, conversationId: 'legacy-absent' }), b);
  await open('a');
  await chooser.selectOption(codex.id);
  dropCreate = true;
  await page.getByRole('button', { name: 'New conversation', exact: true }).click();
  await page.getByRole('button', { name: 'Recover creation', exact: true }).waitFor();
  assert.equal(host.installation(droppedScope), null);
  host.close(); await host.drained;
  host = openLocalHost({ path, projection: transcriptProjection, driver: [driver(b, 'sonnet')], authorize: scope => scope.hostId === access.hostId });
  api = createApi({ ...options, host, installation: b, agents: [{ installation: b, availability: { kind: 'ready' } }] });
  assert.equal((await call({ op: 'metadata' })).defaultAgentId, sonnet.id);
  const removed = await call({ op: 'conversation-agent', scope: scopeA });
  assert.equal(removed.id, codex.id); assert.equal(removed.availability.kind, 'unavailable');
  assert.deepEqual(await call({ op: 'create', scope: scopeA, agentId: codex.id }), scopeA);
  await assert.rejects(call({ op: 'create', scope: scopeA, agentId: sonnet.id }), /already belongs/);
  const replay = await call({ op: 'submit', command: { version: 1, scope: scopeA, clientCommandId: 'same-id', body: { kind: 'send', text: 'hello' } } });
  assert.equal(replay.receipt.state.kind, 'completed');
  assert.deepEqual(calls, ['codex', 'sonnet', 'sonnet', 'codex']);
  await page.getByRole('button', { name: 'Recover creation', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: 'Choose a configured agent.' }).waitFor();
  assert.equal(host.installation(droppedScope), null);
  await page.getByRole('combobox', { name: 'Agent for pending creation', exact: true }).selectOption(sonnet.id);
  await page.getByRole('button', { name: 'Recover creation', exact: true }).click();
  await page.waitForFunction(id => document.querySelector('.scope-label')?.textContent === id, droppedScope.conversationId);
  assert.deepEqual(host.installation(droppedScope), b);
  await page.reload();
  await open('a');
  await page.getByText(/no longer configured.*Saved history/).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Send', exact: true }).isDisabled(), true);
  assert.equal(await page.getByRole('button', { name: 'Review the plan', exact: true }).isDisabled(), true);
  assert.equal(await page.getByText('Draft for Codex', { exact: true }).count(), 1);
  assert.match(await page.locator('.composer-footer').textContent(), /Local Codex/);
  await page.screenshot({ path: '.audit/mvp/native-agent-routing-unavailable.png' });
});
