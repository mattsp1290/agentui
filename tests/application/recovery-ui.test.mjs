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
    const unconfirmed = { scope, clientCommandId: 'foreign-uncertain', hostOperationId: 'operation-2', sequence: 2, state: { kind: 'uncertain', reason: 'provider-outcome-unknown' } };
    let view = { submitting: ['own-original'], draft: 'Saved original text', outbox: [{ command: own, draftRevision: 0 }],
      connection: { kind: 'connected' }, cursor: 1,
      document: { domain: { messages: [] }, decisions: {}, receipts: { 'foreign-pending': foreign } } };
    globalThis.addUncertain = () => { view = { ...view, document: { ...view.document, receipts: { ...view.document.receipts, 'foreign-uncertain': unconfirmed,
      'own-original': { ...unconfirmed, clientCommandId: 'own-original', hostOperationId: 'operation-3', sequence: 3 } } } }; globalThis.renderRecovery(false); };
    const listeners = new Set();
    globalThis.edits = [];
    const store = { getSnapshot: () => view, subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); },
      setDraft: value => new Promise((resolve, reject) => globalThis.edits.push({ value, reject,
        resolve() { view = { ...view, draft: value }; for (const listener of listeners) listener(); resolve(); } })) };
    const active = { scope, store, agent: { imageInput: { kind: 'unsupported', reason: 'This model cannot read images.' }, commands: ['send', 'cancel', 'approve'], availability: { kind: 'ready' } } };
    globalThis.checked = []; globalThis.abandoned = [];
    let storageFailure = '';
    const actions = { reconcile: async id => globalThis.checked.push(id), abandon: async id => globalThis.abandoned.push(id) };
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
  assert.equal(await recovery.getByRole('button', { name: 'Stop waiting', exact: true }).count(), 0);
  await page.evaluate(() => globalThis.addUncertain());
  assert.match(await recovery.textContent(), /Stop waiting releases the conversation for new work and does not say whether the earlier command ran/);
  const stop = recovery.getByRole('button', { name: 'Stop waiting', exact: true });
  assert.equal(await stop.count(), 2);
  await stop.nth(0).click(); await stop.nth(1).click();
  assert.deepEqual(await page.evaluate(() => globalThis.abandoned), ['own-original', 'foreign-uncertain']);
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
  await message.press('ControlOrMeta+A');
  assert.equal(await message.evaluate(input => input.value.slice(input.selectionStart, input.selectionEnd)), 'Copy this text before reloading');
  await message.press('x');
  assert.equal(await message.inputValue(), 'Copy this text before reloading');
  assert.equal(await send.isDisabled(), true);
});

for (const agent of ['codex', 'codex-sdk', 'pi']) {
test(`${agent} Stop follows the persisted run, guards rapid clicks, preserves drafts and retains recovery after a lost reply`, async t => {
  const bundle = await build({ stdin: { contents: `import React from 'react';
    import { createRoot } from 'react-dom/client';
    import { flushSync } from 'react-dom';
    import { ConversationView } from './apps/desktop/src/application/ConversationView.tsx';
    const scope = { hostId: 'host', conversationId: 'original' };
    let view = { submitting: [], draft: 'Follow-up draft', outbox: [], connection: { kind: 'connected' }, cursor: 1,
      document: { domain: { messages: [], currentRun: { kind: 'running', runId: 'exact-native-run' } }, decisions: {}, receipts: {} } };
    const listeners = new Set();
    function update(next) { view = next; for (const listener of listeners) listener(); }
    globalThis.cancellations = [];
    globalThis.retries = [];
    globalThis.operations = [];
    const store = { getSnapshot: () => view, subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); },
      async setDraft(value) { update({ ...view, draft: value }); },
      async cancel(runId) {
        globalThis.cancellations.push({ scope, runId });
        update({ ...view, outbox: [{ command: { version: 1, scope, clientCommandId: 'saved-stop-id', body: { kind: 'cancel', runId } }, draftRevision: null }] });
        throw new Error('Reply lost');
      }, async retry(id) { globalThis.retries.push(id); return { kind: 'rejected', reason: 'Unknown result' }; } };
    let active = { scope, store, agent: { imageInput: { kind: 'unsupported', reason: 'This model cannot read images.' }, commands: ['send', 'cancel', 'approve'], availability: { kind: 'ready' } } };
    const actions = { async submit(operation) { await new Promise(resolve => globalThis.operations.push(async () => { try { await operation(); } catch {} resolve(); })); }, async reconcile() {} };
    let root;
    const render = () => flushSync(() => root.render(<ConversationView actions={actions} active={active} enabled={true} storageFailure="" agent=${JSON.stringify(agent)} />));
    globalThis.remount = () => { if (root) flushSync(() => root.unmount()); root = createRoot(document.getElementById('root')); render(); };
    globalThis.acknowledgeStop = () => flushSync(() => update({ ...view, outbox: [], document: { ...view.document, domain: { ...view.document.domain, currentRun: { kind: 'stopping', runId: 'exact-native-run', clientCommandId: 'saved-stop-id' } } } }));
    globalThis.finish = () => flushSync(() => update({ ...view, outbox: [], document: { ...view.document, domain: { messages: [{ messageId: 'partial', revision: 1, role: 'assistant', text: 'Kept partial output', complete: true }], currentRun: { kind: 'ended', runId: 'exact-native-run', outcome: 'interrupted' } } } }));
    globalThis.switchConversation = () => { active = { ...active, scope: { ...scope, conversationId: 'other' }, store: { ...store, async cancel(runId) { throw new Error('Wrong conversation targeted'); } } }; render(); };
    globalThis.remount();`, resolveDir: root, loader: 'jsx' },
    bundle: true, write: false, format: 'iife', jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"production"' } });
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent('<!doctype html><div id="root"></div>');
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  if (agent === 'pi') {
    assert.equal(await page.getByPlaceholder('Write to Pi…').count(), 1);
    assert.match(await page.locator('.composer-footer').textContent(), /Pi · GLM 5.3 · OpenCode Go · Chat only · No tools/);
    assert.equal(await page.getByRole('heading', { name: 'Approval required' }).count(), 0);
  }
  if (agent === 'codex-sdk') {
    assert.equal(await page.getByPlaceholder('Write to Codex…').count(), 1);
    assert.match(await page.locator('.composer-footer').textContent(), /Codex · GPT-6.1 Sol · ChatGPT subscription · Read-only · No interactive approvals/);
  }
  const send = page.getByRole('button', { name: 'Send', exact: true });
  assert.equal(await send.isDisabled(), true);
  assert.equal(await page.getByRole('button', { name: 'Stop', exact: true }).isEnabled(), true);
  await page.evaluate(() => globalThis.remount());
  assert.equal(await page.getByRole('button', { name: 'Stop', exact: true }).isEnabled(), true);
  await page.evaluate(() => {
    const button = [...document.querySelectorAll('button')].find(button => button.textContent === 'Stop');
    button.click(); button.click();
  });
  assert.equal(await page.evaluate(() => globalThis.operations.length), 1);
  assert.equal(await page.getByRole('button', { name: 'Stopping…', exact: true }).isDisabled(), true);
  const editor = page.getByRole('textbox', { name: 'Message', exact: true });
  await editor.fill('Keep this follow-up');
  await page.evaluate(async () => { globalThis.switchConversation(); await globalThis.operations.shift()(); });
  assert.deepEqual(await page.evaluate(() => globalThis.cancellations), [
    { scope: { hostId: 'host', conversationId: 'original' }, runId: 'exact-native-run' },
  ]);
  await page.evaluate(() => globalThis.remount());
  assert.equal(await page.getByRole('button', { name: 'Stopping…', exact: true }).isDisabled(), true);
  assert.equal(await send.isDisabled(), true);
  assert.equal(await editor.inputValue(), 'Keep this follow-up');
  const recovery = page.getByRole('region', { name: 'Command recovery', exact: true });
  assert.match(await recovery.textContent(), /saved-stop-id/);
  await recovery.getByRole('button', { name: 'Retry original command', exact: true }).click();
  await page.evaluate(async () => globalThis.operations.shift()());
  assert.deepEqual(await page.evaluate(() => globalThis.retries), ['saved-stop-id']);
  await page.evaluate(() => globalThis.acknowledgeStop());
  assert.equal(await recovery.count(), 0);
  assert.equal(await send.isDisabled(), true);
  await page.evaluate(() => globalThis.remount());
  assert.equal(await page.getByRole('button', { name: 'Stopping…', exact: true }).isDisabled(), true);
  assert.equal(await send.isDisabled(), true);
  await page.evaluate(() => globalThis.finish());
  assert.equal(await page.getByRole('button', { name: /Stop/ }).count(), 0);
  assert.equal(await send.isEnabled(), true);
  assert.equal(await editor.inputValue(), 'Keep this follow-up');
  assert.match(await page.getByLabel('Messages').textContent(), /Kept partial output/);
  assert.match(await page.getByLabel('Messages').textContent(), agent === 'pi' ? /Pi/ : /Codex/);
});
}
