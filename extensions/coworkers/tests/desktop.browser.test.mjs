import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import axe from 'axe-core';
import { extensionFixture, wait } from '../../../tests/application/browser-support.mjs';
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
async function page(t, host, colorScheme = 'light') {
  const context = await host.browser.newContext({ colorScheme, viewport: { width: 1280, height: 800 } });
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
    const host = await extensionFixture(t, { extensions: [await coworkersEntry(remote)] });
    const view = await page(t, host, colorScheme);
    await openWorkspace(view, 'Coworkers');
    const workspace = view.page.locator('[data-extension-workspace="coworkers"]');
    const appBar = workspace.getByRole('navigation', { name: 'Coworkers app bar' });
    await appBar.getByRole('tab', { name: 'Coworkers' }).click();
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
    assert.deepEqual(await header.getByRole('tab').allTextContents(), ['Chat', 'About']);
    assert.deepEqual(await appBar.getByRole('tab').allTextContents(), ['Chat', 'Coworkers']);
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
    await header.getByRole('tab', { name: 'About' }).click();
    await workspace.getByText('19 bytes').waitFor();
    await header.getByRole('tab', { name: 'Chat' }).click();
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
  const host = await extensionFixture(t, { extensions: [await coworkersEntry(remote)] });
  const view = await page(t, host);
  await openWorkspace(view, 'Coworkers');
  const workspace = view.page.locator('[data-extension-workspace="coworkers"]');
  await workspace.getByRole('tab', { name: 'Coworkers' }).click();
  await workspace.getByRole('button', { name: 'Chat with Grace' }).click();
  await workspace.locator('#message').waitFor();
  for (let created = 1; created < 3; created++) {
    await workspace.getByRole('button', { name: 'New chat', exact: true }).click();
    await wait(async () => (await workspace.locator('.coworkers-chat-card').count()) === created + 1, 'another chat');
  }
  const order = await view.page.evaluate(async () => (await (await fetch('/api/v1', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ op: 'catalog', after: null, limit: 100, filter: { kind: 'provider-agent', namespace: 'coworkers', installationId: 'team', providerAgentId: 'grace' } }) })).json()).value.map(entry => entry.scope.conversationId));
  assert.equal(order.length, 3);
  await workspace.getByRole('tab', { name: 'Coworkers' }).click();
  await workspace.getByRole('button', { name: 'Chat with Grace' }).click();
  await wait(async () => (await workspace.locator('.coworkers-chat-card[aria-current="page"]').count()) === 1, 'a chat is open');
  const selected = await workspace.locator('.coworkers-chat-card[aria-current="page"]').evaluate(node =>
    [...node.closest('ul').querySelectorAll('.coworkers-chat-card')].indexOf(node));
  assert.equal(selected, 0, 'the first chat in catalog order is opened');
  assert.equal(await view.page.evaluate(() => window.location.hash), '', 'no route change');
});

test('without a Coworkers installation the workspace names the configuration and token variable', { timeout: 60_000 }, async t => {
  const host = await extensionFixture(t, { extensions: [] });
  const view = await page(t, host);
  await view.rail.getByRole('button', { name: 'Extensions', exact: true }).click();
  const row = view.page.locator('[data-extension="coworkers"]');
  await wait(async () => (await row.locator('.extension-state').textContent().catch(() => '')) === 'Not configured', 'not configured');
  await view.page.getByRole('button', { name: 'Open Coworkers' }).click();
  const setup = view.page.getByRole('region', { name: 'Coworkers setup' });
  await setup.getByText('AGENTUI_EXTENSION_COWORKERS_TOKEN').waitFor();
  assert.match(await setup.textContent(), /listen on an address this host can reach/);
  assert.equal(await setup.locator('input').count(), 0);
});

test('with both extensions each workspace renders its own transcript style and Chats keeps the default', { timeout: 90_000 }, async t => {
  const remote = await coworkersService(t, { autoReply: true });
  const memberId = randomUUID(), crewToken = 'PRIVATE_CROSS_CREW_TOKEN_5';
  const crewInstance = { namespace: 'crew', installationId: 'personal', generation: '1', protocolVersion: '1' };
  const crew = await crewService(t, { memberId, token: crewToken, instance: crewInstance });
  const host = await extensionFixture(t, { extensions: [await coworkersEntry(remote), { kind: 'installed', directory: fileURLToPath(new URL('crew/', root)),
    manifest: await manifestOf('crew'), installations: [{ id: 'personal', instance: crewInstance, service: crew.origin, expectedAuthority: 'remote-provider',
      authentication: { kind: 'secret', revision: '1', resolve: async () => crewToken } }] }] });
  const view = await page(t, host);
  const chatsComposer = async () => view.page.locator('.chat-view .composer').evaluate(node => { const style = getComputedStyle(node); return [style.backgroundColor, style.borderRadius, style.padding].join('|'); });
  await view.page.getByRole('button', { name: 'New recorded conversation' }).click();
  await view.page.locator('.chat-view #message').waitFor();
  const before = await chatsComposer();

  await openWorkspace(view, 'Crew');
  const crewSpace = view.page.locator('[data-extension-workspace="crew"]');
  await crewSpace.getByRole('button', { name: 'Start conversation' }).click();
  await crewSpace.locator('#message').fill('Hello crew');
  await wait(() => crewSpace.getByRole('button', { name: 'Send', exact: true }).isEnabled(), 'crew send');
  await crewSpace.getByRole('button', { name: 'Send', exact: true }).click();
  await wait(() => crew.receipts.size === 1, 'crew request');
  crew.reply([...crew.conversations.keys()].at(-1), 'Crew says hi');
  await crewSpace.getByRole('region', { name: 'Crew messages' }).getByText('Crew says hi').waitFor();

  await crewSpace.locator('xpath=ancestor::div[contains(@class,"extension-workspace-frame")]').getByRole('button', { name: 'All extensions' }).click();
  await view.page.getByRole('button', { name: 'Open Coworkers' }).click();
  const coworkers = view.page.locator('[data-extension-workspace="coworkers"]');
  await coworkers.getByRole('tab', { name: 'Coworkers' }).click();
  await coworkers.getByRole('button', { name: 'Chat with Ada' }).click();
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
