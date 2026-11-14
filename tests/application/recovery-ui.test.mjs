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
    const store = { getSnapshot: () => view, subscribe: () => () => {} };
    const active = { scope, store };
    globalThis.checked = [];
    const actions = { enabled: false, busy: true, storageFailure: '',
      reconcile: async id => globalThis.checked.push(id) };
    const root = createRoot(document.getElementById('root'));
    globalThis.renderRecovery = (busy, submitting = []) => { view = { ...view, submitting }; actions.busy = busy; actions.enabled = !busy; flushSync(() => root.render(<ConversationView actions={actions} active={active} />)); };
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
});
