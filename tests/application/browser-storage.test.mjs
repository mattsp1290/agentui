import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('../../', import.meta.url));
async function fixture(t) {
  const bundle = await build({ stdin: { contents: `import { BrowserViewStorage } from './apps/desktop/src/application/browser-storage.ts';
    import { createConversationStore } from '@agentui/client';
    import { transcriptProjection } from '@agentui/contracts/conversation';
    Object.assign(globalThis, { BrowserViewStorage, createConversationStore, transcriptProjection });`, resolveDir: root }, bundle: true, write: false, format: 'iife' });
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.route('http://localhost/**', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Saved view storage</title>' }));
  await page.goto('http://localhost/storage');
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  return page;
}

async function holdNativeView(page) {
  const holder = await page.context().newPage();
  await holder.route('http://localhost/**', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Previous native document</title>' }));
  await holder.goto('http://localhost/previous');
  await holder.evaluate(async () => {
    const acquired = Promise.withResolvers();
    void navigator.locks.request('agentui-view:native-mac-default', () => new Promise(release => {
      globalThis.releaseView = release;
      acquired.resolve();
    }));
    await acquired.promise;
  });
  return holder;
}

test('native initial view waits for the previous document and retains its exact route and draft', { timeout: 10_000 }, async t => {
  const page = await fixture(t);
  const scope = { hostId: 'host', conversationId: 'native-reload' };
  await page.evaluate(async scope => {
    const owner = await globalThis.BrowserViewStorage.reopen('native-mac-default', () => {});
    await owner.saveView('host', { version: 2, route: scope, pendingCreation: null });
    await owner.drafts(() => {}).save({ scope, draft: 'Keep the native reload draft' });
    await owner.close();
  }, scope);
  const holder = await holdNativeView(page);
  const occupied = await page.evaluate(async () => {
    try { await globalThis.BrowserViewStorage.reopen('native-mac-default', () => {}); }
    catch (error) { return error.message; }
  });
  assert.match(occupied, /already open/);
  const [, result] = await Promise.all([
    holder.evaluate(async () => {
      const deadline = Date.now() + 5000;
      while (!(await navigator.locks.query()).pending.some(lock => lock.name === 'agentui-view:native-mac-default')) {
        if (Date.now() > deadline) throw new Error('Native view did not wait for the previous document');
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      globalThis.releaseView();
    }),
    page.evaluate(async scope => {
      const owner = await globalThis.BrowserViewStorage.reopen('native-mac-default', () => {}, true);
      const result = { viewId: owner.viewId, sessionViewId: sessionStorage.getItem('agentui.viewId'),
        saved: await owner.readView('host'), draft: await owner.drafts(() => {}).load(scope) };
      await owner.close();
      return result;
    }, scope),
  ]);
  assert.equal(result.viewId, 'native-mac-default');
  assert.equal(result.sessionViewId, 'native-mac-default');
  assert.deepEqual(result.saved, { version: 2, route: scope, pendingCreation: null });
  assert.deepEqual(result.draft, { scope, draft: 'Keep the native reload draft' });
});

test('native initial view refuses a lock that stays held without inventing another view', { timeout: 10_000 }, async t => {
  const page = await fixture(t);
  const holder = await holdNativeView(page);
  const result = await page.evaluate(async () => {
    let failure;
    try { await globalThis.BrowserViewStorage.reopen('native-mac-default', () => {}, true); }
    catch (error) { failure = error.message; }
    const lockAvailable = await navigator.locks.request('agentui-view:native-mac-default', { ifAvailable: true }, lock => lock !== null);
    return { failure, lockAvailable, sessionViewId: sessionStorage.getItem('agentui.viewId') };
  });
  await holder.evaluate(() => globalThis.releaseView());
  assert.match(result.failure, /already open/);
  assert.equal(result.lockAvailable, false);
  assert.equal(result.sessionViewId, null);
});

test('saved views reject noncanonical records without overwriting local data or deleting foreign records', async t => {
  const page = await fixture(t);
  const result = await page.evaluate(async () => {
    const owner = await globalThis.BrowserViewStorage.open(() => {});
    const original = { version: 1, route: null, pendingCreation: null };
    await owner.saveView('host', original);
    const failures = [];
    for (const value of [{ ...original, extra: true }, Object.create(original),
      Object.defineProperty({ route: null, pendingCreation: null }, 'version', { get() { throw new Error('Getter evaluated'); }, enumerable: true })]) {
      try { await owner.saveView('host', value); } catch (error) { failures.push(error.message); }
    }
    const retained = await owner.readView('host');
    const opened = indexedDB.open('agentui-browser-views', 1);
    const db = await new Promise((resolve, reject) => { opened.onsuccess = () => resolve(opened.result); opened.onerror = () => reject(opened.error); });
    const write = db.transaction('records', 'readwrite');
    const foreign = { ...original, extra: 'preserve' };
    write.objectStore('records').put(foreign, ['view', 'foreign', 'host']);
    await new Promise((resolve, reject) => { write.oncomplete = resolve; write.onerror = () => reject(write.error); });
    const listed = await owner.savedViews('host');
    const read = db.transaction('records').objectStore('records').get(['view', 'foreign', 'host']);
    const foreignRetained = await new Promise((resolve, reject) => { read.onsuccess = () => resolve(read.result); read.onerror = () => reject(read.error); });
    owner.close(); db.close();
    return { failures, retained, listed, foreignRetained };
  });
  assert.deepEqual(result.failures, Array(3).fill('Unsupported saved view. Local records were preserved.'));
  assert.deepEqual(result.retained, { version: 2, route: null, pendingCreation: null });
  assert.deepEqual(result.listed, { ids: [], unreadable: 1, after: null });
  assert.deepEqual(result.foreignRetained, { version: 1, route: null, pendingCreation: null, extra: 'preserve' });
});

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
  assert.deepEqual(result.retained, { version: 2, route: null, pendingCreation: null });
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

test('legacy pending scopes migrate without inventing a selected agent or changing draft keys', async t => {
  const page = await fixture(t);
  const result = await page.evaluate(async () => {
    const owner = await globalThis.BrowserViewStorage.open(() => {});
    const scope = { hostId: 'host', conversationId: 'legacy-pending' };
    const open = indexedDB.open('agentui-browser-views', 1);
    const db = await new Promise(resolve => { open.onsuccess = () => resolve(open.result); });
    const transaction = db.transaction('records', 'readwrite');
    transaction.objectStore('records').put({ version: 1, route: scope, pendingCreation: scope }, ['view', owner.viewId, 'host']);
    transaction.objectStore('records').put({ draft: 'Keep this draft' }, ['draft', owner.viewId, scope.hostId, scope.conversationId]);
    await new Promise(resolve => { transaction.oncomplete = resolve; });
    const migrated = await owner.readView('host');
    await owner.saveView('host', migrated);
    const reread = await owner.readView('host');
    const draft = await owner.drafts(() => {}).load(scope);
    owner.close(); db.close();
    return { migrated, reread, draft };
  });
  const scope = { hostId: 'host', conversationId: 'legacy-pending' };
  assert.deepEqual(result.migrated, { version: 2, route: scope, pendingCreation: { scope, agentId: null } });
  assert.deepEqual(result.reread, result.migrated);
  assert.deepEqual(result.draft, { draft: 'Keep this draft' });
});

test('close holds the view lock until admitted writes and saved-view scans finish', async t => {
  const page = await fixture(t);
  const result = await page.evaluate(async () => {
    const owner = await globalThis.BrowserViewStorage.open(() => {});
    const original = IDBDatabase.prototype.transaction;
    let holding = true;
    IDBDatabase.prototype.transaction = function (...args) {
      const transaction = original.apply(this, args);
      const store = transaction.objectStore('records');
      const keepAlive = () => { if (holding) store.get('hold').onsuccess = keepAlive; };
      keepAlive();
      return transaction;
    };
    const scope = { hostId: 'host', conversationId: 'draining' };
    const admitted = owner.drafts(() => {}).save({ scope, draft: 'Admitted before close' });
    const listing = owner.savedViews('host');
    const closing = owner.close();
    const samePromise = closing === owner.close();
    let settled = false;
    void closing.then(() => { settled = true; });
    const lockDuringDrain = await navigator.locks.request(`agentui-view:${owner.viewId}`, { ifAvailable: true }, lock => lock !== null);
    const settledDuringDrain = settled;
    let rejected;
    try { await owner.readView('host'); } catch (error) { rejected = error.message; }
    holding = false;
    IDBDatabase.prototype.transaction = original;
    await Promise.all([admitted, listing, closing]);
    const successor = await globalThis.BrowserViewStorage.reopen(owner.viewId, () => {});
    const retained = await successor.drafts(() => {}).load(scope);
    await successor.close();
    return { samePromise, lockDuringDrain, settledDuringDrain, rejected, retained };
  });
  assert.equal(result.samePromise, true);
  assert.equal(result.lockDuringDrain, false);
  assert.equal(result.settledDuringDrain, false);
  assert.match(result.rejected, /no longer owns local storage/);
  assert.equal(result.retained.draft, 'Admitted before close');
});

test('close drains a saved-view scan through abort before releasing ownership', async t => {
  const page = await fixture(t);
  const result = await page.evaluate(async () => {
    const owner = await globalThis.BrowserViewStorage.open(() => {});
    const original = IDBDatabase.prototype.transaction;
    let transaction;
    IDBDatabase.prototype.transaction = function (...args) { transaction = original.apply(this, args); return transaction; };
    const listing = owner.savedViews('host').catch(error => error.message);
    IDBDatabase.prototype.transaction = original;
    let aborted = false;
    transaction.addEventListener('abort', () => { aborted = true; });
    transaction.abort();
    await owner.close();
    const lockReleased = await navigator.locks.request(`agentui-view:${owner.viewId}`, { ifAvailable: true }, lock => lock !== null);
    return { aborted, lockReleased, failure: await listing };
  });
  assert.equal(result.aborted, true);
  assert.equal(result.lockReleased, true);
  assert.match(result.failure, /saved view/i);
});

test('late whole-record settlement from an old store cannot overwrite successor drafts or replay commands', async t => {
  const page = await fixture(t);
  const result = await page.evaluate(async () => {
    const owner = await globalThis.BrowserViewStorage.open(() => {});
    const scope = { hostId: 'host', conversationId: 'late-settlement' };
    let reply, entered;
    const submitted = [];
    const enteredSubmission = new Promise(resolve => { entered = resolve; });
    const port = { scope, receipt: async () => null,
      submit(command) { submitted.push(command); entered(); return new Promise(resolve => { reply = resolve; }); },
      watch() { return { ended: new Promise(() => {}), close() {} }; } };
    const makeStore = storage => globalThis.createConversationStore({ scope, port, projection: globalThis.transcriptProjection,
      drafts: storage.drafts(() => {}), createCommandId: () => 'original-command' });
    const old = makeStore(owner);
    await old.ready;
    await old.setDraft('Original message');
    const sending = old.send().catch(error => error.message);
    await enteredSubmission;
    old.disconnect();
    await owner.close();
    const successor = await globalThis.BrowserViewStorage.reopen(owner.viewId, () => {});
    const current = makeStore(successor);
    await current.ready;
    await current.connect();
    await current.setDraft('Successor unfinished draft');
    const before = await successor.drafts(() => {}).load(scope);
    reply({ kind: 'receipt', receipt: { scope, clientCommandId: 'original-command', hostOperationId: 'operation', sequence: 1,
      state: { kind: 'accepted' } } });
    const failure = await sending;
    const retained = await successor.drafts(() => {}).load(scope);
    current.disconnect();
    await successor.close();
    return { before, retained, failure, submitted };
  });
  assert.match(result.failure, /no longer owns local storage/);
  assert.equal(result.retained.draft, 'Successor unfinished draft');
  assert.deepEqual(result.retained, result.before);
  assert.equal(result.retained.outbox.length, 1);
  assert.deepEqual(result.retained.outbox[0].command, result.submitted[0]);
  assert.equal(result.submitted.length, 1);
});

test('draft image bytes change with their records in one transaction and stay outside saved views', async t => {
  const page = await fixture(t);
  const result = await page.evaluate(async () => {
    const owner = await globalThis.BrowserViewStorage.open(() => {});
    const drafts = owner.drafts(() => {});
    const scope = { hostId: 'host', conversationId: 'image-draft' };
    const records = image => ({ version: 2, scope, draft: '', draftRevision: 1, outbox: [], image });
    await drafts.save(records('first'), { put: { selectionId: 'first', bytes: new Uint8Array([1, 2]) } });
    await drafts.save(records('second'), { put: { selectionId: 'second', bytes: new Uint8Array([3]) }, remove: ['first'] });
    const replaced = [await drafts.loadImage(scope, 'first'), [...await drafts.loadImage(scope, 'second')], (await drafts.load(scope)).image];
    const refused = await drafts.save({ ...records('third'), unclonable: () => {} }, { put: { selectionId: 'third', bytes: new Uint8Array([4]) }, remove: ['second'] })
      .then(() => 'saved', error => error.name);
    const afterRefusal = [await drafts.loadImage(scope, 'third'), [...await drafts.loadImage(scope, 'second')], (await drafts.load(scope)).image];
    await drafts.save(records(null), { remove: ['second'] });
    const removed = await drafts.loadImage(scope, 'second');
    const views = await owner.savedViews('host', null);
    await owner.close();
    return { replaced, refused, afterRefusal, removed, views };
  });
  assert.deepEqual(result.replaced, [null, [3], 'second']);
  assert.equal(result.refused, 'DataCloneError');
  assert.deepEqual(result.afterRefusal, [null, [3], 'second']);
  assert.equal(result.removed, null);
  assert.deepEqual(result.views, { ids: [], unreadable: 0, after: null });
});

test('a replaced draft port for the same conversation cannot overwrite its successor', async t => {
  const page = await fixture(t);
  const result = await page.evaluate(async () => {
    const owner = await globalThis.BrowserViewStorage.open(() => {});
    const failures = [];
    const scope = { hostId: 'host', conversationId: 'replaced' };
    const records = (draft, image) => ({ version: 2, scope, draft, draftRevision: 1, outbox: [], image });
    const stale = owner.drafts(error => failures.push(error)), current = owner.drafts(error => failures.push(error));
    await stale.load(scope);
    await stale.save(records('old', 'first'), { put: { selectionId: 'first', bytes: new Uint8Array([1]) } });
    await current.load(scope);
    await current.save(records('new', 'second'), { put: { selectionId: 'second', bytes: new Uint8Array([2]) }, remove: ['first'] });
    const refused = await stale.save(records('old', 'first'), { put: { selectionId: 'first', bytes: new Uint8Array([1]) }, remove: ['second'] })
      .then(() => null, error => ({ name: error.name, message: error.message }));
    const saved = await current.load(scope);
    const bytes = [await current.loadImage(scope, 'first'), [...await current.loadImage(scope, 'second')]];
    const submitted = [], port = { scope, receipt: async () => null, async submit(command) { submitted.push(command); return { kind: 'rejected', reason: 'unexpected' }; },
      watch() { return { ended: new Promise(() => {}), close() {} }; } };
    const storeScope = { hostId: 'host', conversationId: 'replaced-store' };
    const makeStore = () => globalThis.createConversationStore({ scope: storeScope, port: { ...port, scope: storeScope }, projection: globalThis.transcriptProjection,
      drafts: owner.drafts(error => failures.push(error)), createCommandId: () => '00000000-0000-4000-8000-000000000001' });
    const older = makeStore();
    await older.ready;
    await older.setDraft('Typed in the older view');
    const newer = makeStore();
    await newer.ready;
    const blocked = await Promise.all([older.send(), older.setDraft('More')].map(attempt => attempt.then(() => 'written', error => error.name)));
    const kept = await owner.drafts(() => {}).load(storeScope);
    await owner.close();
    return { refused, blocked, submitted: submitted.length, kept: [kept.draft, kept.outbox.length], draft: saved.draft, image: saved.image, bytes, failures: failures.length };
  });
  assert.deepEqual(result, { refused: { name: 'SupersededDrafts', message: 'This conversation was reopened in a newer view.' },
    blocked: ['SupersededDrafts', 'SupersededDrafts'], submitted: 0, kept: ['Typed in the older view', 0], draft: 'new', image: 'second', bytes: [null, [2]], failures: 0 });
});
