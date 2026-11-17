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
  const metadata = { agents: [agent], defaultAgentId: agent.id, hostId: 'host', principalId: 'principal', compatibility: {
    wireVersion: SERVICE_WIRE_VERSION, extensionSdkVersion: EXTENSION_SDK_VERSION, nativeRuntime: RECORDED_RUNTIME, desiredGitRevision: 'test', appliedArtifact: { artifactId: 'test', gitRevision: 'test' } } };
  globalThis.nativeCalls = [];
  let access = { kind: 'ready', observation: 'initial', hostId: 'host', principalId: 'principal' };
  globalThis.__TAURI_INTERNALS__ = { async invoke(name, { command }) {
    if (name !== 'native_access') throw new Error('Unexpected native command');
    globalThis.nativeCalls.push(command);
    if (globalThis.nativeFailure) throw globalThis.nativeFailure;
    if (globalThis.heldAction === command.kind) {
      globalThis.heldAction = null;
      await new Promise((resolve, reject) => { globalThis.releaseNative = resolve; globalThis.rejectNative = reject; });
    }
    if (command.kind === 'status' || command.kind === 'restore') { access = globalThis.nativeStatus ?? { ...access, observation: 'status-' + globalThis.nativeCalls.length }; return access; }
    if (command.kind === 'forget') { access = { kind: 'absent', observation: 'forgotten' }; return access; }
    if (command.kind === 'pair') {
      if (!globalThis.nativePairSucceeds) throw 'pairing-failed';
      globalThis.denyMetadata = false;
      access = { ...access, observation: 'paired' };
      return access;
    }
    if (command.kind !== 'execute') throw new Error('Unexpected access action');
    const op = command.request.op;
    if (op !== 'metadata' && op !== 'catalog') throw new Error('Unexpected service request: ' + op);
    if (op === 'metadata' && globalThis.denyMetadata) return { status: 401, body: JSON.stringify({ ok: false, error: { kind: 'unauthorized', message: 'Access revoked' } }) };
    return { status: 200, body: JSON.stringify({ ok: true, value: op === 'metadata' ? metadata : [] }) };
  } };
  window.confirm = () => { throw new Error('Browser confirmation unavailable'); };
  globalThis.mountNative = async () => {
    const storage = await BrowserViewStorage.reopen('native-mac-default', () => {});
    const scope = { hostId: 'host', conversationId: 'saved' };
    await storage.saveView('host', { version: 2, route: null, pendingCreation: globalThis.seedRecovery ? { scope: { hostId: 'host', conversationId: 'pending' }, agentId: 'recorded' } : null });
    await storage.drafts(() => {}).save({ version: 1, scope, draft: 'Keep the native draft', draftRevision: 1, outbox: globalThis.seedRecovery
      ? [{ command: { version: 1, scope, clientCommandId: 'saved-intent', body: { kind: 'send', text: 'Unresolved original prompt' } }, draftRevision: 0 }] : [] });
    await storage.close();
    globalThis.initialRecords = await globalThis.savedRecords();
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

async function fixture(t, initialFailure = null, recovery = false) {
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('http://localhost/**', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><div id="root"></div>' }));
  await page.goto('http://localhost/native-forget');
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  await page.evaluate(({ failure, recovery }) => { globalThis.nativeFailure = failure; globalThis.denyMetadata = recovery; globalThis.seedRecovery = recovery; return globalThis.mountNative(); }, { failure: initialFailure, recovery });
  t.after(() => assert.deepEqual(errors, []));
  if (initialFailure) {
    await page.getByRole('alert').filter({ hasText: 'Restore Keychain access' }).waitFor();
    return page;
  }
  if (recovery) {
    await page.getByRole('alert').waitFor();
    return page;
  }
  await page.getByRole('button', { name: 'New recorded conversation', exact: true }).waitFor();
  await page.waitForFunction(() => ![...document.querySelectorAll('button')].find(button => button.textContent === 'New recorded conversation').disabled);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  return page;
}

test('native metadata denial opens connection settings by keyboard without changing saved work or native access', async t => {
  const page = await fixture(t, null, true);
  const records = await page.evaluate(() => globalThis.initialRecords);
  const guidance = page.getByRole('alert');
  assert.match(await guidance.textContent(), /This Mac no longer has access to the host/);
  assert.match(await guidance.textContent(), /expired or been revoked/);
  assert.match(await guidance.textContent(), /chats, drafts, and unresolved commands stay saved/);
  assert.equal(await page.getByLabel('Pairing code', { exact: true }).count(), 0);
  assert.doesNotMatch(await page.locator('#root').textContent(), /Pair this browser/);
  assert.equal(await page.getByRole('button', { name: 'New conversation', exact: true }).isDisabled(), true);
  assert.equal(await page.getByRole('button', { name: 'Chats', exact: true }).getAttribute('aria-pressed'), 'true');
  assert.deepEqual(await page.evaluate(() => globalThis.savedRecords()), records);
  const recovery = page.getByRole('button', { name: 'Open connection settings', exact: true });
  const heading = page.getByRole('heading', { name: 'Connection', exact: true });
  for (const key of ['Enter', 'Space', 'Enter']) {
    const calls = await page.evaluate(() => globalThis.nativeCalls);
    await recovery.focus();
    await recovery.press(key);
    await heading.waitFor();
    assert.equal(await page.getByRole('button', { name: 'Settings', exact: true }).getAttribute('aria-pressed'), 'true');
    await page.waitForFunction(() => document.activeElement?.textContent === 'Connection');
    await page.keyboard.press('Tab');
    assert.equal(await page.getByLabel('Native pairing invitation', { exact: true }).evaluate(input => input === document.activeElement), true);
    assert.deepEqual(await page.evaluate(() => globalThis.nativeCalls), calls);
    assert.deepEqual(await page.evaluate(() => globalThis.savedRecords()), records);
    if (key === 'Enter') await page.getByRole('button', { name: 'Chats', exact: true }).click();
  }
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Reconnect', exact: true }).click();
  await guidance.waitFor();
  assert.match(await guidance.textContent(), /This Mac no longer has access to the host/);
  assert.deepEqual(await page.evaluate(() => globalThis.savedRecords()), records);
  assert.deepEqual(await page.evaluate(() => globalThis.nativeCalls.filter(call => call.kind !== 'execute').map(call => call.kind)), ['status', 'restore']);
  await recovery.click();
  await page.evaluate(() => { globalThis.nativePairSucceeds = true; });
  await page.getByLabel('Native pairing invitation', { exact: true }).fill('{}');
  await page.getByRole('button', { name: 'Pair this Mac', exact: true }).click();
  await page.getByRole('button', { name: 'Recover creation', exact: true }).waitFor();
  assert.equal(await guidance.count(), 0);
  assert.equal(await recovery.count(), 0);
  assert.equal(await page.getByRole('button', { name: 'Recover creation', exact: true }).isEnabled(), true);
  assert.deepEqual(await page.evaluate(() => globalThis.savedRecords()), records);
  assert.deepEqual(await page.evaluate(() => globalThis.nativeCalls.filter(call => call.kind !== 'execute').map(call => call.kind)), ['status', 'restore', 'status', 'pair']);
  assert.deepEqual(await page.evaluate(() => [...new Set(globalThis.nativeCalls.filter(call => call.kind === 'execute').map(call => call.request.op))].sort()), ['catalog', 'metadata']);
});

test('native connection controls show category-specific recovery without exposing unknown causes', async t => {
  const page = await fixture(t);
  for (const [cause, guidance] of [
    ['forbidden', /installed AgentUI app/],
    ['profile-unavailable', /local profile.*access/i],
    ['keychain-denied', /Restore Keychain access/],
    ['private-token-and-profile-path', /Native connection unavailable\. Reconnect/],
  ]) {
    await page.evaluate(value => { globalThis.nativeFailure = value; }, cause);
    await page.getByRole('button', { name: 'Reconnect', exact: true }).click();
    const alert = page.getByRole('alert').filter({ hasText: guidance });
    await alert.waitFor();
    const text = await alert.textContent();
    if (cause !== 'keychain-denied') assert.doesNotMatch(text, /Keychain/);
    assert.doesNotMatch(text, /private-token-and-profile-path/);
  }
  await page.evaluate(() => { globalThis.nativeFailure = null; globalThis.nativeStatus = { kind: 'unreadable', observation: 'unreadable' }; });
  await page.getByRole('button', { name: 'Reconnect', exact: true }).click();
  await page.getByRole('heading', { name: 'Connect this Mac', exact: true }).waitFor();
  const unreadable = await page.getByRole('alert').textContent();
  assert.doesNotMatch(unreadable, /Keychain/);
  assert.match(unreadable, /Update AgentUI.*explicitly discard/);
});

test('native Forget asks visibly, cancels with focus, and confirms once without changing saved drafts', async t => {
  const page = await fixture(t);
  const records = await page.evaluate(() => globalThis.savedRecords());
  const forget = page.getByRole('button', { name: 'Forget local pairing', exact: true });
  const question = page.getByRole('group', { name: 'Forget local pairing?', exact: true });
  const before = await page.evaluate(() => globalThis.nativeCalls.length);
  await forget.focus();
  await forget.press('Enter');
  assert.equal(await question.count(), 1);
  assert.match(await question.textContent(), /Drafts and unresolved commands stay saved\. Remote device access is not revoked\./);
  assert.equal(await page.evaluate(() => globalThis.nativeCalls.length), before);
  const cancel = question.getByRole('button', { name: 'Cancel', exact: true });
  assert.equal(await cancel.evaluate(button => button === document.activeElement), true);
  await cancel.press('Enter');
  assert.equal(await question.count(), 0);
  assert.equal(await forget.evaluate(button => button === document.activeElement), true);
  assert.equal(await page.evaluate(() => globalThis.nativeCalls.filter(call => call.kind === 'forget').length), 0);
  assert.deepEqual(await page.evaluate(() => globalThis.savedRecords()), records);
  await forget.click();
  await page.evaluate(() => { globalThis.heldAction = 'forget'; });
  await question.getByRole('button', { name: 'Forget pairing', exact: true }).evaluate(button => { button.click(); button.click(); });
  await page.waitForFunction(() => typeof globalThis.releaseNative === 'function');
  assert.equal(await question.count(), 0);
  assert.equal(await forget.isDisabled(), true);
  assert.equal(await page.getByLabel('Native pairing invitation', { exact: true }).isDisabled(), true);
  await page.getByRole('status').filter({ hasText: 'Updating native connection…' }).waitFor();
  const calls = await page.evaluate(() => globalThis.nativeCalls.filter(call => call.kind !== 'execute'));
  assert.deepEqual(calls.map(call => call.kind), ['status', 'status', 'forget']);
  assert.equal(calls[2].observation, `status-${await page.evaluate(() => globalThis.nativeCalls.findIndex(call => call.kind === 'forget'))}`);
  await page.evaluate(() => globalThis.releaseNative());
  await page.getByRole('heading', { name: 'Connect this Mac', exact: true }).waitFor();
  assert.deepEqual(await page.evaluate(() => globalThis.savedRecords()), records);
});

test('pair failure and reconnect discard an open Forget request before changing native access', async t => {
  const page = await fixture(t);
  const records = await page.evaluate(() => globalThis.savedRecords());
  const forget = page.getByRole('button', { name: 'Forget local pairing', exact: true });
  const question = page.getByRole('group', { name: 'Forget local pairing?', exact: true });
  await forget.click();
  assert.equal(await question.count(), 1);
  await page.getByLabel('Native pairing invitation', { exact: true }).fill('{}');
  await page.getByRole('button', { name: 'Pair this Mac', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: 'Pairing failed.' }).waitFor();
  assert.equal(await question.count(), 0);
  assert.deepEqual(await page.evaluate(() => globalThis.nativeCalls.filter(call => call.kind !== 'execute').map(call => call.kind)), ['status', 'status', 'pair']);
  await forget.click();
  await page.evaluate(() => { globalThis.heldAction = 'restore'; });
  await page.getByRole('button', { name: 'Reconnect', exact: true }).click();
  await page.waitForFunction(() => typeof globalThis.releaseNative === 'function');
  assert.equal(await question.count(), 0);
  assert.equal(await forget.isDisabled(), true);
  await page.evaluate(() => globalThis.releaseNative());
  await page.getByRole('button', { name: 'New recorded conversation', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  assert.equal(await question.count(), 0);
  assert.equal(await page.evaluate(() => globalThis.nativeCalls.filter(call => call.kind === 'forget').length), 0);
  assert.deepEqual(await page.evaluate(() => globalThis.savedRecords()), records);
});

test('cold denied startup restores directly, deduplicates both Reconnect controls and retains drafts through denial and retry', async t => {
  const page = await fixture(t, 'keychain-denied');
  const records = await page.evaluate(() => globalThis.savedRecords());
  const reconnect = page.getByRole('button', { name: 'Reconnect', exact: true });
  await page.evaluate(() => { globalThis.nativeFailure = null; globalThis.heldAction = 'restore'; });
  await reconnect.evaluate(button => { button.click(); button.click(); });
  await page.waitForFunction(() => typeof globalThis.rejectNative === 'function');
  assert.equal(await reconnect.isDisabled(), true);
  assert.deepEqual(await page.evaluate(() => globalThis.nativeCalls), [{ kind: 'status' }, { kind: 'restore' }]);
  await page.evaluate(() => globalThis.rejectNative('keychain-denied'));
  await page.getByRole('alert').filter({ hasText: 'Restore Keychain access' }).waitFor();
  assert.deepEqual(await page.evaluate(() => globalThis.savedRecords()), records);
  await reconnect.click();
  await page.getByRole('button', { name: 'New recorded conversation', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  assert.deepEqual(await page.evaluate(() => globalThis.nativeCalls.filter(call => call.kind !== 'execute')), [
    { kind: 'status' }, { kind: 'restore' }, { kind: 'restore' },
  ]);
  assert.equal(await page.evaluate(() => globalThis.nativeCalls.some(call => call.kind === 'execute' && call.request.op === 'metadata')), true);
  await page.evaluate(() => { globalThis.releaseNative = null; globalThis.heldAction = 'restore'; });
  await reconnect.evaluate(button => { button.click(); button.click(); });
  await page.waitForFunction(() => typeof globalThis.releaseNative === 'function');
  assert.equal(await reconnect.isDisabled(), true);
  assert.deepEqual(await page.evaluate(() => globalThis.nativeCalls.filter(call => call.kind !== 'execute').map(call => call.kind)), ['status', 'restore', 'restore', 'restore']);
  await page.evaluate(() => globalThis.releaseNative());
  await page.getByRole('button', { name: 'New recorded conversation', exact: true }).waitFor();
  assert.deepEqual(await page.evaluate(() => globalThis.savedRecords()), records);
});
