import assert from 'node:assert/strict';
import test from 'node:test';
import axe from 'axe-core';
import { EXTENSION_SDK_VERSION } from '@agentui/sdk';
import { customRuntime, draft, extensionFixture, extensionTestAssets, fixture, revealRecovery, wait } from './browser-support.mjs';
import { ledgerExtension, ledgerService } from '../extensions/providers/conformance/ledger.mjs';

/** The ledger conformance provider plus one echo operation. Its namespace is `ledger`, so the UI entry uses it too. */
async function ledgerWithEcho(t) {
  const service = await ledgerService(t);
  const ledger = ledgerExtension({ service: service.origin, key: service.key, supports: { cancel: true, decide: false } });
  const inner = ledger.value.entry;
  const entry = { ...inner, activate(context) {
    context.operations.add('echo', { async run({ input, installation }) { return { kind: 'ok', output: { input, installationId: installation.instance.installationId } }; } });
    return inner.activate(context);
  } };
  return { service, value: { ...ledger.value, entry } };
}

const workspaceEntry = `load: async () => ({ default: { kind: 'desktop', sdkVersion: '${EXTENSION_SDK_VERSION}', activate() {
  function Transcript({ activity }) {
    return <section aria-label="Workspace transcript">{activity.domain.messages.map(message => <p key={message.messageId}>{message.role}: {message.text}</p>)}</section>;
  }
  function Workspace(props) {
    window.workspace = props;
    if (window.breakWorkspace) throw new Error('Workspace render failed');
    const [echo, setEcho] = React.useState('');
    return <div aria-label="Ledger workspace" role="region">
      <ul aria-label="Workspace agents">{props.agents.map(agent => <li key={agent.id}>{agent.label} · {agent.providerAgentId}
        <button type="button" onClick={() => void props.create(agent.id)}>Start with {agent.label}</button></li>)}</ul>
      <ul aria-label="Workspace conversations">{props.conversations.entries.map(entry => <li key={entry.scope.conversationId}>
        <button type="button" onClick={() => void props.open(entry.scope)}>Open {entry.scope.conversationId}</button></li>)}</ul>
      <button type="button" onClick={async () => setEcho(JSON.stringify(await props.call(props.installations[0]?.installationId ?? 'books', 'echo', { ping: 1 })))}>Call echo</button>
      <output aria-label="Echo result">{echo}</output>
      <div className="workspace-conversation">{props.conversation}</div>
    </div>;
  }
  return { modules: [], workspace: { label: 'Ledger workspace', component: Workspace, transcript: Transcript }, dispose() {} };
} } })`;
const noViewEntry = `load: async () => ({ default: { kind: 'desktop', sdkVersion: '${EXTENSION_SDK_VERSION}', activate() { return { modules: [], dispose() {} }; } } })`;
const ledgerManifest = `{ manifest: { namespace: 'ledger', trust: 'full', sdkVersion: '${EXTENSION_SDK_VERSION}', entries: [{ kind: 'desktop', module: './desktop.js' }] }, ${workspaceEntry} }`;

async function open(t) {
  const ledger = await ledgerWithEcho(t);
  const host = await extensionFixture(t, { extensions: [ledger.value] });
  const page = await host.page();
  await page.getByRole('button', { name: 'New recorded conversation' }).click();
  await page.locator('#message').waitFor();
  await customRuntime(page, host, noViewEntry, false, `, ${ledgerManifest}`);
  const rail = page.getByRole('navigation', { name: 'Workspace views' });
  return { ledger, host, page, rail };
}
const row = (page, namespace) => page.locator(`[data-extension="${namespace}"]`);
async function openWorkspace(f) {
  await f.rail.getByRole('button', { name: 'Extensions', exact: true }).click();
  await f.page.getByRole('button', { name: 'Open Ledger workspace' }).click();
  await f.page.getByRole('region', { name: 'Ledger workspace' }).waitFor();
}
async function audit(page, label) {
  await page.addScriptTag({ content: axe.source });
  // The injected custom.html test page has no title or lang; those belong to the fixture page, not the view.
  const result = await page.evaluate(async () => window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] },
    rules: { 'document-title': { enabled: false }, 'html-has-lang': { enabled: false } } }));
  assert.deepEqual(result.violations.map(violation => violation.id), [], label);
}

test('the Extensions view lists namespaces, opens a workspace, creates, chats and calls its operation through the host', { timeout: 90_000 }, async t => {
  const f = await open(t);
  await f.rail.getByRole('button', { name: 'Extensions', exact: true }).click();
  assert.equal(await row(f.page, 'ledger').locator('.extension-state').textContent(), 'Ready');
  assert.match(await row(f.page, 'ledger').textContent(), /Ledger workspace/);
  assert.equal(await row(f.page, 'fixture').locator('.extension-state').textContent(), 'No view');
  assert.equal(await row(f.page, 'fixture').getByRole('button').count(), 0);
  await audit(f.page, 'extensions list');
  await f.page.getByRole('button', { name: 'Open Ledger workspace' }).click();
  const workspace = f.page.getByRole('region', { name: 'Ledger workspace' });
  await workspace.getByText('Ledger desk · desk-1').waitFor();
  assert.equal(await f.page.locator('[data-extension-workspace="ledger"]').count(), 1);
  assert.deepEqual(await f.page.evaluate(() => window.workspace.agents.map(agent => [agent.label, agent.installationId, agent.providerAgentId])), [['Ledger desk', 'books', 'desk-1']]);

  const recordedId = await f.page.evaluate(() => fetch('/api/v1', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ op: 'metadata' }) })
    .then(response => response.json()).then(body => body.value.agents.find(agent => !('kind' in agent)).id));
  assert.equal(await f.page.evaluate(id => window.workspace.create(id).then(() => 'resolved', error => error.message), recordedId), 'This agent is not part of this extension.');
  assert.equal(await f.page.evaluate(() => window.workspace.open({ hostId: 'x', conversationId: 'y' }).then(() => 'resolved', error => error.message)), 'This conversation is not in this extension.');

  await workspace.getByRole('button', { name: 'Start with Ledger desk' }).click();
  await workspace.locator('#message').waitFor();
  assert.equal(await f.page.locator('#message').count(), 1);
  await wait(() => f.page.evaluate(() => window.workspace.selected !== null && window.workspace.conversations.entries.length === 1), 'workspace selection');
  // The composer's agent control inside the workspace offers only this namespace's agents.
  const composerText = await workspace.locator('.composer').textContent();
  assert.doesNotMatch(composerText, /Recorded/);

  await draft(f.page, 'Hello ledger');
  await workspace.getByRole('button', { name: 'Send', exact: true }).click();
  await wait(() => f.ledger.service.rooms.size === 1 && [...f.ledger.service.rooms.values()][0].open !== null, 'ledger send');
  f.ledger.service.reply('Ledger reply');
  await workspace.getByRole('region', { name: 'Workspace transcript' }).getByText('assistant: Ledger reply').waitFor();

  await workspace.getByRole('button', { name: 'Call echo' }).click();
  await wait(async () => (await workspace.locator('output').textContent()) !== '', 'echo');
  assert.deepEqual(JSON.parse(await workspace.locator('output').textContent()), { kind: 'ok', output: { input: { ping: 1 }, installationId: 'books' } });
  await audit(f.page, 'open workspace');

  await draft(f.page, 'Kept across views');
  await f.rail.getByRole('button', { name: 'Chats', exact: true }).click();
  await f.page.locator('.chat-view #message').waitFor();
  assert.equal(await f.page.locator('#message').count(), 1);
  assert.equal(await f.page.locator('#message').inputValue(), 'Kept across views');
  assert.equal(await f.page.getByRole('region', { name: 'Workspace transcript' }).count(), 0);
  await f.page.locator('.chat-view').getByText('Ledger reply').waitFor();
  await f.rail.getByRole('button', { name: 'Extensions', exact: true }).click();
  await workspace.getByRole('region', { name: 'Workspace transcript' }).waitFor();
  assert.equal(await f.page.locator('#message').count(), 1);

  // An invalid operation name is the extension's bug: it still resolves, but is logged with the namespace, not hidden as an outage.
  const logged = [];
  f.page.on('console', message => { if (message.type() === 'error') logged.push(message.text()); });
  assert.deepEqual(await f.page.evaluate(() => window.workspace.call('books', 'Echo.Upper', {})), { kind: 'failed', cause: 'unavailable' });
  await wait(() => logged.some(text => text.startsWith('[ledger] invalid extension call to "Echo.Upper"')), 'invalid call logged');
  assert.deepEqual(await f.page.evaluate(() => window.workspace.call('books', 'echo', 'x'.repeat(64_001))), { kind: 'failed', cause: 'too-large' });

  await f.host.stop();
  assert.deepEqual(await f.page.evaluate(() => window.workspace.call('books', 'echo', {})), { kind: 'failed', cause: 'unavailable' });
});

test('the active conversation stays in the workspace entries when it is not on a loaded catalog page', { timeout: 60_000 }, async t => {
  const f = await open(t);
  await openWorkspace(f);
  const workspace = f.page.getByRole('region', { name: 'Ledger workspace' });
  await workspace.getByRole('button', { name: 'Start with Ledger desk' }).click();
  await workspace.locator('#message').waitFor();
  const selected = await f.page.evaluate(() => window.workspace.selected?.conversationId);
  assert.ok(selected);
  // As with a namespace of more than one page, the reloaded catalog page no longer holds the active conversation.
  await f.page.route('**/api/v1', async route => {
    const body = route.request().postDataJSON();
    if (body?.op !== 'catalog' || !body.filter) return route.continue();
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, value: [] }) });
  });
  await f.page.evaluate(() => window.workspace.refresh());
  await wait(() => f.page.evaluate(() => !window.workspace.conversations.loading), 'workspace reloaded');
  assert.deepEqual(await f.page.evaluate(() => window.workspace.conversations.entries.map(entry => [entry.scope.conversationId, entry.preview, entry.provider])),
    [[selected, null, { installationId: 'books', providerAgentId: 'desk-1' }]]);
  await workspace.getByRole('button', { name: `Open ${selected}` }).waitFor();
});

test('an uncertain creation started in a workspace shows the recovery control while the workspace is open', { timeout: 60_000 }, async t => {
  const f = await open(t);
  f.ledger.service.loseRepliesTo('/open');
  await openWorkspace(f);
  await f.page.getByRole('button', { name: 'Start with Ledger desk' }).click();
  await f.page.locator('.extension-status-strip').getByRole('button', { name: 'Recover creation' }).waitFor();
});

test('a throwing workspace fails its row and leaves Chats usable; Restore default view disables every row', { timeout: 60_000 }, async t => {
  const f = await open(t);
  await f.page.evaluate(() => { window.breakWorkspace = true; });
  await f.rail.getByRole('button', { name: 'Extensions', exact: true }).click();
  await f.page.getByRole('button', { name: 'Open Ledger workspace' }).click();
  await wait(async () => (await row(f.page, 'ledger').locator('.extension-state').textContent().catch(() => '')) === 'Failed', 'failed row');
  await f.rail.getByRole('button', { name: 'Chats', exact: true }).click();
  await f.page.getByRole('button', { name: 'New recorded conversation' }).click();
  await f.page.locator('#message').waitFor();
  await f.rail.getByRole('button', { name: 'Extensions', exact: true }).click();
  await revealRecovery(f.page);
  await f.page.getByRole('button', { name: 'Restore default view', exact: true }).click();
  await f.rail.getByRole('button', { name: 'Extensions', exact: true }).click();
  for (const namespace of ['fixture', 'ledger']) {
    assert.equal(await row(f.page, namespace).locator('.extension-state').textContent(), 'Disabled');
  }
  assert.match(await row(f.page, 'ledger').textContent(), /Enable customizations in Settings/);
});

test('the product browser build lists no extension', { timeout: 60_000 }, async t => {
  const host = await fixture(t);
  const page = await (await host.browser.newContext()).newPage();
  await page.goto(`${host.origin}/browser.html`);
  await page.getByRole('navigation', { name: 'Workspace views' }).getByRole('button', { name: 'Extensions', exact: true }).click();
  await page.locator('.extensions-panel .empty-state').waitFor();
  assert.equal(await page.locator('.extension-row').count(), 0);
  assert.equal(await page.locator('[data-extension-workspace]').count(), 0);
});

test('the extension test bundle lists the in-repo Crew workspace Not configured and loads without CSP violations', { timeout: 60_000 }, async t => {
  const host = await fixture(t, extensionTestAssets);
  const context = await host.browser.newContext();
  const page = await context.newPage();
  const violations = [], errors = [];
  await page.exposeFunction('reportCspViolation', violation => { violations.push(violation); });
  await page.addInitScript(() => document.addEventListener('securitypolicyviolation', event => { void window.reportCspViolation(`${event.effectiveDirective}: ${event.blockedURI}`); }));
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${host.origin}/browser.html`);
  await page.getByRole('navigation', { name: 'Workspace views' }).getByRole('button', { name: 'Extensions', exact: true }).click();
  const crew = row(page, 'crew');
  // Not configured is a claim about the host: check the host reported its extensions and no Crew installation.
  await wait(() => page.evaluate(() => fetch('/api/v1', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ op: 'metadata' }) })
    .then(response => response.json()).then(body => Array.isArray(body.value?.extensions) && !body.value.extensions.some(item => item.namespace === 'crew'))), 'host reports no Crew installation');
  await wait(async () => (await crew.locator('.extension-state').textContent().catch(() => '')) === 'Not configured', 'Crew row');
  assert.match(await crew.textContent(), /Crew/);
  await page.getByRole('button', { name: 'Open Crew' }).click();
  await page.locator('[data-extension-workspace="crew"]').waitFor();
  await page.getByRole('navigation', { name: 'Workspace views' }).getByRole('button', { name: 'Chats', exact: true }).click();
  await page.getByRole('button', { name: 'New recorded conversation' }).click();
  await page.locator('#message').waitFor();
  assert.deepEqual(violations, []);
  assert.deepEqual(errors, []);
});

// The Extensions page driven by a connected customization repository: a real host under the session wrapper, a real
// worker, a local bare remote with the dependency-free fixture, and real builds.
const repositoryPage = async (t, s) => {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await (await browser.newContext({ bypassCSP: true })).newPage();
  page.setDefaultTimeout(30_000);
  page.loads = 0;
  page.on('load', () => { page.loads++; });
  await page.goto(`${s.origin}/browser.html`);
  await page.getByRole('navigation', { name: 'Workspace views' }).getByRole('button', { name: 'Extensions', exact: true }).click();
  return page;
};
/** Applies from the page and waits for its one reload, then shows the Extensions view again. */
async function applyAndReload(s, page, buildKey) {
  const loads = page.loads;
  await page.getByRole('button', { name: 'Apply and restart' }).click({ timeout: 60_000 });
  await s.until(async () => (await s.status().catch(() => null))?.running.buildKey === buildKey, 'the applied build running', 120_000);
  await s.until(() => page.loads === loads + 1, 'one reload', 60_000);
  await page.getByRole('navigation', { name: 'Workspace views' }).getByRole('button', { name: 'Extensions', exact: true }).click();
}
/** Commits a change to the remote as someone other than AgentUI. */
async function pushElsewhere(s, path, edit) {
  const { readFile, writeFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  s.git(s.seed, 'fetch', '--quiet', s.remote, 'customization');
  s.git(s.seed, 'reset', '--quiet', '--hard', 'FETCH_HEAD');
  const file = join(s.seed, path);
  await writeFile(file, edit(await readFile(file, 'utf8').catch(() => '')));
  s.git(s.seed, 'add', '-A');
  s.git(s.seed, 'commit', '--quiet', '-m', `Change ${path} elsewhere`);
  s.git(s.seed, 'push', '--quiet', s.remote, 'HEAD:customization');
}

test('with no repository connected the Extensions page shows an empty state whose button opens Settings', { timeout: 120_000 }, async t => {
  const { startSession } = await import('../support/customization-session.mjs');
  const { customizationFixtureFiles } = await import('../support/customization-fixture.mjs');
  const s = await startSession(t, { files: customizationFixtureFiles() });
  const page = await repositoryPage(t, s);
  await page.getByText('No customization repository is connected.').waitFor();
  await audit(page, 'extensions without a repository');
  await page.getByRole('button', { name: 'Open Settings' }).click();
  await page.getByRole('region', { name: 'Customization repository' }).waitFor();
});

test('repository toggles commit and push, show the build and Apply; a conflict and a failed build show their sentences', { timeout: 900_000 }, async t => {
  const { startSession } = await import('../support/customization-session.mjs');
  const { customizationFixtureFiles, fixtureConnection } = await import('../support/customization-fixture.mjs');
  const s = await startSession(t, { files: customizationFixtureFiles() });
  assert.equal(await s.mutate('connect', fixtureConnection(s.remote)), 'ok');
  const first = await s.ready();
  const page = await repositoryPage(t, s);
  const toggle = label => page.getByRole('switch', { name: `${label} enabled` });
  const state = namespace => page.locator(`[data-extension="${namespace}"] .extension-state`).textContent();
  await toggle('alpha').waitFor();
  assert.equal(await state('alpha'), 'Enabled, not applied yet');
  await audit(page, 'extensions before apply');
  await applyAndReload(s, page, first.buildKey);
  await s.until(async () => await toggle('alpha').count() === 1 && await state('alpha').catch(() => '') === 'No view', 'running rows after the reload', 60_000);
  assert.equal(await toggle('alpha').getAttribute('aria-checked'), 'true');
  assert.equal(await toggle('beta').getAttribute('aria-checked'), 'true');

  // Turning beta off: every toggle waits for the save; one commit on the remote; the row says it still runs until applied.
  const before = s.git(s.remote, 'rev-parse', 'customization');
  await toggle('beta').click();
  assert.equal(await toggle('alpha').isDisabled(), true, 'all toggles are disabled while a change is saved');
  await s.until(async () => await state('beta').catch(() => '') === 'Disabled, still running until applied', 'disabled but running', 60_000);
  assert.equal(s.git(s.remote, 'rev-list', '--count', `${before}..customization`), '1');
  assert.equal(s.git(s.remote, 'log', '-1', '--format=%s', 'customization'), 'Disable ext/beta extension');
  const second = await s.ready(first.buildKey);
  await applyAndReload(s, page, second.buildKey);
  await s.until(async () => await state('beta').catch(() => '') === 'Disabled', 'disabled after the apply', 60_000);
  assert.equal(await page.locator('[data-extension="beta"]').getByRole('button', { name: /^Open/ }).count(), 0);
  assert.equal((await s.agents()).includes('beta fixture agent'), false);

  // Someone else pushed first: the toggle reports a conflict, and the switch shows the repository's value.
  await pushElsewhere(s, 'custom/NOTES.md', text => `${text}elsewhere\n`);
  await toggle('alpha').click();
  await page.getByRole('alert').filter({ hasText: 'The repository changed.' }).waitFor({ timeout: 60_000 });
  assert.equal((await s.status()).head, s.git(s.remote, 'rev-parse', 'customization'), 'the page now knows the pushed head');
  assert.equal(await toggle('alpha').getAttribute('aria-checked'), 'true', 'the switch shows the repository value');

  // A build that fails shows its sentence, where the log is, and Rebuild.
  await pushElsewhere(s, 'ext/alpha/package.json', text => text.replace(/"sdkVersion": "[^"]+"/u, '"sdkVersion": "0.0.1"'));
  assert.equal(await s.mutate('sync'), 'ok');
  await page.getByRole('alert').filter({ hasText: 'target a different AgentUI version' }).waitFor({ timeout: 120_000 });
  assert.match(await page.getByRole('alert').filter({ hasText: 'The build failed.' }).textContent(), /customization\/builds\/[0-9a-f]{64}\/log\.txt/u);
  await page.getByRole('button', { name: 'Rebuild' }).waitFor();
  await audit(page, 'extensions with a failed build');
});

test('applying a build whose token variable is unset names the variable and restarts nothing', { timeout: 600_000 }, async t => {
  const { startSession } = await import('../support/customization-session.mjs');
  const { customizationFixtureFiles, fixtureConnection } = await import('../support/customization-fixture.mjs');
  const s = await startSession(t, { files: customizationFixtureFiles(), tokens: {}, hostTokens: {} });
  assert.equal(await s.mutate('connect', fixtureConnection(s.remote)), 'ok');
  await s.ready();
  const page = await repositoryPage(t, s);
  await page.getByRole('button', { name: 'Apply and restart' }).click();
  await page.getByRole('alert').filter({ hasText: 'AGENTUI_EXTENSION_ALPHA_TOKEN, AGENTUI_EXTENSION_BETA_TOKEN' }).waitFor();
  assert.equal((await s.status()).running.buildKey, null);
});
