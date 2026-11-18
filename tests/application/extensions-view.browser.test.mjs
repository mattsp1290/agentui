import assert from 'node:assert/strict';
import test from 'node:test';
import axe from 'axe-core';
import { EXTENSION_SDK_VERSION } from '@agentui/sdk';
import { customRuntime, draft, extensionFixture, revealRecovery, wait } from './browser-support.mjs';
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

  await f.host.stop();
  assert.deepEqual(await f.page.evaluate(() => window.workspace.call('books', 'echo', {})), { kind: 'failed', cause: 'unavailable' });
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
