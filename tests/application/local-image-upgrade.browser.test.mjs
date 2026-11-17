import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('../../', import.meta.url));
const directory = new URL('./fixtures/released-local-images/', import.meta.url);
const provenance = JSON.parse(readFileSync(new URL('capture-summary.json', directory), 'utf8'));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

for (const expected of provenance.fixtureCases) test(`released ${expected.kind} hydrates and upgrades through actual browser storage`, { timeout: 20_000 }, async t => {
  const source = readFileSync(new URL(expected.filename, directory));
  assert.equal(sha256(source), expected.sha256);
  assert.equal(sha256(readFileSync(new URL('selected-image.png', directory))), expected.byteSha256);
  const captured = JSON.parse(source);
  const bundle = await build({ stdin: { contents: `
    import { BrowserViewStorage } from './apps/desktop/src/application/browser-storage.ts';
    import { createConversationStore } from '@agentui/client';
    import { transcriptProjection } from '@agentui/contracts/conversation';
    Object.assign(globalThis, { BrowserViewStorage, createConversationStore, transcriptProjection });
  `, resolveDir: root }, bundle: true, write: false, format: 'iife' });
  const browser = await chromium.launch(); t.after(() => browser.close());
  const page = await browser.newPage();
  await page.route('http://localhost/**', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Released local image upgrade</title>' }));
  await page.goto('http://localhost/upgrade'); await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const observed = await page.evaluate(async captured => {
    const opening = indexedDB.open(captured.database.name, captured.database.version);
    opening.onupgradeneeded = () => opening.result.createObjectStore(captured.database.objectStore);
    const db = await new Promise((resolve, reject) => { opening.onsuccess = () => resolve(opening.result); opening.onerror = () => reject(opening.error); });
    const tx = db.transaction('records', 'readwrite');
    for (const { key, value } of captured.records) tx.objectStore('records').put(value.type === 'Uint8Array' ? new Uint8Array(value.bytes) : value, key);
    await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onabort = () => reject(tx.error); });
    async function rows() {
      const request = db.transaction('records').objectStore('records').openCursor(), entries = [];
      await new Promise((resolve, reject) => {
        request.onerror = () => reject(request.error);
        request.onsuccess = () => { const cursor = request.result; if (!cursor) return resolve();
          entries.push({ key: cursor.key, value: cursor.value instanceof Uint8Array ? { type: 'Uint8Array', bytes: [...cursor.value] } : cursor.value }); cursor.continue(); };
      });
      return entries;
    }
    const owner = await BrowserViewStorage.reopen(captured.viewId, error => { throw error; });
    const submitted = [], uploads = [], bytePuts = [], saves = [];
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function(value, key) {
      if (Array.isArray(key) && key[0] === 'draft-image') bytePuts.push(key);
      if (Array.isArray(key) && key[0] === 'draft') saves.push(value.version);
      return put.call(this, value, key);
    };
    const port = { scope: captured.scope, async submit(command) { submitted.push(command); throw new Error('Reply lost'); }, async receipt() { return null; },
      watch() { return { ended: new Promise(() => {}), close() {} }; } };
    const images = { async upload(input) { uploads.push({ ...input, bytes: [...input.bytes] }); return {
      imageId: '33333333-3333-4333-8333-333333333333', name: input.name, mediaType: 'image/png', byteLength: input.bytes.length, width: 1, height: 1,
    }; } };
    const store = createConversationStore({ scope: captured.scope, projection: transcriptProjection, drafts: owner.drafts(error => { throw error; }),
      port, images, createCommandId: () => 'new-command' });
    try {
      await store.ready;
      const hydrated = { rows: await rows(), view: store.getSnapshot(), saves: saves.slice(), uploads: uploads.slice(), submitted: submitted.slice() };
      await store.setDraft('First joint edit');
      const edited = await rows();
      if (captured.kind === 'interrupted-upload') await store.retryImage();
      if (captured.kind === 'pending-image-command') await store.retry(store.getSnapshot().outbox[0].command.clientCommandId).catch(error => { if (error.message !== 'Reply lost') throw error; });
      return { hydrated, edited, final: await rows(), uploads, submitted, bytePuts, saves, image: store.getSnapshot().image };
    } finally { IDBObjectStore.prototype.put = put; await store.dispose(); await owner.close(); db.close(); }
  }, captured);
  const old = captured.records.find(row => row.key[0] === 'draft').value;
  const edited = observed.edited.find(row => row.key[0] === 'draft').value;
  assert.deepEqual(observed.hydrated.rows, captured.records);
  assert.deepEqual(observed.hydrated.saves, []); assert.deepEqual(observed.hydrated.uploads, []); assert.deepEqual(observed.hydrated.submitted, []);
  assert.equal(observed.hydrated.view.image.status, expected.kind === 'interrupted-upload' ? 'interrupted' : 'ready');
  assert.deepEqual(edited, { ...old, version: 3, draft: 'First joint edit', draftRevision: old.draftRevision + 1, frontendSends: [] });
  for (const row of captured.records.filter(row => row.key[0] !== 'draft')) {
    assert.deepEqual(observed.final.find(item => JSON.stringify(item.key) === JSON.stringify(row.key)), row);
  }
  assert.deepEqual(observed.bytePuts, []);
  assert.ok(observed.saves.every(version => version === 3));
  assert.deepEqual(observed.final.find(row => row.key[0] === 'draft').value.outbox, old.outbox);
  if (expected.kind === 'interrupted-upload') {
    assert.deepEqual(observed.uploads, [{ scope: captured.scope, uploadId: old.image.uploadId, name: old.image.name,
      bytes: captured.records.find(row => row.key[0] === 'draft-image').value.bytes }]);
    assert.equal(observed.image.selectionId, old.image.selectionId); assert.equal(observed.image.status, 'ready');
  } else assert.deepEqual(observed.uploads, []);
  assert.deepEqual(observed.submitted, expected.kind === 'pending-image-command' ? old.outbox.map(entry => entry.command) : []);
});
