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
  import { EXTENSION_SDK_VERSION, RECORDED_RUNTIME } from '@agentui/contracts/compatibility';
  const agent = { id: 'recorded', label: 'Recorded', runtime: RECORDED_RUNTIME, commands: ['send', 'approve'], availability: { kind: 'ready' } };
  const metadata = { agents: [agent], defaultAgentId: agent.id, hostId: 'host', principalId: 'principal', compatibility: {
    wireVersion: 3, extensionSdkVersion: EXTENSION_SDK_VERSION, nativeRuntime: RECORDED_RUNTIME, desiredGitRevision: 'test', appliedArtifact: { artifactId: 'test', gitRevision: 'test' } } };
  globalThis.nativeCalls = [];
  let access = { kind: 'ready', observation: 'initial', hostId: 'host', principalId: 'principal' };
  globalThis.__TAURI_INTERNALS__ = { async invoke(name, { command }) {
    if (name !== 'native_access') throw new Error('Unexpected native command');
    globalThis.nativeCalls.push(command);
    if (globalThis.heldAction === command.kind) {
      globalThis.heldAction = null;
      await new Promise((resolve, reject) => { globalThis.releaseNative = resolve; globalThis.rejectNative = reject; });
    }
    if (command.kind === 'status') { access = { ...access, observation: 'status-' + globalThis.nativeCalls.length }; return access; }
    if (command.kind === 'forget') { access = { kind: 'absent', observation: 'forgotten' }; return access; }
    if (command.kind === 'pair') throw 'pairing-failed';
    if (command.kind !== 'execute') throw new Error('Unexpected access action');
    const op = command.request.op;
    if (op !== 'metadata' && op !== 'catalog') throw new Error('Unexpected service request: ' + op);
    return { status: 200, body: JSON.stringify({ ok: true, value: op === 'metadata' ? metadata : [] }) };
  } };
  window.confirm = () => { throw new Error('Browser confirmation unavailable'); };
  globalThis.mountNative = async () => {
    const storage = await BrowserViewStorage.reopen('native-mac-default', () => {});
    await storage.saveView('host', { version: 2, route: null, pendingCreation: null });
    await storage.drafts(() => {}).save({ scope: { hostId: 'host', conversationId: 'saved' }, draft: 'Keep the native draft', outbox: [] });
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

async function fixture(t) {
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('http://localhost/**', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><div id="root"></div>' }));
  await page.goto('http://localhost/native-forget');
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  await page.evaluate(() => globalThis.mountNative());
  await page.getByRole('button', { name: 'New recorded conversation', exact: true }).waitFor();
  await page.waitForFunction(() => ![...document.querySelectorAll('button')].find(button => button.textContent === 'New recorded conversation').disabled);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  t.after(() => assert.deepEqual(errors, []));
  return page;
}

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
  await forget.click();
  await page.evaluate(() => { globalThis.heldAction = 'status'; });
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
