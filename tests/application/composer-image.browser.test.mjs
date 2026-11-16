import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { CSP as HOST_CSP } from '../../apps/host/build/tsc/static-assets.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const bundle = await build({ stdin: { contents: `import React from 'react';
  import { createRoot } from 'react-dom/client';
  import { createConversationStore } from '@agentui/client';
  import { transcriptProjection } from '@agentui/contracts/conversation';
  import { ConversationView } from './apps/desktop/src/application/ConversationView.tsx';
  const scope = { hostId: 'host', conversationId: 'image' };
  const saved = new Map();
  let records = null, receive = null, count = 0;
  globalThis.submitted = [];
  globalThis.reads = [];
  const store = createConversationStore({ scope, projection: transcriptProjection, createCommandId: () => '00000000-0000-4000-8000-' + String(++count).padStart(12, '0'),
    drafts: { load: async () => records, async save(next, image) { records = next; for (const id of image?.remove ?? []) saved.delete(id); if (image?.put) saved.set(image.put.selectionId, image.put.bytes); },
      loadImage: async (_, id) => saved.get(id) ?? null },
    images: { async upload({ name, bytes }) { globalThis.uploadedBytes = bytes.byteLength;
      return { imageId: '00000000-0000-4000-8000-aaaaaaaaaaaa', name, mediaType: 'image/png', byteLength: bytes.byteLength, width: 1, height: 1 }; } },
    port: { scope, receipt: async () => null,
      async submit(command) { globalThis.submitted.push(command);
        return { kind: 'receipt', receipt: { scope, clientCommandId: command.clientCommandId, hostOperationId: 'operation', sequence: 1, state: { kind: 'accepted' } } }; },
      watch(request, callback) { receive = callback; return { ended: new Promise(() => {}), close() {} }; } } });
  globalThis.savedImages = () => saved.size;
  globalThis.deliver = item => receive(item);
  const active = { store, viewId: 'view', scope, agent: { id: 'codex', label: 'Codex', runtime: { engine: 'codex', version: '1', format: 'jsonl' },
    model: { id: 'model', label: 'Model', inputModalities: ['text', 'image'] }, commands: ['send'], availability: { kind: 'ready' } } };
  const actions = { submit: operation => operation().then(() => undefined), async readImage(imageId) { globalThis.reads.push(imageId); return globalThis.previewBytes; } };
  void store.connect();
  createRoot(document.getElementById('conversation')).render(<ConversationView active={active} actions={actions} enabled={true} storageFailure="" />);`, resolveDir: root, loader: 'jsx' },
  bundle: true, write: false, format: 'iife', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' } });
const css = (await readFile(new URL('apps/desktop/src/application/application.css', `file://${root}`), 'utf8'));
const TAURI_CSP = JSON.parse(await readFile(new URL('apps/desktop/src-tauri/tauri.conf.json', `file://${root}`), 'utf8')).app.security.csp;

for (const [shell, csp] of [['host browser', HOST_CSP], ['Tauri', TAURI_CSP]]) test(`a picked PNG uploads, sends without text and appears as an authorized preview under the ${shell} CSP`, async t => {
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage();
  const requests = [], errors = [], violations = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (/Content Security Policy/.test(message.text())) violations.push(message.text()); });
  const assets = { '/': ['text/html', '<!doctype html><link rel="stylesheet" href="/app.css"><main id="conversation"></main><script src="/app.js"></script>'],
    '/app.css': ['text/css', css], '/app.js': ['text/javascript', bundle.outputFiles[0].text] };
  await page.route('**/*', async route => {
    const url = new URL(route.request().url()), asset = url.origin === 'https://image.test' ? assets[url.pathname] : undefined;
    if (asset) await route.fulfill({ contentType: asset[0], body: asset[1], headers: { 'content-security-policy': csp } });
    else { requests.push(route.request().url()); await route.abort(); }
  });
  await page.goto('https://image.test/');
  await page.waitForFunction(() => typeof globalThis.deliver === 'function');
  await page.evaluate(bytes => { globalThis.previewBytes = new Uint8Array(bytes); }, [...png]);
  await page.evaluate(() => globalThis.deliver({ kind: 'snapshot', snapshot: { scope: { hostId: 'host', conversationId: 'image' }, projectionVersion: 4, cursor: 0,
    document: { domain: { messages: [], currentRun: null }, receipts: {}, decisions: {} } } }));
  const send = page.getByRole('button', { name: 'Send', exact: true });
  assert.equal(await send.isDisabled(), true);
  await page.getByLabel('Image file').setInputFiles({ name: 'chart.png', mimeType: 'image/png', buffer: png });
  const card = page.getByLabel('Attached image');
  await card.getByRole('status').filter({ hasText: 'Ready' }).waitFor();
  assert.match(await card.textContent(), /chart\.png · 70 B/);
  assert.equal(await page.evaluate(() => globalThis.uploadedBytes), png.length);
  await send.click();
  await card.waitFor({ state: 'detached' });
  const submitted = await page.evaluate(() => globalThis.submitted);
  assert.deepEqual(submitted.map(command => command.body), [{ kind: 'send', text: '', imageId: '00000000-0000-4000-8000-aaaaaaaaaaaa' }]);
  assert.equal(await page.evaluate(() => globalThis.savedImages()), 0);
  await page.evaluate(() => globalThis.deliver({ kind: 'events', events: [{ scope: { hostId: 'host', conversationId: 'image' }, sequence: 1, event: { kind: 'domain', event: {
    kind: 'message-updated', messageId: 'sent', revision: 1, role: 'user', text: '', complete: true,
    image: { imageId: '00000000-0000-4000-8000-aaaaaaaaaaaa', name: 'chart.png', mediaType: 'image/png', byteLength: 70, width: 1, height: 1 } } } }] }));
  const preview = page.locator('.message-user').getByRole('img', { name: 'chart.png' });
  await preview.waitFor();
  await page.waitForFunction(() => document.querySelector('.message-user img')?.naturalWidth === 1);
  assert.match(await preview.getAttribute('src'), /^blob:/);
  assert.deepEqual(await page.evaluate(() => globalThis.reads), ['00000000-0000-4000-8000-aaaaaaaaaaaa']);
  assert.deepEqual(requests, []);
  assert.deepEqual(errors, []);
  assert.deepEqual(violations, []);
});

test('a preview that the page cannot decode reports itself unavailable', async t => {
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage();
  const assets = { '/': ['text/html', '<!doctype html><main id="conversation"></main><script src="/app.js"></script>'], '/app.js': ['text/javascript', bundle.outputFiles[0].text] };
  await page.route('**/*', async route => {
    const asset = assets[new URL(route.request().url()).pathname];
    await (asset ? route.fulfill({ contentType: asset[0], body: asset[1], headers: { 'content-security-policy': HOST_CSP } }) : route.abort());
  });
  await page.goto('https://image.test/');
  await page.waitForFunction(() => typeof globalThis.deliver === 'function');
  await page.evaluate(() => { globalThis.previewBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]); });
  const scope = { hostId: 'host', conversationId: 'image' };
  await page.evaluate(scope => globalThis.deliver({ kind: 'snapshot', snapshot: { scope, projectionVersion: 4, cursor: 0, document: { domain: { messages: [{
    messageId: 'sent', revision: 1, role: 'user', text: '', complete: true,
    image: { imageId: '00000000-0000-4000-8000-aaaaaaaaaaaa', name: 'broken.png', mediaType: 'image/png', byteLength: 7, width: 1, height: 1 } }], currentRun: null }, receipts: {}, decisions: {} } } }), scope);
  await page.locator('.message-user').getByText('Preview unavailable').waitFor();
  assert.equal(await page.locator('.message-user img').count(), 0);
});
