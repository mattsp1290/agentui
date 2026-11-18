import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import axe from 'axe-core';
import { extensionFixture, extensionTestAssets, wait } from '../../../tests/application/browser-support.mjs';
import { crewService } from './support/crew-service.mjs';

const directory = fileURLToPath(new URL('../', import.meta.url));
const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).agentui.extension;
const token = 'PRIVATE_CREW_BROWSER_TOKEN_19';
const instance = { namespace: 'crew', installationId: 'personal', generation: '1', protocolVersion: '1' };
const shots = process.env.AGENTUI_SCREENSHOT_DIRECTORY;

async function open(t, { configured = true, colorScheme = 'light', operationDeadlineMs } = {}) {
  const first = randomUUID(), second = randomUUID();
  const remote = configured ? await crewService(t, { memberId: first, token, instance, members: [{ memberId: second, engine: 'pi', profile: 'research' }] }) : null;
  const host = await extensionFixture(t, { assets: extensionTestAssets, extensions: remote ? [{ kind: 'installed', directory, manifest, installations: [{ id: 'personal', instance,
    service: remote.origin, expectedAuthority: 'remote-provider', authentication: { kind: 'secret', revision: '1', resolve: async () => token } }] }] : [], operationDeadlineMs });
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

test('after an unknown outcome the member form locks its fields and retries the same request, creating one member', { timeout: 90_000 }, async t => {
  const f = await open(t, { operationDeadlineMs: 1_500 });
  const row = f.page.locator('[data-extension="crew"]');
  await wait(async () => (await row.locator('.extension-state').textContent().catch(() => '')) === 'Ready', 'Crew ready');
  await f.page.getByRole('button', { name: 'Open Crew' }).click();
  const sidebar = f.page.getByRole('navigation', { name: 'Crew members' });
  await sidebar.getByText('pi · research').waitFor();
  await sidebar.getByRole('button', { name: 'Add member', exact: true }).first().click();
  const form = f.page.getByRole('form', { name: 'Add member' });
  const release = Promise.withResolvers();
  f.remote.holdMembers(release.promise);
  await form.getByRole('combobox', { name: 'Engine' }).selectOption('claude');
  await form.getByRole('textbox', { name: 'Profile' }).fill('test');
  await form.getByRole('button', { name: 'Create member' }).click();
  // The host deadline replies before Crew does; Crew still has the request.
  await form.getByRole('alert').getByText('Crew may already have created this member').waitFor();
  const unconfirmed = await form.getByRole('alert').textContent();
  assert.match(unconfirmed, /Cancel stops retrying; Crew may still have created the member, so check the member list\./, 'Cancel does not claim to discard the request');
  assert.doesNotMatch(unconfirmed, /Cancel to discard/);
  for (const field of [form.getByRole('textbox', { name: 'Profile' }), form.getByRole('combobox', { name: 'Engine' }), form.getByRole('textbox', { name: 'Instructions' })]) {
    assert.equal(await field.isDisabled(), true, 'fields stay locked while the outcome is unknown');
  }
  f.remote.holdMembers(null);
  release.resolve();
  await wait(() => f.remote.members.length === 3, 'Crew created the held request');
  await form.getByRole('button', { name: 'Retry' }).click();
  await wait(async () => !(await form.isVisible()), 'the form closes once Crew confirms');
  assert.equal(f.remote.members.length, 3, 'the retry created no second member');
  await wait(async () => (await sidebar.locator('.crew-member-row[aria-current="true"]').textContent()).includes('claude · test'), 'created member selected');
});

test('a member request the host refused before it reached Crew unlocks the form instead of asking for a retry', { timeout: 90_000 }, async t => {
  const f = await open(t);
  const row = f.page.locator('[data-extension="crew"]');
  await wait(async () => (await row.locator('.extension-state').textContent().catch(() => '')) === 'Ready', 'Crew ready');
  await f.page.getByRole('button', { name: 'Open Crew' }).click();
  const sidebar = f.page.getByRole('navigation', { name: 'Crew members' });
  await sidebar.getByText('pi · research').waitFor();
  await sidebar.getByRole('button', { name: 'Add member', exact: true }).first().click();
  const form = f.page.getByRole('form', { name: 'Add member' });
  // The host answers this one call as if the installation had gone away; nothing reaches Crew.
  await f.page.route('**/api/v1', async route => {
    const body = route.request().postDataJSON();
    if (body?.op !== 'extension-call' || body.operation !== 'members.create') return route.continue();
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, value: { kind: 'failed', cause: 'unknown-installation' } }) });
  });
  await form.getByRole('textbox', { name: 'Profile' }).fill('research');
  await form.getByRole('button', { name: 'Create member' }).click();
  await form.getByRole('alert').getByText('This Crew installation is no longer configured. Refresh and try again.').waitFor();
  assert.equal(await form.getByRole('textbox', { name: 'Profile' }).isDisabled(), false, 'the fields are editable again');
  assert.equal(await form.getByRole('button', { name: 'Create member' }).count(), 1, 'a new request, not a retry');
  assert.equal(f.remote.members.length, 2);
});

test('a retry the host refused before it reached Crew keeps the original request and the locked fields', { timeout: 90_000 }, async t => {
  const f = await open(t);
  const row = f.page.locator('[data-extension="crew"]');
  await wait(async () => (await row.locator('.extension-state').textContent().catch(() => '')) === 'Ready', 'Crew ready');
  await f.page.getByRole('button', { name: 'Open Crew' }).click();
  const sidebar = f.page.getByRole('navigation', { name: 'Crew members' });
  await sidebar.getByText('pi · research').waitFor();
  await sidebar.getByRole('button', { name: 'Add member', exact: true }).first().click();
  const form = f.page.getByRole('form', { name: 'Add member' });
  // The first attempt times out with an unknown outcome, the retry finds the installation gone, the third reaches Crew.
  const answers = [{ kind: 'failed', cause: 'timeout' }, { kind: 'failed', cause: 'unknown-installation' }];
  const sent = [];
  await f.page.route('**/api/v1', async route => {
    const body = route.request().postDataJSON();
    if (body?.op !== 'extension-call' || body.operation !== 'members.create') return route.continue();
    sent.push(body.input.requestId);
    const answer = answers.shift();
    if (!answer) return route.continue();
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, value: answer }) });
  });
  await form.getByRole('textbox', { name: 'Profile' }).fill('research');
  await form.getByRole('button', { name: 'Create member' }).click();
  await form.getByRole('alert').getByText('Crew may already have created this member').waitFor();
  await form.getByRole('button', { name: 'Retry' }).click();
  await form.getByRole('alert').getByText('The retry was not sent: this Crew installation is no longer configured.', { exact: false }).waitFor();
  const alert = await form.getByRole('alert').textContent();
  assert.match(alert, /^The retry was not sent: this Crew installation is no longer configured\. Crew may already have created this member\./, 'the earlier outcome is still unknown');
  assert.doesNotMatch(alert, /Refresh and try again/);
  for (const field of [form.getByRole('textbox', { name: 'Profile' }), form.getByRole('combobox', { name: 'Engine' }), form.getByRole('textbox', { name: 'Instructions' })]) {
    assert.equal(await field.isDisabled(), true, 'fields stay locked while the earlier outcome is unknown');
  }
  assert.equal(await form.getByRole('button', { name: 'Create member' }).count(), 0, 'not a new request');
  await form.getByRole('button', { name: 'Retry' }).click();
  await wait(() => sent.length === 3, 'third attempt sent');
  assert.equal(sent[1], sent[0], 'the retry reused the original requestId');
  assert.equal(sent[2], sent[0], 'the next attempt sent the original requestId');
  await wait(async () => !(await form.isVisible()), 'the form closes once Crew confirms');
  assert.equal(f.remote.members.length, 3);
});

test('a create request that settles after Cancel neither closes a newly opened member form nor changes the selection', { timeout: 90_000 }, async t => {
  const f = await open(t);
  const row = f.page.locator('[data-extension="crew"]');
  await wait(async () => (await row.locator('.extension-state').textContent().catch(() => '')) === 'Ready', 'Crew ready');
  await f.page.getByRole('button', { name: 'Open Crew' }).click();
  const sidebar = f.page.getByRole('navigation', { name: 'Crew members' });
  await sidebar.getByText('pi · research').waitFor();
  const current = sidebar.locator('.crew-member-row[aria-current="true"]');
  await wait(async () => (await current.count()) === 1, 'a member selected');
  const before = await current.textContent();
  await sidebar.getByRole('button', { name: 'Add member', exact: true }).first().click();
  const form = f.page.getByRole('form', { name: 'Add member' });
  const release = Promise.withResolvers();
  f.remote.holdMembers(release.promise);
  await form.getByRole('combobox', { name: 'Engine' }).selectOption('claude');
  await form.getByRole('textbox', { name: 'Profile' }).fill('test');
  await form.getByRole('button', { name: 'Create member' }).click();
  await form.getByRole('button', { name: 'Creating…' }).waitFor();
  await form.getByRole('button', { name: 'Cancel', exact: true }).click();
  await wait(async () => !(await form.isVisible()), 'Cancel closes the form while the request is held');

  await sidebar.getByRole('button', { name: 'Add member', exact: true }).first().click();
  await form.getByRole('textbox', { name: 'Profile' }).fill('research');
  f.remote.holdMembers(null);
  release.resolve();
  // The first request completes and the workspace refreshes to show the new member; only then can the old form react.
  await wait(() => f.remote.members.length === 3, 'Crew created the held request');
  await sidebar.getByText('claude · test').waitFor();
  await new Promise(resolve => setTimeout(resolve, 1_000));
  assert.equal(await form.isVisible(), true, 'the newer form stays open');
  assert.equal(await form.getByRole('textbox', { name: 'Profile' }).inputValue(), 'research', 'the newer form keeps its input');
  assert.equal(await current.textContent(), before, 'the selection is unchanged');
});

test('a conversation started from the composer agent control shows its member even after another member was clicked', { timeout: 90_000 }, async t => {
  const f = await open(t);
  const row = f.page.locator('[data-extension="crew"]');
  await wait(async () => (await row.locator('.extension-state').textContent().catch(() => '')) === 'Ready', 'Crew ready');
  await f.page.getByRole('button', { name: 'Open Crew' }).click();
  const workspace = f.page.locator('[data-extension-workspace="crew"]');
  const sidebar = f.page.getByRole('navigation', { name: 'Crew members' });
  const current = sidebar.locator('.crew-member-row[aria-current="true"]');
  await sidebar.getByRole('button', { name: /pi · research/ }).click();
  await wait(async () => (await current.textContent()).includes('pi · research'), 'second member chosen');
  await workspace.getByRole('button', { name: 'Start conversation' }).click();
  await workspace.locator('#message').waitFor();
  await workspace.getByRole('button', { name: /^Model,/ }).click();
  await workspace.getByRole('button', { name: /^Start new chat with .*codex · test/ }).click();
  await wait(async () => (await current.textContent()).includes('codex · test'), 'the new conversation\'s member is current');
  await workspace.locator('#message').waitFor();
  assert.equal(await workspace.locator('.crew-empty-state').count(), 0, 'the new conversation is shown, not an empty state');
  assert.equal(await f.page.locator('#message').count(), 1);
  assert.deepEqual(f.violations, []);
});

/**
 * Two Crew installations, `personal` then `second`. `shared` gives both one member ID. `prepare(page)` runs before the
 * page loads, for routes. `state` is the row state to wait for; only a `Ready` row waits for the member sidebar.
 */
async function twoInstallations(t, { shared = false, prepare, state = 'Ready' } = {}) {
  const otherToken = 'PRIVATE_CREW_BROWSER_TOKEN_20';
  const otherInstance = { ...instance, installationId: 'second' };
  const personalId = randomUUID();
  const personal = await crewService(t, { memberId: personalId, token, instance });
  const other = await crewService(t, { token: otherToken, instance: otherInstance, members: [{ memberId: shared ? personalId : randomUUID(), engine: 'claude', profile: 'other' }] });
  const grant = (id, value, remote, secret) => ({ id, instance: value, service: remote.origin, expectedAuthority: 'remote-provider',
    authentication: { kind: 'secret', revision: '1', resolve: async () => secret } });
  const host = await extensionFixture(t, { assets: extensionTestAssets, extensions: [{ kind: 'installed', directory, manifest,
    installations: [grant('personal', instance, personal, token), grant('second', otherInstance, other, otherToken)] }] });
  const context = await host.browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  page.setDefaultTimeout(20_000);
  await prepare?.(page);
  await page.goto(`${host.origin}/browser.html`);
  await page.getByRole('navigation', { name: 'Workspace views' }).getByRole('button', { name: 'Extensions', exact: true }).click();
  const row = page.locator('[data-extension="crew"]');
  await wait(async () => (await row.locator('.extension-state').textContent().catch(() => '')) === state, `Crew ${state}`);
  // Both installations' agents are in the namespace; wait for both before checking that only one is shown.
  await wait(async () => (await page.evaluate(() => fetch('/api/v1', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ op: 'metadata' }) })
    .then(response => response.json()).then(body => body.value.agents.filter(agent => agent.namespace === 'crew').length))) === 2, 'both installations discovered');
  await page.getByRole('button', { name: 'Open Crew' }).click();
  const sidebar = page.getByRole('navigation', { name: 'Crew members' });
  if (state === 'Ready') await sidebar.getByText('codex · test').waitFor();
  return { page, other, sidebar, workspace: page.locator('[data-extension-workspace="crew"]') };
}
/** Starts a conversation in the shown installation, then one with `label` from the composer's agent control. */
async function startFromComposer(workspace, label) {
  await workspace.getByRole('button', { name: 'Start conversation' }).click();
  await workspace.locator('#message').waitFor();
  await workspace.getByRole('button', { name: /^Model,/ }).click();
  await workspace.getByRole('button', { name: new RegExp(`^Start new chat with .*${label}`) }).click();
}

test('with two Crew installations the workspace shows the first available one, or the one of a conversation started from the composer', { timeout: 90_000 }, async t => {
  const { page, sidebar, workspace } = await twoInstallations(t);
  assert.equal(await sidebar.locator('header strong').textContent(), 'personal');
  assert.deepEqual((await sidebar.locator('.crew-member-label').allTextContents()).filter(label => label.includes('other')), [], 'no member of the second installation');
  assert.equal(await sidebar.locator('.crew-member-row:not(.crew-add-row)').count(), 1);

  // The composer offers every agent of the namespace; a conversation with the second installation's member shows there.
  await workspace.getByRole('button', { name: 'Start conversation' }).click();
  await workspace.locator('#message').waitFor();
  // A member clicked in the first installation must not leave a frame of the second without its member.
  await sidebar.getByRole('button', { name: /codex · test/ }).click();
  await page.evaluate(() => {
    window.sawNoMembers = false;
    new MutationObserver(() => { if (document.body.textContent.includes('This Crew owner has no members yet.')) window.sawNoMembers = true; })
      .observe(document.body, { subtree: true, childList: true, characterData: true });
  });
  await workspace.getByRole('button', { name: /^Model,/ }).click();
  await workspace.getByRole('button', { name: /^Start new chat with .*claude · other/ }).click();
  await wait(async () => (await sidebar.locator('header strong').textContent()) === 'second', 'the second installation is shown');
  await wait(async () => (await sidebar.locator('.crew-member-row[aria-current="true"]').textContent()).includes('claude · other'), 'its member is current');
  await workspace.locator('#message').waitFor();
  assert.equal(await workspace.locator('.crew-empty-state').count(), 0, 'the new conversation is shown, not an empty state');
  assert.equal(await page.locator('#message').count(), 1);
  assert.equal(await page.evaluate(() => window.sawNoMembers), false, 'no frame showed the second installation without its member');
});

test('member details listed for one Crew installation never show for a member of another with the same ID', { timeout: 90_000 }, async t => {
  // The second installation's members.list fails, so only a stale map could supply its member's details.
  const { sidebar, workspace } = await twoInstallations(t, { shared: true, prepare: page => page.route('**/api/v1', async route => {
    const body = route.request().postDataJSON();
    if (body?.op !== 'extension-call' || body.operation !== 'members.list' || body.installationId !== 'second') return route.continue();
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, value: { kind: 'failed', cause: 'unavailable' } }) });
  }) });
  await workspace.getByRole('button', { name: 'Details', exact: true }).click();
  const panel = workspace.getByRole('complementary', { name: 'Member details' });
  await wait(async () => (await panel.locator('dd').nth(1).textContent()) === 'codex', 'the first installation\'s details loaded');
  await startFromComposer(workspace, 'claude · other');
  await wait(async () => (await sidebar.locator('header strong').textContent()) === 'second', 'the second installation is shown');
  await wait(async () => (await workspace.locator('.crew-header-title').textContent()) === 'claude · other', 'its member is shown');
  assert.equal(await panel.locator('dd').nth(1).textContent(), 'Unknown', 'no engine from the other installation');
  assert.equal(await panel.locator('dd').nth(2).textContent(), 'Unknown', 'no profile from the other installation');
  assert.equal(await workspace.locator('.crew-header-meta').count(), 0);
});

test('a conversation of an unavailable Crew installation does not hide the available one', { timeout: 90_000 }, async t => {
  // The host reports `second` unavailable; its agent stays listed, so the composer can still start a conversation with it.
  const { other, sidebar, workspace } = await twoInstallations(t, { prepare: page => page.route('**/api/v1', async route => {
    if (route.request().postDataJSON()?.op !== 'metadata') return route.continue();
    const response = await route.fetch();
    const body = await response.json();
    for (const extension of body.value?.extensions ?? []) {
      extension.installations = extension.installations.map(item => item.installationId === 'second' ? { ...item, status: 'unavailable' } : item);
    }
    await route.fulfill({ response, json: body });
  }) });
  await startFromComposer(workspace, 'claude · other');
  await wait(() => other.conversations.size === 1, 'the conversation was created in the second installation');
  await wait(async () => (await workspace.locator('.crew-empty-state').count()) === 1, 'the available installation is shown');
  assert.equal(await sidebar.locator('header strong').textContent(), 'personal');
  assert.equal(await workspace.getByRole('region', { name: 'Crew unavailable' }).count(), 0);
  assert.deepEqual(await sidebar.locator('.crew-member-label').allTextContents(), ['codex · test']);
});

test('with every Crew installation unavailable the workspace shows the shown installation\'s own reason', { timeout: 90_000 }, async t => {
  // Both installations read unavailable, each with its own reason, and the second installation's agent is listed first.
  const { workspace } = await twoInstallations(t, { state: 'Unavailable', prepare: page => page.route('**/api/v1', async route => {
    if (route.request().postDataJSON()?.op !== 'metadata') return route.continue();
    const response = await route.fetch();
    const body = await response.json();
    for (const extension of body.value?.extensions ?? []) extension.installations = extension.installations.map(item => ({ ...item, status: 'unavailable' }));
    if (body.value) {
      body.value.agents = body.value.agents.map(agent => agent.namespace === 'crew'
        ? { ...agent, availability: { kind: 'unavailable', reason: `Reason of ${agent.installationId}.` } } : agent)
        .sort((a, b) => (b.installationId === 'second') - (a.installationId === 'second'));
    }
    await route.fulfill({ response, json: body });
  }) });
  const region = workspace.getByRole('region', { name: 'Crew unavailable' });
  await region.waitFor();
  assert.equal(await region.getByRole('status').textContent(), 'Reason of personal.');
});

test('a chosen member that is not listed yet falls back to the first member instead of claiming there are none', { timeout: 90_000 }, async t => {
  const f = await open(t);
  const row = f.page.locator('[data-extension="crew"]');
  await wait(async () => (await row.locator('.extension-state').textContent().catch(() => '')) === 'Ready', 'Crew ready');
  await f.page.getByRole('button', { name: 'Open Crew' }).click();
  const sidebar = f.page.getByRole('navigation', { name: 'Crew members' });
  await sidebar.getByText('pi · research').waitFor();
  // From now on metadata never lists the member about to be created, as when its rediscovery has not finished.
  await f.page.route('**/api/v1', async route => {
    if (route.request().postDataJSON()?.op !== 'metadata') return route.continue();
    const response = await route.fetch();
    const body = await response.json();
    if (body.value) body.value.agents = body.value.agents.filter(agent => agent.label !== 'claude · research');
    await route.fulfill({ response, json: body });
  });
  await sidebar.getByRole('button', { name: 'Add member', exact: true }).first().click();
  const form = f.page.getByRole('form', { name: 'Add member' });
  await form.getByRole('combobox', { name: 'Engine' }).selectOption('claude');
  await form.getByRole('textbox', { name: 'Profile' }).fill('research');
  await form.getByRole('button', { name: 'Create member' }).click();
  await form.waitFor({ state: 'detached' });
  assert.equal(f.remote.members.length, 3, 'the member was created');
  const workspace = f.page.locator('[data-extension-workspace="crew"]');
  assert.equal(await workspace.getByText('This Crew owner has no members yet.').count(), 0);
  assert.equal(await workspace.locator('.crew-header-title').textContent(), 'codex · test');
  assert.equal(await sidebar.locator('.crew-member-row[aria-current="true"] .crew-member-label').textContent(), 'codex · test');
});

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
