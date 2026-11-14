import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('../../', import.meta.url));
async function fixture(t) {
  const bundle = await build({ stdin: { contents: `import { BrowserViewStorage } from './apps/desktop/src/application/browser-storage.ts';
    globalThis.BrowserViewStorage = BrowserViewStorage;`, resolveDir: root }, bundle: true, write: false, format: 'iife' });
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.route('http://localhost/**', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Saved view storage</title>' }));
  await page.goto('http://localhost/storage');
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  return page;
}

test('saved view listing skips unreadable foreign rows, bounds pages and preserves every record', async t => {
  const page = await fixture(t);
  const result = await page.evaluate(async () => {
    const owner = await globalThis.BrowserViewStorage.open(() => {});
    const opened = indexedDB.open('agentui-browser-views', 1);
    const db = await new Promise((resolve, reject) => { opened.onsuccess = () => resolve(opened.result); opened.onerror = () => reject(opened.error); });
    const write = db.transaction('records', 'readwrite');
    const records = write.objectStore('records');
    for (let index = 0; index < 105; index++) records.put({ version: 2, retained: index }, ['view', `!a-${String(index).padStart(3, '0')}`, 'host']);
    records.put({ version: 1, route: null, pendingCreation: null }, ['view', 'z-valid', 'host']);
    records.put({ version: 2, retained: 'own' }, ['view', owner.viewId, 'host']);
    await new Promise((resolve, reject) => { write.oncomplete = resolve; write.onerror = () => reject(write.error); });
    const first = await owner.savedViews('host');
    const second = await owner.savedViews('host', first.after);
    let ownFailure;
    try { await owner.readView('host'); } catch (error) { ownFailure = error.message; }
    const count = db.transaction('records').objectStore('records').count();
    const retained = await new Promise((resolve, reject) => { count.onsuccess = () => resolve(count.result); count.onerror = () => reject(count.error); });
    owner.close();
    db.close();
    return { first, second, ownFailure, retained };
  });
  assert.deepEqual(result.first, { ids: [], unreadable: 100, after: JSON.stringify(['!a-099', 'host']) });
  assert.deepEqual(result.second, { ids: ['z-valid'], unreadable: 5, after: null });
  assert.match(result.ownFailure, /Unsupported saved view.*preserved/);
  assert.equal(result.retained, 107);
});

test('a schema upgrade releases the old database and view lock and reports a reload requirement', async t => {
  const page = await fixture(t);
  const result = await page.evaluate(async () => {
    const failures = [];
    const owner = await globalThis.BrowserViewStorage.open(error => failures.push(error.message));
    await owner.saveView('host', { version: 1, route: null, pendingCreation: null });
    const upgrade = indexedDB.open('agentui-browser-views', 2);
    const db = await new Promise((resolve, reject) => { upgrade.onsuccess = () => resolve(upgrade.result); upgrade.onerror = () => reject(upgrade.error); });
    const lockReleased = await navigator.locks.request(`agentui-view:${owner.viewId}`, { ifAvailable: true }, lock => lock !== null);
    let writeFailure;
    try { await owner.saveView('host', { version: 1, route: null, pendingCreation: null }); } catch (error) { writeFailure = error.message; }
    const read = db.transaction('records').objectStore('records').get(['view', owner.viewId, 'host']);
    const retained = await new Promise((resolve, reject) => { read.onsuccess = () => resolve(read.result); read.onerror = () => reject(read.error); });
    db.close();
    return { failures, lockReleased, writeFailure, retained };
  });
  assert.equal(result.failures.length, 1);
  assert.match(result.failures[0], /changed.*Reload/);
  assert.equal(result.lockReleased, true);
  assert.match(result.writeFailure, /no longer owns local storage/);
  assert.deepEqual(result.retained, { version: 1, route: null, pendingCreation: null });
});


test('foreign-host scans are bounded and continuation retains another host row for the same view', async t => {
  const page = await fixture(t);
  const result = await page.evaluate(async () => {
    const owner = await globalThis.BrowserViewStorage.open(() => {});
    const opened = indexedDB.open('agentui-browser-views', 1);
    const db = await new Promise((resolve, reject) => { opened.onsuccess = () => resolve(opened.result); opened.onerror = () => reject(opened.error); });
    const write = db.transaction('records', 'readwrite'), rows = write.objectStore('records');
    for (let index = 0; index < 100; index++) rows.put({ version: 1, route: null, pendingCreation: null }, ['view', 'foreign-view', `a-${String(index).padStart(3, '0')}`]);
    rows.put({ version: 1, route: null, pendingCreation: null }, ['view', 'foreign-view', 'z-host']);
    await new Promise((resolve, reject) => { write.oncomplete = resolve; write.onerror = () => reject(write.error); });
    const first = await owner.savedViews('z-host');
    const second = await owner.savedViews('z-host', first.after);
    owner.close(); db.close();
    return { first, second };
  });
  assert.deepEqual(result.first, { ids: [], unreadable: 0, after: JSON.stringify(['foreign-view', 'a-099']) });
  assert.deepEqual(result.second, { ids: ['foreign-view'], unreadable: 0, after: null });
});
