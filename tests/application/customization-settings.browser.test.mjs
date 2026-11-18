import assert from 'node:assert/strict';
import test from 'node:test';
import axe from 'axe-core';
import { chromium } from 'playwright';
import { customizationFixtureFiles, fixtureConnection } from '../support/customization-fixture.mjs';
import { startSession } from '../support/customization-session.mjs';

async function audit(page, label) {
  await page.addScriptTag({ content: axe.source });
  const result = await page.evaluate(async () => window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] } }));
  assert.deepEqual(result.violations.map(violation => `${violation.id}: ${violation.nodes.map(node => node.target.join(' ')).join(', ')}`), [], label);
}
const rail = page => page.getByRole('navigation', { name: 'Workspace views' });
const view = (page, name) => rail(page).getByRole('button', { name, exact: true }).click();
const appearance = page => page.locator('.desktop-shell').getAttribute('data-appearance');
const repository = page => page.getByRole('region', { name: 'Customization repository' });
const preferences = page => page.getByRole('region', { name: 'Appearance and defaults' });

test('Settings connects a repository, commits appearance and the default agent, and turns read-only without the launcher', { timeout: 900_000 }, async t => {
  const s = await startSession(t, { files: customizationFixtureFiles() });
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const open = async () => {
    const page = await (await browser.newContext({ colorScheme: 'light', bypassCSP: true })).newPage();
    page.setDefaultTimeout(30_000);
    await page.goto(`${s.origin}/browser.html`);
    await view(page, 'Settings');
    return page;
  };
  const page = await open();
  let loads = 0;
  page.on('load', () => { loads++; });
  const form = repository(page);
  await form.getByLabel('Repository').waitFor();
  assert.equal(await form.getByLabel('Branch').inputValue(), '', 'no default branch');
  assert.equal(await form.getByLabel('Branch').getAttribute('placeholder'), 'customization');
  await preferences(page).getByText('Settings are stored in the connected customization repository').waitFor();
  assert.equal(await preferences(page).getByRole('radio', { name: 'Dark' }).isDisabled(), true);
  await audit(page, 'settings without a connection');

  // A bad location shows its fixed sentence; main asks for confirmation first.
  await form.getByLabel('Repository').fill('relative/path');
  await form.getByLabel('Branch').fill('customization');
  await form.getByRole('button', { name: 'Connect' }).click();
  await form.getByRole('alert').filter({ hasText: 'That repository location, branch or subdirectory is not valid' }).waitFor();
  await form.getByLabel('Repository').fill(s.remote);
  await form.getByLabel('Branch').fill('main');
  await form.getByRole('button', { name: 'Connect' }).click();
  await form.getByText('AgentUI will push commits directly to main.').waitFor();
  await form.getByRole('button', { name: 'Cancel' }).click();
  await form.getByLabel('Branch').fill('customization');
  await form.getByLabel('Subdirectory').fill('custom');
  await form.getByRole('button', { name: 'Connect' }).click();
  await form.getByText('Connected.').waitFor({ timeout: 60_000 });
  const status = await s.status();
  assert.match(await form.textContent(), new RegExp(status.head.slice(0, 12), 'u'));
  assert.match(await form.textContent(), /customization/u);
  // Disconnect confirms, keeps the build, and returns to the form; connect again for the rest.
  await form.getByRole('button', { name: 'Disconnect' }).click();
  await form.getByText('The applied build keeps running until the next apply.').waitFor();
  await form.getByRole('button', { name: 'Disconnect repository' }).click();
  await form.getByLabel('Repository').waitFor({ timeout: 60_000 });
  assert.equal((await s.status()).connection, null);
  assert.equal(await s.mutate('connect', fixtureConnection(s.remote)), 'ok');
  await form.getByRole('button', { name: 'Sync' }).waitFor({ timeout: 30_000 });

  // Dark: one commit that changes only the settings file, and the page turns dark without a reload.
  const before = s.git(s.remote, 'rev-parse', 'customization');
  await preferences(page).getByRole('radio', { name: 'Dark' }).click();
  await s.until(async () => await appearance(page) === 'dark', 'dark appearance', 60_000);
  assert.equal(loads, 0, 'without a reload');
  const after = s.git(s.remote, 'rev-parse', 'customization');
  assert.equal(s.git(s.remote, 'rev-list', '--count', `${before}..${after}`), '1');
  assert.equal(s.git(s.remote, 'log', '-1', '--format=%s', 'customization'), 'Update AgentUI settings');
  assert.equal(s.git(s.remote, 'diff', '--name-only', before, after), 'custom/agentui-settings.json');
  await audit(page, 'settings connected');
  // A client that loads later starts dark, although its system is light.
  const second = await open();
  await s.until(async () => await appearance(second) === 'dark', 'dark in a second client', 30_000);

  // Apply the fixture so its agents are ready, then choose one as the default agent.
  const built = await s.ready();
  await view(page, 'Extensions');
  await page.getByRole('button', { name: 'Apply and restart' }).click({ timeout: 120_000 });
  await s.until(async () => (await s.status().catch(() => null))?.running.buildKey === built.buildKey, 'applied', 120_000);
  await s.until(async () => (await s.agents().catch(() => [])).includes('beta fixture agent'), 'fixture agents', 60_000);
  await s.until(() => loads >= 1, 'the reload after the apply', 120_000);
  await view(page, 'Settings');
  const select = preferences(page).getByLabel('Default agent');
  await s.until(async () => (await select.locator('option').allTextContents()).includes('beta fixture agent') && await select.isEnabled(), 'the default agent choices', 60_000);
  await select.selectOption({ label: 'beta fixture agent' });
  await s.until(() => s.git(s.remote, 'show', 'customization:custom/agentui-settings.json').includes('"providerAgentId": "fixture"'), 'the stored selector', 60_000);
  const stored = JSON.parse(s.git(s.remote, 'show', 'customization:custom/agentui-settings.json'));
  assert.deepEqual(stored.defaultAgent, { kind: 'provider', namespace: 'beta', installationId: 'personal', providerAgentId: 'fixture' }, 'a portable selector, not a host agent ID');
  await s.until(async () => (await select.inputValue()).includes('"namespace":"beta"') && await select.isEnabled(), 'the page showing the stored default', 30_000);
  await view(page, 'Chats');
  await s.until(() => page.getByRole('button', { name: 'New conversation', exact: true }).isEnabled(), 'new conversation enabled', 30_000);
  await page.getByRole('button', { name: 'New conversation', exact: true }).click();
  await page.locator('#message').waitFor();
  assert.equal(await page.getByRole('button', { name: /^Model, / }).first().textContent(), 'beta fixture agent');

  // A selector that matches nothing on this host: shown as unavailable, and new chats use the host default.
  assert.equal(await s.mutate('settings', { settings: { ...stored, defaultAgent: { kind: 'provider', namespace: 'gamma', installationId: 'personal', providerAgentId: 'fixture' } },
    expectedHead: (await s.status()).head }), 'ok');
  await view(page, 'Settings');
  await preferences(page).locator('.default-agent-unavailable').getByText('Unavailable on this host').waitFor({ timeout: 60_000 });

  // Extension views off: a client that loads afterwards shows the extensions as disabled.
  await preferences(page).getByLabel('Show extension views').click();
  await s.until(() => s.git(s.remote, 'show', 'customization:custom/agentui-settings.json').includes('"showExtensionViews": false'), 'stored switch', 60_000);
  const third = await open();
  await view(third, 'Extensions');
  await s.until(async () => await third.locator('[data-extension="alpha"] .extension-state').textContent().catch(() => '') === 'Disabled', 'disabled views', 30_000);

  // Without the launcher's worker both sections are read-only.
  await s.stopWorker();
  await view(page, 'Settings');
  await repository(page).getByText('The launcher is not connected').waitFor({ timeout: 60_000 });
  assert.equal(await preferences(page).getByRole('radio', { name: 'Light' }).isDisabled(), true);
  assert.equal(await repository(page).getByRole('button', { name: 'Sync' }).count(), 0);
  assert.match(await repository(page).textContent(), /customization/u, 'the last known connection stays readable');
  await audit(page, 'settings read-only');
});
