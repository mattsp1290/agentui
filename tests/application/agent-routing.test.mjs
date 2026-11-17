import { NO_OBSERVABILITY } from '../../apps/host/build/tsc/observability.js';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createServer } from 'node:http';
import { chromium } from 'playwright';
import { repository, buildCustom } from '../customization/build/support.mjs';
import { readArtifactBytes } from '../../apps/host/build/tsc/artifact.js';
import { serviceEndpoint } from '../../apps/host/build/tsc/service-endpoint.js';
import { SERVICE_WIRE_VERSION, EXTENSION_SDK_VERSION, CODEX_RUNTIME, CODEX_SDK_MODEL, CODEX_SDK_RUNTIME, CLAUDE_SDK_RUNTIMES } from '@agentui/contracts/compatibility';
import { parseServiceRequest, parseServiceResponse } from '@agentui/contracts/service';
import { transcriptProjection } from '@agentui/contracts/conversation';
import { openLocalHost, createRecordedDriver } from '@agentui/host';
import { ownerPrincipal } from '../../apps/host/build/tsc/principal.js';
import { openAccessDatabase } from '../../apps/host/build/tsc/access-database.js';
import { createApi } from '../../apps/host/build/tsc/api.js';
import { FeedRegistry } from '../../apps/host/build/tsc/feed-registry.js';

const installed = (runtime, account) => ({ installationId: 'same-installation-id', binding: {
  engine: runtime.engine, nativeVersion: runtime.version, nativeFormat: runtime.format,
  account, authorizedScope: '/private/workspace',
} });
test('authorized agent API and browser route two recorded agents and retain unavailable history', { timeout: 60000 }, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'agentui-agent-routing-'));
  const path = join(directory, 'host.sqlite'), access = openAccessDatabase(path);
  const feeds = new FeedRegistry(), calls = [];
  const a = installed(CODEX_RUNTIME, 'private-account-a'), b = installed(CLAUDE_SDK_RUNTIMES.sonnet, 'private-account-b');
  const c = installed(CLAUDE_SDK_RUNTIMES.opus, 'private-account-c'), d = installed(CODEX_RUNTIME, 'private-account-d');
  const e = installed(CODEX_SDK_RUNTIME, 'private-account-e');
  const driver = (installation, name) => ({ ...createRecordedDriver({ installation, backendPath: join(directory, `${name}.jsonl`), decodeEvent: transcriptProjection.decodeEvent,
    resolve: async cmd => { calls.push(name); return { kind: 'completed', output: { events: [
      { kind: 'message-updated', messageId: cmd.clientCommandId, revision: 1, role: 'user', text: cmd.body.text, complete: true },
      { kind: 'message-updated', messageId: `${cmd.clientCommandId}:reply`, revision: 1, role: 'assistant', text: `${name} recorded response`, complete: true },
    ], runs: [], decisions: [] } }; } }), installation });
  let host = openLocalHost({ path, projection: transcriptProjection, driver: [driver(a, 'codex'), driver(b, 'sonnet'), driver(d, 'other-codex')], authorize: scope => scope.hostId === access.hostId });
  t.after(async () => { feeds.dispose(); host.close(); await host.drained; access.database.close(); rmSync(directory, { recursive: true, force: true }); });
  const principal = ownerPrincipal(access.hostId);
  const options = { feeds, isClosing: () => false,
    compatibility: { wireVersion: SERVICE_WIRE_VERSION, extensionSdkVersion: EXTENSION_SDK_VERSION, nativeRuntime: CODEX_RUNTIME,
      desiredGitRevision: 'test', appliedArtifact: { artifactId: 'test', gitRevision: 'test' } } };
  const configuredAgents = [
    { installation: a, name: 'Project A', availability: { kind: 'ready' } }, { installation: b, availability: { kind: 'ready' } },
    { installation: c, availability: { kind: 'unavailable', reason: 'Optional agent unavailable' } },
    { installation: d, model: { id: 'remote-fixture', label: 'GPT-6.1 Sol' }, name: 'Project B', availability: { kind: 'ready' } },
    { installation: e, availability: { kind: 'ready' } },
  ];
  let api = createApi({ ...options, host, agentSelection: { kind: 'native', defaultInstallation: a, agents: configuredAgents } });
  const call = async request => parseServiceResponse(request, { ok: true, value: await api(principal, parseServiceRequest(request)) }).value;
  const metadata = await call({ op: 'metadata' });
  assert.doesNotMatch(JSON.stringify(metadata), /private-account|private\/workspace|same-installation-id/);
  const [codex, sonnet, opus] = metadata.agents;
  assert.equal(new Set(metadata.agents.map(agent => agent.id)).size, 5);
  assert.deepEqual(metadata.agents[4].model, { id: 'gpt-6.1-sol', label: 'GPT-6.1 Sol' });
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
  const restricted = createApi({ ...options, host, agentSelection: { kind: 'native', defaultInstallation: b, agents: [
    { installation: a, selectable: false, availability: { kind: 'ready' } },
    { installation: d, model: { id: 'older-version', label: 'Older version' }, selectable: false, availability: { kind: 'ready' } },
    { installation: b, availability: { kind: 'ready' } },
  ] } });
  const restrictedMetadata = await restricted(principal, { op: 'metadata' });
  assert.deepEqual(restrictedMetadata.agents.map(agent => agent.id), [sonnet.id]);
  assert.equal((await restricted(principal, { op: 'conversation-agent', scope: scopeA })).availability.kind, 'ready');
  assert.deepEqual(await restricted(principal, { op: 'create', scope: scopeA, agentId: codex.id }), scopeA);
  for (const agent of [codex, metadata.agents[3]]) {
    await assert.rejects(restricted(principal, { op: 'create', scope: { ...scopeA, conversationId: 'hidden-agent' }, agentId: agent.id }), /Choose an available agent/);
  }

  const custom = repository();
  t.after(() => rmSync(custom.directory, { recursive: true, force: true }));
  buildCustom(custom);
  const assets = readArtifactBytes(join(custom.directory, 'browser'), 'browser-development');
  const handler = serviceEndpoint({ observability: NO_OBSERVABILITY, hostId: access.hostId, api: (principal, request) => api(principal, request), client: 'browser-development', files: assets.files, isClosing: () => false });
  const server = createServer((request, response) => { void handler(request, response); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch();
  t.after(async () => { await browser.close(); await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); });
  const context = await browser.newContext();
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  await page.goto(`${origin}/browser.html`);
  const open = async id => {
    await page.getByRole('button', { name: new RegExp(`Open conversation ${id}$`) }).click();
    await page.waitForFunction(expected => document.querySelector('.scope-label')?.textContent === expected, id);
    await page.getByRole('status').filter({ hasText: 'Conversation connected' }).first().waitFor();
  };
  const originalApi = api;
  api = createApi({ ...options, host, agentSelection: { kind: 'native', defaultInstallation: e, agents: configuredAgents } });
  await page.reload();
  await page.getByRole('button', { name: 'Model, GPT-6.1 Sol', exact: true }).click();
  const collidingChoice = page.getByRole('button', { name: 'Start new chat with Project B · GPT-6.1 Sol', exact: true });
  assert.equal(await collidingChoice.getAttribute('aria-current'), null);
  assert.equal(await collidingChoice.isEnabled(), true);
  assert.equal(await page.locator('.composer-picker-option[aria-current="true"]').count(), 0);
  await page.keyboard.press('Escape');
  const matchingAgents = configuredAgents.map(entry => entry.installation === d
    ? { ...entry, model: { id: CODEX_SDK_MODEL.id, label: 'Remote Sol name' } } : entry);
  api = createApi({ ...options, host, agentSelection: { kind: 'native', defaultInstallation: e, agents: matchingAgents } });
  await page.reload();
  await page.getByRole('button', { name: 'Model, GPT-6.1 Sol', exact: true }).click();
  const sdkWelcomeChoice = page.getByRole('button', { name: 'Start new chat with Project B · Remote Sol name', exact: true });
  assert.equal(await sdkWelcomeChoice.getAttribute('aria-current'), 'true');
  assert.equal(await sdkWelcomeChoice.isEnabled(), true);
  assert.equal(await page.locator('.composer-picker-option[aria-current="true"]').count(), 1);
  await page.keyboard.press('Escape');
  const sdkScope = { hostId: access.hostId, conversationId: 'sdk-selection' };
  await call({ op: 'create', scope: sdkScope, agentId: metadata.agents[4].id });
  await page.reload();
  await open(sdkScope.conversationId);
  await page.getByRole('button', { name: 'Model, GPT-6.1 Sol', exact: true }).click();
  const sdkCurrentChoice = page.getByRole('button', { name: 'Project B · Remote Sol name, current model', exact: true });
  assert.equal(await sdkCurrentChoice.getAttribute('aria-current'), 'true');
  assert.equal(await sdkCurrentChoice.isDisabled(), true);
  assert.equal(await page.locator('.composer-picker-option[aria-current="true"]').count(), 1);
  assert.deepEqual(host.installation(sdkScope), e);
  await page.keyboard.press('Escape');
  api = createApi({ ...options, host, agentSelection: { kind: 'native', defaultInstallation: e, agents: configuredAgents } });
  await page.reload();
  await open(sdkScope.conversationId);
  await page.getByRole('button', { name: 'Model, GPT-6.1 Sol', exact: true }).click();
  const collidingCurrentChoice = page.getByRole('button', { name: 'Start new chat with Project B · GPT-6.1 Sol', exact: true });
  assert.equal(await collidingCurrentChoice.isEnabled(), true);
  assert.equal(await collidingCurrentChoice.getAttribute('aria-current'), null);
  assert.equal(await page.locator('.composer-picker-option[aria-current="true"]').count(), 0);
  assert.deepEqual(host.installation(sdkScope), e);
  await page.keyboard.press('Escape');
  api = originalApi;
  await page.reload();
  const message = page.getByRole('textbox', { name: 'Message', exact: true });
  assert.equal(await page.getByRole('combobox', { name: 'Agent for new chat', exact: true }).count(), 0);
  await open('a');
  assert.match(await page.locator('.composer-footer').textContent(), /Local Codex/);
  assert.deepEqual(await page.getByRole('group', { name: 'Chat settings', exact: true }).getByRole('button').allTextContents(), ['Codex', 'Select model', 'Default']);
  assert.equal(await page.getByRole('button', { name: 'Effort, Default. Managed by the host.', exact: true }).isDisabled(), true);
  await message.fill('Draft for Codex');
  await open('b');
  assert.match(await page.locator('.composer-footer').textContent(), /Claude.*Sonnet/);
  await message.fill('Draft for Sonnet');
  await page.screenshot({ path: '.audit/mvp/native-agent-routing-sonnet.png' });
  await open('a');
  assert.equal(await message.inputValue(), 'Draft for Codex');
  const harness = page.getByRole('button', { name: /^Harness,/ });
  const model = page.getByRole('button', { name: /^Model,/ });
  mkdirSync('.audit/composer', { recursive: true });
  await model.click();
  assert.equal(await page.getByRole('button', { name: 'Project A · Codex, current model', exact: true }).count(), 0);
  assert.equal(await page.getByRole('dialog', { name: 'Choose model' }).locator('small, p').count(), 0);
  assert.doesNotMatch(await page.getByRole('dialog', { name: 'Choose model' }).textContent(), /Host default|Start new chat|Current|subscription/);
  assert.equal(await page.getByRole('button', { name: `Start new chat with ${metadata.agents[4].label}`, exact: true }).count(), 0);
  assert.equal(await page.getByRole('button', { name: 'Start new chat with Project B · GPT-6.1 Sol', exact: true }).count(), 1);
  await page.screenshot({ path: '.audit/composer/model-menu.png' });
  await page.getByRole('button', { name: 'Start new chat with Project B · GPT-6.1 Sol', exact: true }).click();
  await page.getByRole('button', { name: 'Model, GPT-6.1 Sol', exact: true }).waitFor();
  const modelScope = { hostId: access.hostId, conversationId: await page.locator('.scope-label').textContent() };
  assert.deepEqual(host.installation(modelScope), d);
  await page.reload();
  await page.getByRole('button', { name: 'Model, GPT-6.1 Sol', exact: true }).waitFor();
  await open('a');
  await model.click();
  await page.keyboard.press('Escape');
  assert.equal(await model.evaluate(node => node === document.activeElement), true);
  await harness.click();
  assert.match(await page.getByRole('button', { name: 'Codex', exact: true }).textContent(), /1 available/);
  const piSetup = page.getByRole('button', { name: 'Pi, set up OpenCode Go', exact: true });
  assert.equal(await piSetup.isEnabled(), true);
  await page.screenshot({ path: '.audit/composer/harness-menu.png' });
  await piSetup.click();
  const piSettings = page.getByRole('region', { name: 'Pi and OpenCode Go', exact: true });
  await piSettings.waitFor();
  assert.match(await piSettings.textContent(), /This host does not offer Pi/);
  assert.equal(await piSettings.getByRole('textbox').count(), 0);
  await page.getByRole('button', { name: 'Chats', exact: true }).click();
  assert.equal(await message.inputValue(), 'Draft for Codex');
  await harness.click();
  await page.getByRole('button', { name: 'Claude', exact: true }).click();
  assert.equal(await page.getByRole('button', { name: `Start new chat with ${opus.label}`, exact: true }).isDisabled(), true);
  assert.equal(await page.getByRole('button', { name: `Start new chat with ${sonnet.label}`, exact: true }).isEnabled(), true);
  assert.match(await page.locator('.composer-footer').textContent(), /Local Codex/);
  assert.equal(await message.inputValue(), 'Draft for Codex');
  let loseCreate = true, dropCreate = false, droppedScope;
  const createRequests = [], recoveryResponses = [];
  await page.route('**/api/v1', async route => {
    if (route.request().postDataJSON().op === 'create') createRequests.push(route.request().postDataJSON());
    if (dropCreate && route.request().postDataJSON().op === 'create') {
      dropCreate = false; droppedScope = route.request().postDataJSON().scope; await route.abort();
    } else if (loseCreate && route.request().postDataJSON().op === 'create') {
      loseCreate = false; await route.fetch(); await route.abort();
    } else await route.continue();
  });
  await page.getByRole('button', { name: `Start new chat with ${sonnet.label}`, exact: true }).click();
  await page.getByRole('button', { name: 'Recover creation', exact: true }).waitFor();
  assert.equal(await harness.isDisabled(), true);
  assert.equal(await model.isDisabled(), true);
  await page.reload();
  await page.getByRole('button', { name: 'Recover creation', exact: true }).waitFor();
  assert.equal(await page.getByRole('combobox', { name: 'Agent for pending creation', exact: true }).count(), 0);
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
  await harness.click();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.keyboard.press('Escape');
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
  dropCreate = true;
  await page.getByRole('button', { name: 'New conversation', exact: true }).click();
  await page.getByRole('button', { name: 'Recover creation', exact: true }).waitFor();
  assert.equal(host.installation(droppedScope), null);
  host.close(); await host.drained;
  host = openLocalHost({ path, projection: transcriptProjection, driver: [driver(b, 'sonnet')], authorize: scope => scope.hostId === access.hostId });
  api = createApi({ ...options, host, agentSelection: { kind: 'native', defaultInstallation: b, agents: [{ installation: b, availability: { kind: 'ready' } }] } });
  assert.equal((await call({ op: 'metadata' })).defaultAgentId, sonnet.id);
  const removed = await call({ op: 'conversation-agent', scope: scopeA });
  assert.equal(removed.id, codex.id); assert.equal(removed.availability.kind, 'unavailable');
  assert.deepEqual(await call({ op: 'create', scope: scopeA, agentId: codex.id }), scopeA);
  await assert.rejects(call({ op: 'create', scope: scopeA, agentId: sonnet.id }), /already belongs/);
  const replay = await call({ op: 'submit', command: { version: 1, scope: scopeA, clientCommandId: 'same-id', body: { kind: 'send', text: 'hello' } } });
  assert.equal(replay.receipt.state.kind, 'completed');
  assert.deepEqual(calls, ['codex', 'sonnet', 'sonnet', 'codex']);
  page.on('response', response => {
    if (response.request().postDataJSON()?.op === 'create') recoveryResponses.push(response);
  });
  await page.getByRole('button', { name: 'Recover creation', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: 'This conversation was not created. Choose an available agent for a new conversation.' }).waitFor();
  assert.equal(createRequests.at(-1).agentId, codex.id);
  assert.deepEqual(createRequests.at(-1).scope, droppedScope);
  assert.equal(recoveryResponses.at(-1).status(), 409);
  assert.equal((await recoveryResponses.at(-1).json()).error.kind, 'create-rejected');
  assert.equal(host.installation(droppedScope), null);
  assert.equal(await page.locator('.creation-recovery').count(), 0);
  await page.reload();
  await harness.click();
  await page.getByRole('button', { name: 'Claude', exact: true }).click();
  await page.getByRole('button', { name: `Start new chat with ${sonnet.label}`, exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.creation-recovery') === null && document.querySelector('.composer-footer')?.textContent?.includes('Sonnet'));
  const newScope = createRequests.at(-1).scope;
  assert.notDeepEqual(newScope, droppedScope);
  assert.equal(createRequests.at(-1).agentId, sonnet.id);
  assert.deepEqual(host.installation(newScope), b);
  assert.equal(host.installation(droppedScope), null);
  assert.deepEqual(calls, ['codex', 'sonnet', 'sonnet', 'codex']);
  await page.reload();
  await open('a');
  await page.getByText(/no longer configured.*Saved history/).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Send', exact: true }).isDisabled(), true);
  assert.equal(await page.getByRole('button', { name: 'Review the plan', exact: true }).isDisabled(), true);
  assert.equal(await page.getByText('Draft for Codex', { exact: true }).count(), 1);
  assert.match(await page.locator('.composer-footer').textContent(), /Local Codex/);
  await model.click();
  assert.equal(await page.getByRole('button', { name: 'Codex, current model', exact: true }).count(), 0);
  await page.keyboard.press('Escape');
  await page.screenshot({ path: '.audit/mvp/native-agent-routing-unavailable.png' });
});
