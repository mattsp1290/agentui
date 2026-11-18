import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import axe from 'axe-core';
import { extensionFixture, wait } from '../../../tests/application/browser-support.mjs';
import { crewService } from './support/crew-service.mjs';

const directory = fileURLToPath(new URL('../', import.meta.url));
const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).agentui.extension;
const token = 'PRIVATE_CREW_BROWSER_TOKEN_19';
const instance = { namespace: 'crew', installationId: 'personal', generation: '1', protocolVersion: '1' };
const shots = process.env.AGENTUI_SCREENSHOT_DIRECTORY;

async function open(t, { configured = true, colorScheme = 'light' } = {}) {
  const first = randomUUID(), second = randomUUID();
  const remote = configured ? await crewService(t, { memberId: first, token, instance, members: [{ memberId: second, engine: 'pi', profile: 'research' }] }) : null;
  const host = await extensionFixture(t, { extensions: remote ? [{ kind: 'installed', directory, manifest, installations: [{ id: 'personal', instance,
    service: remote.origin, expectedAuthority: 'remote-provider', authentication: { kind: 'secret', revision: '1', resolve: async () => token } }] }] : [] });
  const context = await host.browser.newContext({ colorScheme, viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  page.setDefaultTimeout(20_000);
  const violations = [], requests = [];
  await page.exposeFunction('reportCspViolation', violation => { violations.push(violation); });
  await page.addInitScript(() => document.addEventListener('securitypolicyviolation', event => { void window.reportCspViolation(`${event.effectiveDirective}: ${event.blockedURI}`); }));
  page.on('request', request => requests.push(request.url()));
  await page.goto(`${host.origin}/browser.html`);
  const rail = page.getByRole('navigation', { name: 'Workspace views' });
  await rail.getByRole('button', { name: 'Extensions', exact: true }).click();
  return { remote, host, page, rail, violations, requests, first, second };
}
async function audit(page, label) {
  // Evaluated through the browser protocol, so the page's own CSP stays enforced for everything else.
  await page.evaluate(axe.source);
  const result = await page.evaluate(async () => window.axe.run(document.querySelector('[data-extension-workspace="crew"]'),
    { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] } }));
  assert.deepEqual(result.violations.map(violation => `${violation.id}: ${violation.nodes.map(node => node.target.join(' ')).join(', ')}`), [], label);
}

for (const colorScheme of ['light', 'dark']) {
  test(`the Crew workspace (${colorScheme}) lists members, creates one, chats with it and refuses an unknown profile`, { timeout: 90_000 }, async t => {
    const f = await open(t, { colorScheme });
    const row = f.page.locator('[data-extension="crew"]');
    await wait(async () => (await row.locator('.extension-state').textContent().catch(() => '')) === 'Ready', 'Crew ready');
    await f.page.getByRole('button', { name: 'Open Crew' }).click();
    const sidebar = f.page.getByRole('navigation', { name: 'Crew members' });
    await sidebar.getByText('codex · test').waitFor();
    await sidebar.getByText('pi · research').waitFor();

    await sidebar.getByRole('button', { name: 'Add member', exact: true }).first().click();
    const form = f.page.getByRole('form', { name: 'Add member' });
    await form.getByRole('textbox', { name: 'Profile' }).fill('missing');
    await form.getByRole('button', { name: 'Create member' }).click();
    await form.getByRole('alert').getByText('Crew has no profile with that name').waitFor();
    assert.equal(await form.isVisible(), true, 'the form stays open after a refusal');
    await form.getByRole('combobox', { name: 'Engine' }).selectOption('claude');
    await form.getByRole('textbox', { name: 'Profile' }).fill('research');
    await form.getByRole('button', { name: 'Create member' }).click();
    await sidebar.getByText('claude · research').waitFor();
    await wait(async () => (await sidebar.locator('.crew-member-row[aria-current="true"]').textContent()).includes('claude · research'), 'new member selected');
    const created = f.remote.members.at(-1);
    assert.equal(f.remote.members.length, 3);

    await f.page.getByRole('button', { name: 'Start conversation' }).click();
    const workspace = f.page.locator('[data-extension-workspace="crew"]');
    await workspace.locator('#message').fill('Hello crew member');
    await wait(async () => await workspace.getByRole('button', { name: 'Send', exact: true }).isEnabled(), 'send enabled');
    await workspace.getByRole('button', { name: 'Send', exact: true }).click();
    await wait(() => f.remote.receipts.size === 1, 'Crew request');
    const conversationId = [...f.remote.conversations.keys()].at(-1);
    assert.equal(f.remote.conversations.get(conversationId).state.memberId, created.memberId);
    f.remote.reply(conversationId, 'Crew member reply');
    const transcript = workspace.getByRole('region', { name: 'Crew messages' });
    await transcript.getByText('Crew member reply').waitFor();

    const rows = transcript.locator('li.crew-message');
    assert.ok(await rows.count() >= 2);
    assert.equal(await transcript.locator('.message, [class*="bubble"]').count(), 0, 'flat rows, no bubble containers');
    assert.equal(await rows.first().locator('.crew-sender').textContent(), 'You');
    const [sidebarColor, mainColor] = await workspace.evaluate(node => [getComputedStyle(node.querySelector('.crew-sidebar')).backgroundColor,
      getComputedStyle(node.querySelector('.crew-main')).backgroundColor]);
    assert.notEqual(sidebarColor, mainColor);
    await audit(f.page, `Crew workspace ${colorScheme}`);
    if (shots) await f.page.screenshot({ path: `${shots}/crew-workspace-${colorScheme}.png` });
    assert.deepEqual(f.violations, []);
  });
}

test('without a Crew installation the workspace shows setup guidance and calls nothing but the host', { timeout: 60_000 }, async t => {
  const f = await open(t, { configured: false });
  const row = f.page.locator('[data-extension="crew"]');
  await wait(async () => (await row.locator('.extension-state').textContent().catch(() => '')) === 'Not configured', 'Crew not configured');
  await f.page.getByRole('button', { name: 'Open Crew' }).click();
  const setup = f.page.getByRole('region', { name: 'Crew setup' });
  await setup.getByText('AGENTUI_EXTENSION_CREW_TOKEN').waitFor();
  await setup.getByText('~/.local/share/agentui/extensions.json').waitFor();
  assert.equal(await setup.locator('input').count(), 0, 'no token entry field');
  assert.deepEqual(f.requests.filter(url => !url.startsWith(f.host.origin)), []);
  assert.deepEqual(f.violations, []);
});
