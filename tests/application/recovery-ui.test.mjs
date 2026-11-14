import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('../../', import.meta.url));
test('recovery UI keeps live pending commands distinct from retained unknown intent', async t => {
  const bundle = await build({ stdin: { contents: `import React from 'react';
    import { createRoot } from 'react-dom/client';
    import { flushSync } from 'react-dom';
    import { ConversationView } from './apps/desktop/src/application/ConversationView.tsx';
    const scope = { hostId: 'host', conversationId: 'conversation' };
    const own = { version: 1, scope, clientCommandId: 'own-original', body: { kind: 'send', text: 'Saved original text' } };
    const foreign = { scope, clientCommandId: 'foreign-pending', hostOperationId: 'operation', sequence: 1, state: { kind: 'pending' } };
    let view = { submitting: ['own-original'], draft: 'Saved original text', outbox: [{ command: own, draftRevision: 0 }],
      connection: { kind: 'connected' }, cursor: 1,
      document: { domain: { messages: [] }, decisions: {}, receipts: { 'foreign-pending': foreign } } };
    const listeners = new Set();
    globalThis.edits = [];
    const store = { getSnapshot: () => view, subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); },
      setDraft: value => new Promise((resolve, reject) => globalThis.edits.push({ value, reject,
        resolve() { view = { ...view, draft: value }; for (const listener of listeners) listener(); resolve(); } })) };
    const active = { scope, store };
    globalThis.checked = [];
    let storageFailure = '';
    const actions = { reconcile: async id => globalThis.checked.push(id) };
    const root = createRoot(document.getElementById('root'));
    globalThis.renderRecovery = (busy, submitting = []) => { view = { ...view, submitting }; flushSync(() => root.render(<ConversationView actions={actions} active={active} enabled={!busy && !storageFailure} storageFailure={storageFailure} />)); };
    globalThis.storageUnavailable = () => { storageFailure = 'Storage unavailable'; globalThis.renderRecovery(false); };
    globalThis.savedCommand = own;
    globalThis.renderRecovery(true, [own.clientCommandId]);`, resolveDir: root, loader: 'jsx' },
    bundle: true, write: false, format: 'iife', jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"production"' } });
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent('<!doctype html><div id="root"></div>');
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  assert.equal(await page.getByRole('region', { name: 'Command recovery', exact: true }).count(), 0);
  assert.equal(await page.getByRole('region', { name: 'Pending commands', exact: true }).count(), 1);
  assert.equal(await page.getByRole('button', { name: 'Check pending command', exact: true }).isDisabled(), true);
  await page.evaluate(() => globalThis.renderRecovery(true));
  assert.equal(await page.getByRole('region', { name: 'Command recovery', exact: true }).count(), 1);
  await page.evaluate(() => globalThis.renderRecovery(false));
  await page.getByRole('button', { name: 'Check pending command', exact: true }).click();
  assert.deepEqual(await page.evaluate(() => globalThis.checked), ['foreign-pending']);
  const recovery = page.getByRole('region', { name: 'Command recovery', exact: true });
  assert.equal(await recovery.getByRole('button', { name: 'Retry original command', exact: true }).count(), 1);
  assert.match(await recovery.textContent(), /absent result or rejected retry cannot rule out an earlier submission/);
  assert.equal(await page.getByRole('button', { name: /Discard|Archive/ }).count(), 0);
  assert.deepEqual(await page.evaluate(() => globalThis.savedCommand), {
    version: 1, scope: { hostId: 'host', conversationId: 'conversation' }, clientCommandId: 'own-original', body: { kind: 'send', text: 'Saved original text' },
  });
  const message = page.getByRole('textbox', { name: 'Message', exact: true });
  const send = page.getByRole('button', { name: 'Send', exact: true });
  await message.fill('Keep this unsaved text');
  assert.equal(await send.isDisabled(), true);
  await page.evaluate(() => globalThis.edits[0].reject(new Error('Draft revision exhausted')));
  assert.match(await page.getByRole('alert').textContent(), /Draft not saved.*Draft revision exhausted/);
  assert.equal(await message.inputValue(), 'Keep this unsaved text');
  assert.equal(await send.isDisabled(), true);
  assert.equal(await page.getByRole('button', { name: 'Check pending command', exact: true }).isEnabled(), true);
  await message.fill('Older edit');
  await message.fill('Newest saved edit');
  await page.evaluate(() => { globalThis.edits[1].reject(new Error('Older edit failed')); globalThis.edits[2].resolve(); });
  await page.waitForFunction(() => [...document.querySelectorAll('button')].find(button => button.textContent === 'Send')?.disabled === false);
  assert.equal(await message.inputValue(), 'Newest saved edit');
  assert.equal(await page.getByRole('alert').count(), 0);
  await message.fill('Copy this text before reloading');
  await page.evaluate(() => { globalThis.storageUnavailable(); globalThis.edits[3].reject(new Error('Storage write failed')); });
  assert.match(await page.getByRole('note').textContent(), /Copy your text before reloading/);
  assert.equal(await message.isEnabled(), true);
  await message.focus();
  await message.press('Control+A');
  assert.equal(await message.evaluate(input => input.value.slice(input.selectionStart, input.selectionEnd)), 'Copy this text before reloading');
  await message.press('x');
  assert.equal(await message.inputValue(), 'Copy this text before reloading');
  assert.equal(await send.isDisabled(), true);
});
