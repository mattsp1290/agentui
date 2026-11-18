import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';
import { chromium } from 'playwright';
import { customizationFixtureFiles, fixtureConnection } from '../support/customization-fixture.mjs';
import { startSession } from '../support/customization-session.mjs';
import { draft } from './browser-support.mjs';

async function applyFromPage(page, s, buildKey) {
  const until = s.until;
  await page.getByRole('navigation', { name: 'Workspace views' }).getByRole('button', { name: 'Extensions', exact: true }).click();
  const apply = page.getByRole('button', { name: 'Apply and restart' });
  await until(() => apply.isVisible(), 'the apply button', 60_000);
  await apply.click();
  // The page reconnects by itself and reloads once, when the restarted host serves the applied build.
  await until(async () => (await s.status().catch(() => null))?.running.buildKey === buildKey, 'the host running the applied build', 120_000);
}
async function pickerAgents(page) {
  await page.getByRole('button', { name: /^Harness, / }).first().click();
  await page.getByRole('button', { name: /^Provider/ }).click();
  const options = page.getByRole('dialog', { name: 'Choose model' }).locator('.composer-picker-option');
  const names = await options.evaluateAll(buttons => buttons.map(button => button.getAttribute('aria-label')));
  await page.keyboard.press('Escape');
  return names;
}

test('apply restarts the host through the wrapper; the page reconnects and reloads by itself, and a disabled extension’s agent is gone', { timeout: 900_000 }, async t => {
  const s = await startSession(t, { files: customizationFixtureFiles() });
  const until = s.until;
  assert.equal(await s.mutate('connect', fixtureConnection(s.remote)), 'ok');
  const first = await until(async () => { const build = (await s.status()).build; return build?.state === 'ready' ? build : build?.state === 'failed' ? assert.fail(JSON.stringify(build)) : null; }, 'first build');
  assert.deepEqual(first.namespaces, ['alpha', 'beta']);
  assert.equal((await s.agents()).some(label => /fixture agent/u.test(label)), false);

  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await (await browser.newContext()).newPage();
  page.setDefaultTimeout(30_000);
  let loads = 0;
  page.on('load', () => { loads++; });
  await page.goto(`${s.origin}/browser.html`);
  await applyFromPage(page, s, first.buildKey);
  await until(() => loads === 2, 'one reload', 60_000);
  assert.deepEqual((await s.agents()).filter(label => /fixture agent/u.test(label)).sort(), ['alpha fixture agent', 'beta fixture agent']);

  // A conversation with the applied extension's agent, and a draft typed in it before the next apply.
  await page.getByRole('navigation', { name: 'Workspace views' }).getByRole('button', { name: 'Chats', exact: true }).click();
  await until(async () => (await pickerAgents(page)).some(name => /alpha fixture agent/u.test(name)), 'the picker after the reload', 30_000);
  await page.getByRole('button', { name: /^Harness, / }).first().click();
  await page.getByRole('button', { name: /^Provider/ }).click();
  await page.getByRole('button', { name: 'Start new chat with alpha fixture agent' }).click();
  await page.locator('#message').waitFor();
  const text = `kept across the restart ${randomBytes(4).toString('hex')}`;
  await draft(page, text);

  // Turn beta off: one commit on the remote, a new build, then apply from the page again.
  const head = (await s.status()).head;
  assert.equal(await s.mutate('toggle', { key: 'ext/beta', enabled: false, expectedHead: head }), 'ok');
  assert.match(s.git(s.remote, 'log', '-1', '--format=%s', 'customization'), /^Disable ext\/beta extension$/u);
  const second = await until(async () => { const build = (await s.status()).build; return build?.state === 'ready' && build.buildKey !== first.buildKey ? build : null; }, 'second build');
  assert.deepEqual(second.namespaces, ['alpha']);
  await applyFromPage(page, s, second.buildKey);
  await until(() => loads === 3, 'the second reload', 60_000);
  assert.deepEqual((await s.agents()).filter(label => /fixture agent/u.test(label)), ['alpha fixture agent']);
  await page.getByRole('navigation', { name: 'Workspace views' }).getByRole('button', { name: 'Chats', exact: true }).click();
  await until(async () => await page.getByRole('textbox', { name: 'Message', exact: true }).inputValue().catch(() => '') === text, 'the draft after the reload', 30_000);
  const picker = await pickerAgents(page);
  assert.ok(picker.some(name => /alpha fixture agent/u.test(name)), picker.join());
  assert.equal(picker.some(name => /beta fixture agent/u.test(name)), false);
  assert.equal(loads, 3, 'each apply reloads exactly once');
  assert.doesNotMatch(s.output(), /alpha-test-token|beta-test-token/u);
});
