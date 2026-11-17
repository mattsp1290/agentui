import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('../../', import.meta.url));
const bundle = await build({ stdin: { contents: `import React from 'react';
  import { createRoot } from 'react-dom/client';
  import { NativeApplication } from './apps/desktop/src/application/NativeApplication.tsx';
  import { BrowserViewStorage } from './apps/desktop/src/application/browser-storage.ts';
  import { SERVICE_WIRE_VERSION, EXTENSION_SDK_VERSION, RECORDED_RUNTIME } from '@agentui/contracts/compatibility';
  const agent = { id: 'recorded', label: 'Recorded', runtime: RECORDED_RUNTIME, frontendOffers: 'unsupported', commands: ['send', 'approve'], availability: { kind: 'ready' } };
  const metadata = { agents: [agent], defaultAgentId: agent.id, hostId: 'host', principalId: 'trusted-owner', compatibility: {
    wireVersion: SERVICE_WIRE_VERSION, extensionSdkVersion: EXTENSION_SDK_VERSION, nativeRuntime: RECORDED_RUNTIME, desiredGitRevision: 'test', appliedArtifact: { artifactId: 'test', gitRevision: 'test' } } };
  globalThis.nativeCalls = [];
  globalThis.__TAURI_INTERNALS__ = { async invoke(name, { command }) {
    if (name !== 'native_access') throw new Error('Unexpected native command');
    globalThis.nativeCalls.push(command);
    if (globalThis.heldAction === command.kind) {
      globalThis.heldAction = null;
      await new Promise((resolve, reject) => { globalThis.releaseNative = resolve; globalThis.rejectNative = reject; });
    }
    if (globalThis.nativeFailure) throw globalThis.nativeFailure;
    if (command.kind === 'connect') return { observation: 'connection-' + globalThis.nativeCalls.length, hostId: 'host', principalId: 'trusted-owner' };
    if (command.kind !== 'execute') throw new Error('Unexpected native action');
    const op = command.request.op;
    if (op !== 'metadata' && op !== 'catalog') throw new Error('Unexpected service request: ' + op);
    if (op === 'metadata' && globalThis.hostChanged) throw 'host-changed';
    return { status: 200, body: JSON.stringify({ ok: true, value: op === 'metadata' ? metadata : [] }) };
  } };
  window.confirm = () => { throw new Error('Browser confirmation unavailable'); };
  globalThis.mountNative = async () => {
    const storage = await BrowserViewStorage.reopen('native-mac-default', () => {});
    const scope = { hostId: 'host', conversationId: 'saved' };
    await storage.saveView('host', { version: 2, route: null, pendingCreation: null });
    await storage.drafts(() => {}).save({ version: 1, scope, draft: 'Keep the native draft', draftRevision: 1, outbox: [] });
    await storage.close();
    createRoot(document.getElementById('root')).render(<NativeApplication />);
  };
  globalThis.savedRecords = async () => {
    const opened = indexedDB.open('agentui-browser-views', 1);
    const db = await new Promise((resolve, reject) => { opened.onsuccess = () => resolve(opened.result); opened.onerror = () => reject(opened.error); });
    const read = db.transaction('records').objectStore('records').getAll();
    const records = await new Promise((resolve, reject) => { read.onsuccess = () => resolve(read.result); read.onerror = () => reject(read.error); });
    db.close(); return records;
  };`, resolveDir: root, loader: 'jsx' },
  bundle: true, write: false, format: 'iife', jsx: 'automatic', loader: { '.css': 'empty' }, define: { 'process.env.NODE_ENV': '"production"' } });

async function fixture(t, initialFailure = null) {
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('http://localhost/**', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><div id="root"></div>' }));
  await page.goto('http://localhost/native-connection');
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  await page.evaluate(failure => { globalThis.nativeFailure = failure; return globalThis.mountNative(); }, initialFailure);
  t.after(() => assert.deepEqual(errors, []));
  if (initialFailure) {
    await page.getByRole('heading', { name: 'Connect this Mac', exact: true }).waitFor();
    await page.getByRole('alert').waitFor();
    return page;
  }
  await page.getByRole('button', { name: 'New recorded conversation', exact: true }).waitFor();
  await page.waitForFunction(() => ![...document.querySelectorAll('button')].find(button => button.textContent === 'New recorded conversation').disabled);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  return page;
}

async function assertNoPairing(page) {
  const text = await page.locator('#root').textContent();
  assert.doesNotMatch(text, /[Pp]air|[Ii]nvit|[Rr]evok|Forget|Keychain/);
  assert.equal(await page.getByRole('textbox').count(), 0);
}

test('a fresh Mac connects directly to the local host with no pairing step', async t => {
  const page = await fixture(t);
  assert.deepEqual(await page.evaluate(() => globalThis.nativeCalls.filter(call => call.kind !== 'execute')), [{ kind: 'connect' }]);
  assert.deepEqual(await page.evaluate(() => [...new Set(globalThis.nativeCalls.filter(call => call.kind === 'execute').map(call => call.observation))]), ['connection-1']);
  await page.getByText('Host host', { exact: true }).waitFor();
  await assertNoPairing(page);
});

test('native connection controls show category-specific recovery without exposing unknown causes', async t => {
  const page = await fixture(t);
  for (const [cause, guidance] of [
    ['forbidden', /installed AgentUI app/],
    ['profile-unavailable', /local profile.*access/i],
    ['network-failed', /host is running/],
    ['private-host-response-and-profile-path', /Native connection unavailable\. Reconnect/],
  ]) {
    await page.evaluate(value => { globalThis.nativeFailure = value; }, cause);
    await page.getByRole('button', { name: 'Reconnect', exact: true }).click();
    const alert = page.getByRole('alert').filter({ hasText: guidance });
    await alert.waitFor();
    assert.doesNotMatch(await alert.textContent(), /private-host-response-and-profile-path|Keychain/);
  }
  await assertNoPairing(page);
});

test('a host change during a session asks for an explicit reconnect and keeps saved work', async t => {
  const page = await fixture(t);
  const records = await page.evaluate(() => globalThis.savedRecords());
  await page.evaluate(() => { globalThis.hostChanged = true; });
  const reconnect = page.getByRole('button', { name: 'Reconnect', exact: true });
  await page.evaluate(() => { globalThis.heldAction = 'connect'; });
  await reconnect.click();
  await page.waitForFunction(() => typeof globalThis.releaseNative === 'function');
  await page.evaluate(() => globalThis.releaseNative());
  await page.getByRole('alert').filter({ hasText: /different AgentUI host.*Reconnect/ }).waitFor();
  assert.deepEqual(await page.evaluate(() => globalThis.savedRecords()), records);
  await page.evaluate(() => { globalThis.hostChanged = false; globalThis.releaseNative = null; });
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await reconnect.click();
  await page.getByRole('button', { name: 'New recorded conversation', exact: true }).waitFor();
  await page.waitForFunction(() => ![...document.querySelectorAll('button')].find(button => button.textContent === 'New recorded conversation').disabled);
  assert.deepEqual(await page.evaluate(() => globalThis.nativeCalls.filter(call => call.kind !== 'execute').map(call => call.kind)), ['connect', 'connect', 'connect']);
  assert.deepEqual(await page.evaluate(() => globalThis.savedRecords()), records);
});

test('cold failed startup connects on Reconnect, deduplicates clicks and retains drafts through failure and retry', async t => {
  const page = await fixture(t, 'network-failed');
  const records = await page.evaluate(() => globalThis.savedRecords());
  await assertNoPairing(page);
  const reconnect = page.getByRole('button', { name: 'Reconnect', exact: true });
  await page.evaluate(() => { globalThis.nativeFailure = null; globalThis.heldAction = 'connect'; });
  await reconnect.evaluate(button => { button.click(); button.click(); });
  await page.waitForFunction(() => typeof globalThis.rejectNative === 'function');
  assert.equal(await reconnect.isDisabled(), true);
  await page.getByRole('status').filter({ hasText: 'Connecting to the local host…' }).waitFor();
  assert.deepEqual(await page.evaluate(() => globalThis.nativeCalls), [{ kind: 'connect' }, { kind: 'connect' }]);
  await page.evaluate(() => globalThis.rejectNative('network-failed'));
  await page.getByRole('alert').filter({ hasText: 'host is running' }).waitFor();
  assert.deepEqual(await page.evaluate(() => globalThis.savedRecords()), records);
  await reconnect.click();
  await page.getByRole('button', { name: 'New recorded conversation', exact: true }).waitFor();
  assert.deepEqual(await page.evaluate(() => globalThis.nativeCalls.filter(call => call.kind !== 'execute')), [
    { kind: 'connect' }, { kind: 'connect' }, { kind: 'connect' },
  ]);
  assert.equal(await page.evaluate(() => globalThis.nativeCalls.some(call => call.kind === 'execute' && call.request.op === 'metadata')), true);
  assert.deepEqual(await page.evaluate(() => globalThis.savedRecords()), records);
});
