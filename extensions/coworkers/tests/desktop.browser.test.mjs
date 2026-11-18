import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import axe from 'axe-core';
import { extensionFixture, extensionTestAssets, wait } from '../../../tests/application/browser-support.mjs';
import { coworkersService } from './support/coworkers-service.mjs';
import { crewService } from '../../crew/tests/support/crew-service.mjs';

const root = new URL('../../', import.meta.url);
const manifestOf = async name => JSON.parse(await readFile(new URL(`${name}/package.json`, root), 'utf8')).agentui.extension;
const shots = process.env.AGENTUI_SCREENSHOT_DIRECTORY;
const coworkersInstance = { namespace: 'coworkers', installationId: 'team', generation: '1', protocolVersion: '1' };
async function coworkersEntry(remote) {
  return { kind: 'installed', directory: fileURLToPath(new URL('coworkers/', root)), manifest: await manifestOf('coworkers'), installations: [{ id: 'team',
    instance: coworkersInstance, service: remote.origin, expectedAuthority: 'remote-provider', authentication: { kind: 'secret', revision: '1', resolve: async () => remote.token } }] };
}
async function page(t, host, colorScheme = 'light', viewport = { width: 1280, height: 800 }) {
  const context = await host.browser.newContext({ colorScheme, viewport });
  const page = await context.newPage();
  page.setDefaultTimeout(20_000);
  const violations = [];
  await page.exposeFunction('reportCspViolation', violation => { violations.push(violation); });
  await page.addInitScript(() => document.addEventListener('securitypolicyviolation', event => { void window.reportCspViolation(`${event.effectiveDirective}: ${event.blockedURI}`); }));
  await page.goto(`${host.origin}/browser.html`);
  return { page, violations, rail: page.getByRole('navigation', { name: 'Workspace views' }) };
}
async function openWorkspace(view, label) {
  await view.rail.getByRole('button', { name: 'Extensions', exact: true }).click();
  const row = view.page.locator(`[data-extension="${label.toLowerCase()}"]`);
  await wait(async () => (await row.locator('.extension-state').textContent().catch(() => '')) === 'Ready', `${label} ready`);
  await view.page.getByRole('button', { name: `Open ${label}` }).click();
}
async function audit(page, label) {
  await page.evaluate(axe.source);
  const result = await page.evaluate(async () => window.axe.run(document.querySelector('[data-extension-workspace="coworkers"]'),
    { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] } }));
  assert.deepEqual(result.violations.map(violation => `${violation.id}: ${violation.nodes.map(node => node.target.join(' ')).join(', ')}`), [], label);
}

for (const colorScheme of ['light', 'dark']) {
  test(`the Coworkers workspace (${colorScheme}) lists coworkers, chats with a typing indicator and bubbles, and keeps management disabled`, { timeout: 90_000 }, async t => {
    const remote = await coworkersService(t);
    const host = await extensionFixture(t, { assets: extensionTestAssets, extensions: [await coworkersEntry(remote)] });
    const view = await page(t, host, colorScheme);
    await openWorkspace(view, 'Coworkers');
    const workspace = view.page.locator('[data-extension-workspace="coworkers"]');
    const appBar = workspace.getByRole('navigation', { name: 'Coworkers app bar' });
    await appBar.getByRole('button', { name: 'Coworkers', exact: true }).click();
    const directory = workspace.getByRole('region', { name: 'Coworker directory' });
    await directory.getByText('Ada').waitFor();
    await directory.getByText('Grace').waitFor();
    await directory.getByText('Read and write workspace').waitFor();
    assert.equal(await directory.locator('.coworkers-badge', { hasText: 'Slack' }).count(), 1);
    for (const name of ['New coworker', 'Edit', 'Delete']) {
      for (const button of await directory.getByRole('button', { name, exact: true }).all()) {
        assert.equal(await button.isDisabled(), true, name);
        assert.equal(await button.getAttribute('title'), 'Requires a newer Coworkers service');
      }
    }
    await directory.getByRole('button', { name: 'Chat with Ada' }).click();
    await workspace.locator('#message').waitFor();
    const header = workspace.locator('.coworkers-header');
    assert.deepEqual(await header.getByRole('group', { name: 'Conversation views' }).getByRole('button').allTextContents(), ['Chat', 'About']);
    assert.deepEqual(await appBar.getByRole('group', { name: 'Coworkers sections' }).getByRole('button').allTextContents(), ['Chat', 'Coworkers']);
    await workspace.locator('#message').fill('Hello Ada');
    await wait(() => workspace.getByRole('button', { name: 'Send', exact: true }).isEnabled(), 'send enabled');
    await workspace.getByRole('button', { name: 'Send', exact: true }).click();
    await workspace.getByRole('status', { name: 'Ada is working on a reply' }).waitFor({ timeout: 10_000 });
    remote.complete('Hello from Ada');
    const transcript = workspace.getByRole('region', { name: 'Coworker messages' });
    await transcript.getByText('Hello from Ada').waitFor({ timeout: 10_000 });
    await wait(async () => (await transcript.getByRole('status').count()) === 0, 'typing indicator gone');
    const [mine, theirs] = await Promise.all(['mine', 'theirs'].map(side => transcript.locator(`.coworkers-message[data-side="${side}"] .coworkers-bubble`).first().boundingBox()));
    assert.ok(mine.x > theirs.x, 'your bubble sits right of the coworker bubble');
    assert.equal(await transcript.locator('.coworkers-sender').first().textContent(), 'ADAda');
    await header.getByRole('button', { name: 'About', exact: true }).click();
    await workspace.getByText('19 bytes').waitFor();
    await header.getByRole('button', { name: 'Chat', exact: true }).click();
    await audit(view.page, `Coworkers workspace ${colorScheme}`);
    if (shots) await view.page.screenshot({ path: `${shots}/coworkers-workspace-${colorScheme}.png` });

    await workspace.locator('#message').fill('This one fails');
    await wait(() => workspace.getByRole('button', { name: 'Send', exact: true }).isEnabled(), 'send enabled again');
    await workspace.getByRole('button', { name: 'Send', exact: true }).click();
    await workspace.getByRole('status', { name: 'Ada is working on a reply' }).waitFor({ timeout: 10_000 });
    remote.fail();
    await wait(async () => (await transcript.getByRole('status').count()) === 0, 'failed run ends');
    assert.equal(await transcript.locator('.coworkers-message[data-side="theirs"] .coworkers-bubble').count(), 1, 'no reply bubble for the failed request');
    assert.deepEqual(view.violations, []);
  });
}

test('Chat on a coworker card opens the first of several chats in list order; New chat always creates', { timeout: 60_000 }, async t => {
  const remote = await coworkersService(t, { autoReply: true });
  const host = await extensionFixture(t, { assets: extensionTestAssets, extensions: [await coworkersEntry(remote)] });
  const view = await page(t, host);
  await openWorkspace(view, 'Coworkers');
  const workspace = view.page.locator('[data-extension-workspace="coworkers"]');
  await workspace.getByRole('button', { name: 'Coworkers', exact: true }).click();
  await workspace.getByRole('button', { name: 'Chat with Grace' }).click();
  await workspace.locator('#message').waitFor();
  for (let created = 1; created < 3; created++) {
    await workspace.getByRole('button', { name: 'New chat', exact: true }).click();
    await wait(async () => (await workspace.locator('.coworkers-chat-card').count()) === created + 1, 'another chat');
  }
  const order = await view.page.evaluate(async () => (await (await fetch('/api/v1', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ op: 'catalog', after: null, limit: 100, filter: { kind: 'provider-agent', namespace: 'coworkers', installationId: 'team', providerAgentId: 'grace' } }) })).json()).value.map(entry => entry.scope.conversationId));
  assert.equal(order.length, 3);
  await workspace.getByRole('button', { name: 'Coworkers', exact: true }).click();
  await workspace.getByRole('button', { name: 'Chat with Grace' }).click();
  await wait(async () => (await workspace.locator('.coworkers-chat-card[aria-current="page"]').count()) === 1, 'a chat is open');
  const selected = await workspace.locator('.coworkers-chat-card[aria-current="page"]').evaluate(node =>
    [...node.closest('ul').querySelectorAll('.coworkers-chat-card')].indexOf(node));
  assert.equal(selected, 0, 'the first chat in catalog order is opened');
  assert.equal(await view.page.evaluate(() => window.location.hash), '', 'no route change');
});

test('the directory says when coworkers.list was truncated, and only then', { timeout: 90_000 }, async t => {
  for (const truncated of [false, true]) {
    // The server lists at most 500 coworkers, so 501 is the smallest directory that truncates.
    const coworkers = truncated ? Array.from({ length: 501 }, (_, n) => ({ coworkerId: `c-${n}`, name: `Coworker ${n}`, role: 'Helper',
      workspace: 'read_write', slack: false, instructions: 'i' })) : undefined;
    const remote = await coworkersService(t, coworkers ? { coworkers } : {});
    const host = await extensionFixture(t, { assets: extensionTestAssets, extensions: [await coworkersEntry(remote)] });
    const view = await page(t, host);
    await openWorkspace(view, 'Coworkers');
    const workspace = view.page.locator('[data-extension-workspace="coworkers"]');
    await workspace.getByRole('navigation', { name: 'Coworkers app bar' }).getByRole('button', { name: 'Coworkers', exact: true }).click();
    const directory = workspace.getByRole('region', { name: 'Coworker directory' });
    // Badges come from coworkers.list, so once one shows the list result has been applied.
    await directory.getByText('Read and write workspace').first().waitFor();
    const notice = directory.getByRole('status').filter({ hasText: 'Details for some coworkers were not loaded.' });
    if (truncated) await notice.waitFor();
    assert.equal(await notice.count(), truncated ? 1 : 0, `truncated: ${truncated}`);
  }
});

// Narrow layout: the pane moves to the conversation only when a selection arrives for an attempt still being waited on.
const narrowNavigations = [
  { name: 'a section toggle', async start(workspace, remote) {
    const release = remote.holdConversations();
    await workspace.getByRole('button', { name: 'New chat', exact: true }).click();
    await wait(() => remote.calls.some(call => call.method === 'POST' && call.path === '/v1/conversations'), 'create held');
    // A second attempt while the app is busy resolves at once without changing the selection.
    await workspace.getByRole('button', { name: 'New chat', exact: true }).click();
    return release;
  }, async leave(workspace) {
    const sections = workspace.getByRole('group', { name: 'Coworkers sections' });
    await sections.getByRole('button', { name: 'Coworkers', exact: true }).click();
    await sections.getByRole('button', { name: 'Chat', exact: true }).click();
  } },
  { name: 'Show all', async start(workspace, remote) {
    await workspace.getByRole('button', { name: 'Coworkers', exact: true }).click();
    const release = remote.holdConversations();
    await workspace.getByRole('button', { name: 'Chat with Grace' }).click();
    await wait(() => remote.calls.some(call => call.method === 'POST' && call.path === '/v1/conversations'), 'create held');
    return release;
  }, async leave(workspace) {
    await workspace.getByRole('button', { name: /Show all$/ }).click();
  } },
  { name: 'the Chats back button', async start(workspace, remote) {
    await workspace.getByRole('button', { name: 'New chat', exact: true }).click();
    await wait(async () => await workspace.locator('.coworkers-workspace').getAttribute('data-pane') === 'conversation', 'first chat opens the conversation pane');
    await workspace.getByRole('button', { name: 'Coworkers', exact: true }).click();
    const release = remote.holdConversations();
    await workspace.getByRole('button', { name: 'Chat with Grace' }).click();
    await wait(() => remote.calls.filter(call => call.method === 'POST' && call.path === '/v1/conversations').length === 2, 'create held');
    return release;
  }, async leave(workspace) {
    await workspace.locator('.coworkers-main').getByRole('button', { name: 'Chats', exact: true }).click();
  } },
];
for (const navigation of narrowNavigations) {
  test(`in the narrow layout ${navigation.name} drops the wait, so a later selection keeps the chat list`, { timeout: 60_000 }, async t => {
    const remote = await coworkersService(t);
    const host = await extensionFixture(t, { assets: extensionTestAssets, extensions: [await coworkersEntry(remote)] });
    const view = await page(t, host, 'light', { width: 560, height: 800 });
    await openWorkspace(view, 'Coworkers');
    const workspace = view.page.locator('[data-extension-workspace="coworkers"]');
    const pane = () => workspace.locator('.coworkers-workspace').getAttribute('data-pane');
    assert.ok(await workspace.evaluate(node => node.getBoundingClientRect().width) < 640, 'the workspace is narrow');
    assert.equal(await pane(), 'list');
    assert.equal(await workspace.locator('.coworkers-main').evaluate(node => getComputedStyle(node).display), 'none', 'narrow layout shows one pane');
    const release = await navigation.start(workspace, remote);
    const current = workspace.locator('.coworkers-chat-card[aria-current="page"]');
    assert.equal(await current.count(), 0, 'the held chat is not selected yet');
    await navigation.leave(workspace);
    await wait(async () => await pane() === 'list', 'back on the chat list');
    release();
    // The held creation completes and becomes the selection after the wait was dropped.
    await wait(async () => (await current.count()) === 1, 'the created chat is selected');
    await new Promise(resolve => setTimeout(resolve, 500));
    assert.equal(await pane(), 'list', 'the pane stays on the chat list');
    assert.equal(await workspace.locator('.coworkers-chat-list').isVisible(), true);
  });
}

/** Two Coworkers installations, `team` then `zeta`, both with a coworker `ada`. `prepare(page)` runs before load, for routes. */
async function twoInstallations(t, prepare) {
  const team = await coworkersService(t);
  const other = await coworkersService(t, { token: 'other-coworkers-token', coworkers: [
    { coworkerId: 'ada', name: 'Other Ada', role: 'Elsewhere', workspace: 'disabled', slack: false, instructions: 'Other.' },
    { coworkerId: 'linus', name: 'Linus', role: 'Kernel', workspace: 'disabled', slack: false, instructions: 'Other.' }] });
  const entry = await coworkersEntry(team);
  const otherInstance = { ...coworkersInstance, installationId: 'zeta' };
  entry.installations.push({ id: 'zeta', instance: otherInstance, service: other.origin, expectedAuthority: 'remote-provider',
    authentication: { kind: 'secret', revision: '1', resolve: async () => other.token } });
  const host = await extensionFixture(t, { assets: extensionTestAssets, extensions: [entry] });
  const context = await host.browser.newContext({ viewport: { width: 1280, height: 800 } });
  const view = { page: await context.newPage() };
  view.page.setDefaultTimeout(20_000);
  await prepare?.(view.page);
  await view.page.goto(`${host.origin}/browser.html`);
  view.rail = view.page.getByRole('navigation', { name: 'Workspace views' });
  await view.rail.getByRole('button', { name: 'Extensions', exact: true }).click();
  await wait(async () => (await view.page.evaluate(() => fetch('/api/v1', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ op: 'metadata' }) })
    .then(response => response.json()).then(body => body.value.agents.filter(agent => agent.namespace === 'coworkers').length))) === 4, 'both installations discovered');
  await view.page.getByRole('button', { name: 'Open Coworkers' }).click();
  const workspace = view.page.locator('[data-extension-workspace="coworkers"]');
  return { view, other, workspace, directory: workspace.getByRole('region', { name: 'Coworker directory' }) };
}

test('with two Coworkers installations the workspace shows the first available one, even for a shared coworker ID, or the one of a chat started from the composer', { timeout: 90_000 }, async t => {
  // The second installation's coworkers.list fails, so only a stale result could supply its coworkers' details.
  const { view, workspace, directory } = await twoInstallations(t, page => page.route('**/api/v1', async route => {
    const body = route.request().postDataJSON();
    if (body?.op !== 'extension-call' || body.operation !== 'coworkers.list' || body.installationId !== 'zeta') return route.continue();
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, value: { kind: 'failed', cause: 'unavailable' } }) });
  }));
  await workspace.getByRole('button', { name: 'Coworkers', exact: true }).click();
  await directory.getByText('Grace').waitFor();
  assert.deepEqual((await directory.locator('.coworkers-card strong').allTextContents()).sort(), ['Ada', 'Grace']);
  await directory.getByText('Researcher').waitFor();
  assert.equal(await directory.getByText('Researcher').count(), 1, 'Ada keeps the details of her own installation');

  // The composer offers every agent of the namespace; a chat with the second installation's coworker shows there.
  await directory.getByRole('button', { name: 'Chat with Grace' }).click();
  await workspace.locator('#message').waitFor();
  await workspace.getByRole('button', { name: /^Model,/ }).click();
  await workspace.getByRole('button', { name: /^Start new chat with .*Linus/ }).click();
  await wait(async () => (await workspace.locator('.coworkers-header h2').textContent().catch(() => '')) === 'Linus', 'the second installation\'s coworker is shown');
  await workspace.locator('#message').waitFor();
  assert.equal(await workspace.locator('.coworkers-empty-state').count(), 0, 'the new chat is shown, not an empty state');
  assert.equal(await view.page.locator('#message').count(), 1);
  // The first installation's coworker filter does not carry over: the Linus chat is listed and no filter is offered.
  const chats = workspace.getByRole('region', { name: 'Chats' });
  await chats.locator('.coworkers-chat-card', { hasText: 'Linus' }).waitFor();
  assert.equal(await chats.locator('.coworkers-filter').count(), 0, 'no filter from the other installation');
  // Nor do its coworker details: Other Ada shares Ada's ID, but her role is unknown here.
  await workspace.getByRole('button', { name: 'Coworkers', exact: true }).click();
  await directory.getByText('Other Ada').waitFor();
  assert.equal(await directory.getByText('Researcher').count(), 0, 'no details from the other installation');
  assert.equal(await directory.locator('.coworkers-role').count(), 0);
});

test('a chat of an unavailable Coworkers installation does not hide the available one', { timeout: 90_000 }, async t => {
  // The host reports `zeta` unavailable; its agents stay listed, so the composer can still start a chat with one.
  const { other, workspace, directory } = await twoInstallations(t, page => page.route('**/api/v1', async route => {
    if (route.request().postDataJSON()?.op !== 'metadata') return route.continue();
    const response = await route.fetch();
    const body = await response.json();
    for (const extension of body.value?.extensions ?? []) {
      extension.installations = extension.installations.map(item => item.installationId === 'zeta' ? { ...item, status: 'unavailable' } : item);
    }
    await route.fulfill({ response, json: body });
  }));
  await workspace.getByRole('button', { name: 'Coworkers', exact: true }).click();
  await directory.getByRole('button', { name: 'Chat with Grace' }).click();
  await workspace.locator('#message').waitFor();
  await workspace.getByRole('button', { name: /^Model,/ }).click();
  await workspace.getByRole('button', { name: /^Start new chat with .*Linus/ }).click();
  await wait(() => other.conversations.size === 1, 'the chat was created in the second installation');
  await workspace.getByText('No chat with Grace is open.').waitFor();
  assert.equal(await workspace.getByRole('region', { name: 'Coworkers unavailable' }).count(), 0);
  await workspace.getByRole('button', { name: 'Coworkers', exact: true }).click();
  assert.deepEqual((await directory.locator('.coworkers-card strong').allTextContents()).sort(), ['Ada', 'Grace']);
});

test('with every Coworkers installation unavailable the workspace shows the shown installation\'s own reason', { timeout: 90_000 }, async t => {
  // Both installations read unavailable, each with its own reason, and the second installation's agents are listed first.
  const { workspace } = await twoInstallations(t, page => page.route('**/api/v1', async route => {
    if (route.request().postDataJSON()?.op !== 'metadata') return route.continue();
    const response = await route.fetch();
    const body = await response.json();
    for (const extension of body.value?.extensions ?? []) extension.installations = extension.installations.map(item => ({ ...item, status: 'unavailable' }));
    if (body.value) {
      body.value.agents = body.value.agents.map(agent => agent.namespace === 'coworkers'
        ? { ...agent, availability: { kind: 'unavailable', reason: `Reason of ${agent.installationId}.` } } : agent)
        .sort((a, b) => (b.installationId === 'zeta') - (a.installationId === 'zeta'));
    }
    await route.fulfill({ response, json: body });
  }));
  const region = workspace.getByRole('region', { name: 'Coworkers unavailable' });
  await region.waitFor();
  assert.equal(await region.getByRole('status').textContent(), 'Reason of team.');
});

test('the selected chat still shows when its coworker is no longer listed', { timeout: 90_000 }, async t => {
  const remote = await coworkersService(t);
  const host = await extensionFixture(t, { assets: extensionTestAssets, extensions: [await coworkersEntry(remote)] });
  const view = await page(t, host);
  await openWorkspace(view, 'Coworkers');
  const workspace = view.page.locator('[data-extension-workspace="coworkers"]');
  await workspace.getByRole('button', { name: 'Coworkers', exact: true }).click();
  await workspace.getByRole('button', { name: 'Chat with Ada' }).click();
  await workspace.locator('#message').waitFor();
  // After a reload the host no longer lists Ada, as when she was removed from the service; her chat stays selected.
  await view.page.route('**/api/v1', async route => {
    if (route.request().postDataJSON()?.op !== 'metadata') return route.continue();
    const response = await route.fetch();
    const body = await response.json();
    if (body.value) body.value.agents = body.value.agents.filter(agent => !(agent.namespace === 'coworkers' && agent.providerAgentId === 'ada'));
    await route.fulfill({ response, json: body });
  });
  await view.page.reload();
  await openWorkspace(view, 'Coworkers');
  await workspace.locator('#message').waitFor();
  assert.equal(await workspace.locator('.coworkers-header h2').textContent(), 'ada', 'named by its coworker ID');
  assert.equal(await workspace.getByText('Choose a chat, or open the Coworkers tab to start one.').count(), 0);
  assert.equal(await view.page.locator('#message').count(), 1);
});

test('without a Coworkers installation the workspace names the configuration and token variable', { timeout: 60_000 }, async t => {
  const host = await extensionFixture(t, { assets: extensionTestAssets, extensions: [] });
  const view = await page(t, host);
  await view.rail.getByRole('button', { name: 'Extensions', exact: true }).click();
  const row = view.page.locator('[data-extension="coworkers"]');
  await wait(async () => (await row.locator('.extension-state').textContent().catch(() => '')) === 'Not configured', 'not configured');
  await view.page.getByRole('button', { name: 'Open Coworkers' }).click();
  const setup = view.page.getByRole('region', { name: 'Coworkers setup' });
  await setup.getByText('AGENTUI_EXTENSION_COWORKERS_TOKEN').waitFor();
  assert.match(await setup.textContent(), /listen on an address this host can reach/);
  assert.match(await setup.textContent(), /installation grant to installations in the connected customization repository/);
  assert.equal(await setup.locator('input').count(), 0);
});

test('with both extensions each workspace renders its own transcript style and Chats keeps the default', { timeout: 90_000 }, async t => {
  const remote = await coworkersService(t, { autoReply: true });
  const memberId = randomUUID(), crewToken = 'PRIVATE_CROSS_CREW_TOKEN_5';
  const crewInstance = { namespace: 'crew', installationId: 'personal', generation: '1', protocolVersion: '1' };
  const crew = await crewService(t, { memberId, token: crewToken, instance: crewInstance });
  const host = await extensionFixture(t, { assets: extensionTestAssets, extensions: [await coworkersEntry(remote), { kind: 'installed', directory: fileURLToPath(new URL('crew/', root)),
    manifest: await manifestOf('crew'), installations: [{ id: 'personal', instance: crewInstance, service: crew.origin, expectedAuthority: 'remote-provider',
      authentication: { kind: 'secret', revision: '1', resolve: async () => crewToken } }] }] });
  const view = await page(t, host);
  const chatsComposer = async () => view.page.locator('.chat-view .composer').evaluate(node => { const style = getComputedStyle(node); return [style.backgroundColor, style.borderRadius, style.padding].join('|'); });
  await view.page.getByRole('button', { name: 'New recorded conversation' }).click();
  await view.page.locator('.chat-view #message').waitFor();
  const before = await chatsComposer();
  // The host owns the composer: a workspace stylesheet must not restyle its controls.
  const controlStyle = (locator, keys) => locator.evaluate((node, keys) => { const style = getComputedStyle(node); return keys.map(key => style[key]).join('|'); }, keys);
  const shape = ['fontSize', 'fontWeight', 'paddingTop', 'paddingLeft', 'borderTopWidth', 'borderTopLeftRadius'];
  const send = scope => scope.getByRole('button', { name: 'Send', exact: true });
  const chatsSend = await controlStyle(send(view.page.locator('.chat-view')), [...shape, 'color', 'backgroundColor']);

  await openWorkspace(view, 'Crew');
  const crewSpace = view.page.locator('[data-extension-workspace="crew"]');
  await crewSpace.getByRole('button', { name: 'Start conversation' }).click();
  await crewSpace.locator('#message').waitFor();
  assert.equal(await controlStyle(send(crewSpace), [...shape, 'color', 'backgroundColor']), chatsSend, 'the Crew stylesheet leaves the host Send button alone');
  await crewSpace.locator('#message').fill('Hello crew');
  await wait(() => crewSpace.getByRole('button', { name: 'Send', exact: true }).isEnabled(), 'crew send');
  await crewSpace.getByRole('button', { name: 'Send', exact: true }).click();
  await wait(() => crew.receipts.size === 1, 'crew request');
  crew.reply([...crew.conversations.keys()].at(-1), 'Crew says hi');
  await crewSpace.getByRole('region', { name: 'Crew messages' }).getByText('Crew says hi').waitFor();

  await crewSpace.locator('xpath=ancestor::div[contains(@class,"extension-workspace-frame")]').getByRole('button', { name: 'All extensions' }).click();
  await view.page.getByRole('button', { name: 'Open Coworkers' }).click();
  const coworkers = view.page.locator('[data-extension-workspace="coworkers"]');
  await coworkers.getByRole('button', { name: 'Coworkers', exact: true }).click();
  await coworkers.getByRole('button', { name: 'Chat with Ada' }).click();
  await coworkers.locator('#message').waitFor();
  // The Coworkers palette re-themes the accent for its whole workspace, so the Send button follows that accent and its
  // on-accent text (as the avatar does) while keeping the host's own shape.
  assert.equal(await controlStyle(send(coworkers), shape), chatsSend.split('|').slice(0, shape.length).join('|'), 'the Coworkers stylesheet keeps the host Send shape');
  assert.equal(await controlStyle(send(coworkers), ['color', 'backgroundColor']), await controlStyle(coworkers.locator('.coworkers-header .coworkers-avatar'), ['color', 'backgroundColor']),
    'the Send button keeps on-accent text on the accent');
  await coworkers.locator('#message').fill('Hello coworker');
  await wait(() => coworkers.getByRole('button', { name: 'Send', exact: true }).isEnabled(), 'coworkers send');
  await coworkers.getByRole('button', { name: 'Send', exact: true }).click();
  await coworkers.getByRole('region', { name: 'Coworker messages' }).getByText('Reply: Hello coworker').waitFor({ timeout: 10_000 });
  const crewRow = await view.page.evaluate(() => {
    const probe = document.createElement('div'); probe.setAttribute('data-extension-workspace', 'crew');
    probe.innerHTML = '<li class="crew-message"><span class="crew-avatar">X</span></li>'; document.body.append(probe);
    const style = getComputedStyle(probe.querySelector('.crew-avatar')).borderRadius; probe.remove(); return style;
  });
  assert.equal(crewRow, '8px', 'Crew styles are untouched by the Coworkers stylesheet');

  await view.rail.getByRole('button', { name: 'Chats', exact: true }).click();
  await view.page.locator('.chat-view #message').waitFor();
  assert.equal(await view.page.locator('.chat-view').getByRole('region', { name: 'Coworker messages' }).count(), 0);
  assert.equal(await view.page.locator('.chat-view').getByRole('region', { name: 'Crew messages' }).count(), 0);
  await view.page.locator('.chat-view').getByLabel('Messages', { exact: true }).getByText('Reply: Hello coworker').waitFor();
  assert.equal(await chatsComposer(), before, 'the Chats composer looks the same with both extensions loaded');
  assert.equal(await view.page.locator('#message').count(), 1);
  assert.deepEqual(view.violations, []);
});
