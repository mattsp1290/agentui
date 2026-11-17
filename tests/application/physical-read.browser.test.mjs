import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('../../', import.meta.url));
async function fixture(t) {
  const bundle = await build({ stdin: { contents: `
    import { createElement } from 'react';
    import { createRoot } from 'react-dom/client';
    import { ConversationView } from './apps/desktop/src/application/ConversationView.tsx';
    import { BrowserViewStorage } from './apps/desktop/src/application/browser-storage.ts';
    import { createApplicationController } from './apps/desktop/src/application/application-controller.ts';
    import { createFrontendToolGeneration } from '@agentui/sdk/tools';
    import { SERVICE_WIRE_VERSION, EXTENSION_SDK_VERSION, RECORDED_RUNTIME } from '@agentui/contracts/compatibility';
    import { transcriptProjection } from '@agentui/contracts/conversation';
    Object.assign(globalThis, { BrowserViewStorage, createApplicationController, createFrontendToolGeneration,
      SERVICE_WIRE_VERSION, EXTENSION_SDK_VERSION, RECORDED_RUNTIME, transcriptProjection, createElement, createRoot, ConversationView });
  `, resolveDir: root }, bundle: true, write: false, format: 'iife' });
  const browser = await chromium.launch(); t.after(() => browser.close());
  const page = await browser.newPage();
  await page.route('http://localhost/**', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Read ownership</title>' }));
  await page.goto('http://localhost/probe');
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  return page;
}

for (const scenario of ['obsolete-read-abort', 'obsolete-parse', 'current-read-abort', 'captured-save-abort', 'versionchange', 'obsolete-image-read', 'current-image-read']) {
  test(`real browser failure ownership for ${scenario}`, { timeout: 20_000 }, async t => {
    const page = await fixture(t);
  const result = await page.evaluate(async scenario => {
        const scope = { hostId: 'host', conversationId: 'conversation' };
        const staleScope = { hostId: 'host', conversationId: 'z-stale' };
        const saved = { version: 2, route: scope, pendingCreation: null };
        const raw = await new Promise((resolve, reject) => {
          const request = indexedDB.open('agentui-browser-views', 1);
          request.onupgradeneeded = () => request.result.createObjectStore('records');
          request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
        });
        async function put(value, key) {
          const tx = raw.transaction('records', 'readwrite'); tx.objectStore('records').put(value, key);
          await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onabort = () => reject(tx.error); });
        }
        await put(saved, ['view', 'A', 'host']); await put(saved, ['view', 'B', 'host']);
        sessionStorage.setItem('agentui.viewId', 'A');
        const failures = [], feeds = [], submitted = [];
        let id = 0, generationDisposals = 0;
        const imageRead = scenario.endsWith('image-read');
        const descriptor = { id: 'default', label: 'Default', kind: 'provider', namespace: 'fixture', protocolVersion: '1',
          frontendOffers: 'ag-ui-capture-and-bind', commands: ['send', 'cancel', 'approve'], availability: { kind: 'ready' } };
        const connection = {
          async uploadImage() { throw new Error('Interrupted upload'); },
          async metadata() { return { hostId: 'host', principalId: 'principal', agents: [descriptor], defaultAgentId: descriptor.id,
            compatibility: { wireVersion: SERVICE_WIRE_VERSION, extensionSdkVersion: EXTENSION_SDK_VERSION,
              nativeRuntime: RECORDED_RUNTIME, desiredGitRevision: 'revision', appliedArtifact: { gitRevision: 'revision', artifactId: 'artifact' } } }; },
          async catalog() { return []; }, async conversationAgent() { return descriptor; },
          async conversationPermissions() { return { kind: 'available', observedAt: new Date().toISOString(), permissions: [] }; },
          async providerObservation() { return { kind: 'not-applicable' }; },
          async frontendBinding(request) { return { kind: 'pending', id: request.id }; },
          conversation(selected) { return { scope: selected,
            async submit(command) { submitted.push(command); throw new Error('Reply lost'); }, async receipt() { return null; },
            watch(request, receive) { const ended = Promise.withResolvers(); const feed = { scope: selected, receive, ended: ended.promise,
              close() { ended.resolve(); } }; feeds.push(feed); return feed; } }; },
        };
        function wrap(storage) {
          return { viewId: storage.viewId, select: () => storage.select(), readView: (...a) => storage.readView(...a),
            saveView: (...a) => storage.saveView(...a), savedViews: (...a) => storage.savedViews(...a),
            draftScopes: (...a) => storage.draftScopes(...a), close: () => storage.close(),
            drafts(onFailure) { return storage.drafts(error => { failures.push({ kind: 'drafts', viewId: storage.viewId, message: error.message }); onFailure(error); }); } };
        }
        const app = createApplicationController({ createConnection: () => connection, createId: () => `00000000-0000-4000-8000-${String(++id).padStart(12, '0')}`,
          ownedViewStorage: {
            open: async failure => wrap(await BrowserViewStorage.open(error => { failures.push({ kind: 'physical', viewId: 'A', message: error.message }); failure(error); })),
            reopen: async (viewId, failure) => wrap(await BrowserViewStorage.reopen(viewId, error => { failures.push({ kind: 'physical', viewId, message: error.message }); failure(error); })),
          } });
        const { generation } = await createFrontendToolGeneration({ namespace: 'fixture', generation: 'A', platform: 'desktop', capture: () => undefined,
          activate({ frontendTools }) { frontendTools.add({ definition: { name: 'echo', description: 'A' }, decodeInput: value => value,
            execute() { throw new Error('Execution is not enabled'); } }); return { dispose() { generationDisposals++; } }; } });
        const token = {}; app.frontendGenerations.begin(token); app.frontendGenerations.publish(token, { kind: 'ready', generations: [generation] });
        await app.start();
        const initial = app.getSnapshot();
        if (!initial.active) throw new Error(`No initial active view: ${JSON.stringify(initial)}`);
        await initial.active.store.send('Retained A').catch(error => { if (error.message !== 'Reply lost') throw error; });
        if (imageRead) await initial.active.store.selectImage({ name: 'pixel.png', bytes: new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]) });
        const row = app.getSnapshot().capturedSends[0];
        if (!row) throw new Error('Missing retained A capture');
        const originalCommand = structuredClone(row.command);
        const get = IDBObjectStore.prototype.get, nativePut = IDBObjectStore.prototype.put;
        let held = null, aborted = false, readRequests = 0, retryError = null, mounted = null;
        const entered = Promise.withResolvers();
        if (imageRead || ['obsolete-read-abort', 'current-read-abort', 'obsolete-parse'].includes(scenario)) {
          if (!imageRead) await put({ version: 99, scope: staleScope }, ['draft', 'A', 'host', 'z-stale']);
          IDBObjectStore.prototype.get = function(key) {
            const request = get.call(this, key);
            if (Array.isArray(key) && key[0] === (imageRead ? 'draft-image' : 'draft') && key[1] === 'A' && key[3] === (imageRead ? 'conversation' : 'z-stale') && !held) {
              const store = this, tx = this.transaction;
              held = tx; entered.resolve();
              function keepAlive() {
                if (aborted) return;
                const next = get.call(store, ['probe-keepalive']); readRequests++;
                next.onsuccess = keepAlive;
              }
              request.addEventListener('success', keepAlive, { once: true });
            }
            return request;
          };
          if (imageRead) {
            const container = document.createElement('div'); document.body.append(container);
            mounted = createRoot(container);
            mounted.render(createElement(ConversationView, { active: initial.active, actions: app.conversationActions(initial.active), enabled: true, storageFailure: '' }));
            while (![...container.querySelectorAll('button')].some(button => button.textContent === 'Retry')) await new Promise(resolve => setTimeout(resolve, 1));
            [...container.querySelectorAll('button')].find(button => button.textContent === 'Retry').click();
          } else await app.reconnect();
          await entered.promise;
          if (scenario !== 'current-read-abort' && scenario !== 'current-image-read') await app.reopenView('B');
        } else await app.reopenView('B');
        const active = app.getSnapshot().active;
        const feed = [...feeds].reverse().find(feed => feed.scope.conversationId === scope.conversationId);
        await feed.receive({ kind: 'snapshot', snapshot: { scope, projectionVersion: transcriptProjection.version, cursor: 0,
          document: { domain: transcriptProjection.initial(), receipts: {}, decisions: {} } } });
        const before = { viewId: active?.viewId, connection: active?.store.getSnapshot().connection.kind, storageFailure: app.getSnapshot().storageFailure,
          captureStatus: row.status, rowStillSame: app.getSnapshot().capturedSends[0] === row };
        let operationError = null, upgrade;
        if (held) {
          aborted = true;
          if (scenario !== 'obsolete-parse') held.abort();
        } else if (scenario === 'captured-save-abort') {
          IDBObjectStore.prototype.put = function(value, key) {
            const request = nativePut.call(this, value, key);
            if (Array.isArray(key) && key[0] === 'draft' && key[1] === 'A') this.transaction.abort();
            return request;
          };
          await app.releaseCapturedSend(row.key).catch(error => { operationError = error.message; });
        } else {
          raw.close();
          const request = indexedDB.open('agentui-browser-views', 2);
          upgrade = await new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
        }
        for (let i = 0; i < 20; i++) await new Promise(resolve => setTimeout(resolve, 5));
        retryError = imageRead ? document.querySelector('[role=alert]')?.textContent ?? null : null;
        const state = app.getSnapshot();
        let saveB;
        try { await app.conversationActions(active).commands.send('B after failure'); saveB = 'sent'; }
        catch (error) { saveB = error.message; }
        const after = { viewId: state.active?.viewId, activeSame: state.active === active, host: state.host.kind, error: state.error,
          storageFailure: state.storageFailure, connection: active?.store.getSnapshot().connection.kind,
          captures: state.capturedSends.map(entry => ({ viewId: entry.viewId, status: entry.status, command: entry.command })),
          oldCaptureSame: state.capturedSends[0] === row, generationDisposals,
          heldLock: (await navigator.locks.query()).held.some(lock => lock.name === 'agentui-view:A') };
        IDBObjectStore.prototype.get = get; IDBObjectStore.prototype.put = nativePut;
        let retryCleared = null;
        if (scenario === 'current-image-read') {
          [...document.querySelectorAll('button')].find(button => button.textContent === 'Retry').click();
          for (let i = 0; i < 20; i++) await new Promise(resolve => setTimeout(resolve, 1));
          retryCleared = document.querySelector('[role=alert]') === null;
        }
        const checkDb = upgrade ?? raw;
        const read = checkDb.transaction('records').objectStore('records').getAll();
        const records = await new Promise((resolve, reject) => { read.onsuccess = () => resolve(read.result); read.onerror = () => reject(read.error); });
        const retained = records.flatMap(value => value.frontendSends ?? []).find(entry => entry.command.clientCommandId === originalCommand.clientCommandId);
        const durable = { commandSame: JSON.stringify(retained?.command) === JSON.stringify(originalCommand), state: retained?.state,
          corruptPreserved: records.some(value => value.version === 99 && value.scope?.conversationId === 'z-stale') };
        mounted?.unmount();
        await app.dispose().catch(error => { operationError ??= error.message; });
        await generation.retire(); checkDb.close();
        return { scenario, before, after, failures, durable, saveB, operationError, retryError, retryCleared, readRequests, submitted: submitted.length };
      }, scenario);

    assert.equal(result.durable.commandSame, true);
    if (scenario.endsWith('image-read') || ['obsolete-parse', 'obsolete-read-abort'].includes(scenario)) {
      assert.equal(result.after.storageFailure, '');
      assert.equal(result.after.oldCaptureSame, true);
      assert.equal(result.after.connection, 'connected');
      assert.equal(result.after.heldLock, true);
      assert.equal(result.durable.state, 'retained');
      assert.equal(result.submitted, 2);
      if (scenario.endsWith('image-read')) assert.match(result.retryError, /transaction/);
      if (scenario === 'current-image-read') assert.equal(result.retryCleared, true);
      if (!scenario.endsWith('image-read')) assert.equal(result.durable.corruptPreserved, true);
      assert.deepEqual(result.failures, []);
    } else {
      assert.notEqual(result.after.storageFailure, '');
      assert.equal(result.after.connection, 'disconnected');
      assert.equal(result.submitted, 1);
      if (scenario === 'current-read-abort') assert.deepEqual(result.failures, []);
      else assert.ok(result.failures.some(failure => failure.kind === (scenario === 'versionchange' ? 'physical' : 'drafts')));
      if (scenario === 'captured-save-abort') assert.equal(result.durable.state, 'retained');
    }
  });
}

test('initial active acquisition reports a native readonly abort through readiness', { timeout: 20_000 }, async t => {
  const page = await fixture(t);
  const result = await page.evaluate(async () => {
    const scope = { hostId: 'host', conversationId: 'initial' }, failures = [], submitted = [];
    const initial = await BrowserViewStorage.reopen('initial-view', () => {});
    await initial.saveView('host', { version: 2, route: scope, pendingCreation: null });
    await initial.close(); sessionStorage.setItem('agentui.viewId', 'initial-view');
    const get = IDBObjectStore.prototype.get;
    let aborted = false;
    IDBObjectStore.prototype.get = function(key) {
      const request = get.call(this, key);
      if (!aborted && Array.isArray(key) && key[0] === 'draft' && key[3] === 'initial') { aborted = true; this.transaction.abort(); }
      return request;
    };
    const descriptor = { id: 'default', label: 'Default', runtime: RECORDED_RUNTIME,
      frontendOffers: 'unsupported', commands: ['send', 'cancel', 'approve'], availability: { kind: 'ready' } };
    const connection = {
      async metadata() { return { hostId: 'host', principalId: 'principal', agents: [descriptor], defaultAgentId: 'default', compatibility: {
        wireVersion: SERVICE_WIRE_VERSION, extensionSdkVersion: EXTENSION_SDK_VERSION, nativeRuntime: RECORDED_RUNTIME,
        desiredGitRevision: 'revision', appliedArtifact: { gitRevision: 'revision', artifactId: 'artifact' } } }; },
      async catalog() { return []; }, async conversationAgent() { return descriptor; },
      async conversationPermissions() { return { kind: 'available', observedAt: new Date().toISOString(), permissions: [] }; },
      async providerObservation() { return { kind: 'not-applicable' }; },
      conversation(selected) { return { scope: selected, async submit(command) { submitted.push(command); throw new Error('Unexpected dispatch'); },
        async receipt() { return null; }, watch() { return { ended: new Promise(() => {}), close() {} }; } }; },
    };
    const app = createApplicationController({ createConnection: () => connection, createId: () => 'never', ownedViewStorage: {
      async open(failure) {
        const owner = await BrowserViewStorage.open(failure), drafts = owner.drafts.bind(owner);
        owner.drafts = onFailure => drafts(error => { failures.push(error.message); onFailure(error); });
        return owner;
      }, reopen: (id, failure) => BrowserViewStorage.reopen(id, failure),
    } });
    try {
      await app.start();
      const state = app.getSnapshot();
      return { aborted, failures, submitted, storageFailure: state.storageFailure, active: state.active?.store.getSnapshot().connection.kind ?? null };
    } finally { IDBObjectStore.prototype.get = get; await app.dispose(); }
  });
  assert.equal(result.aborted, true);
  assert.deepEqual(result.failures, []);
  assert.deepEqual(result.submitted, []);
  assert.match(result.storageFailure, /transaction/);
  assert.notEqual(result.active, 'connected');
});

test('synchronous browser restart preserves the original view beyond the lock fallback deadline', { timeout: 20_000 }, async t => {
  const page = await fixture(t);
  const result = await page.evaluate(async () => {
    const scope = { hostId: 'host', conversationId: 'restart' }, viewId = '00000000-0000-4000-8000-000000000001';
    const original = await BrowserViewStorage.reopen(viewId, () => {});
    await original.saveView('host', { version: 2, route: scope, pendingCreation: null });
    await original.close(); sessionStorage.setItem('agentui.viewId', viewId);
    const descriptor = { id: 'default', label: 'Default', runtime: RECORDED_RUNTIME,
      frontendOffers: 'unsupported', commands: ['send'], availability: { kind: 'ready' } };
    const connection = {
      async metadata() { return { hostId: 'host', principalId: 'principal', agents: [descriptor], defaultAgentId: 'default', compatibility: {
        wireVersion: SERVICE_WIRE_VERSION, extensionSdkVersion: EXTENSION_SDK_VERSION, nativeRuntime: RECORDED_RUNTIME,
        desiredGitRevision: 'revision', appliedArtifact: { gitRevision: 'revision', artifactId: 'artifact' } } }; },
      async catalog() { return []; }, async conversationAgent() { return descriptor; },
      async conversationPermissions() { return { kind: 'available', observedAt: new Date().toISOString(), permissions: [] }; },
      async providerObservation() { return { kind: 'not-applicable' }; },
      conversation(selected) { return { scope: selected, async receipt() { return null; },
        watch() { return { ended: new Promise(() => {}), close() {} }; } }; },
    };
    let acquisitions = 0;
    const app = createApplicationController({ createConnection: () => connection, createId: () => 'never', ownedViewStorage: {
      async open(failure) { acquisitions++; return BrowserViewStorage.open(failure); },
      reopen: (id, failure) => BrowserViewStorage.reopen(id, failure),
    } });
    const put = IDBObjectStore.prototype.put, get = IDBObjectStore.prototype.get;
    const entered = Promise.withResolvers();
    let held = true, armed = false, unsubscribe, writing, closing, restarted;
    try {
      await app.start();
      const store = app.getSnapshot().active.store;
      IDBObjectStore.prototype.put = function(value, key) {
        const request = put.call(this, value, key);
        if (Array.isArray(key) && key[0] === 'draft' && key[1] === viewId) {
          const records = this;
          request.addEventListener('success', function keepAlive() {
            entered.resolve();
            if (held) get.call(records, ['keepalive']).addEventListener('success', keepAlive, { once: true });
          }, { once: true });
        }
        return request;
      };
      writing = store.setDraft('Preserved through slow physical commit');
      await entered.promise;
      unsubscribe = app.subscribe(() => {
        if (armed && app.getSnapshot().active === null) { armed = false; restarted = app.start(); }
      });
      armed = true;
      closing = app.dispose();
      let oldClosed = false;
      await store.setDraft('Obsolete write').catch(error => { oldClosed = /closed/.test(error.message); });
      await new Promise(resolve => setTimeout(resolve, 1700));
      const heldState = { acquisitions, oldClosed, viewId: sessionStorage.getItem('agentui.viewId'),
        locks: (await navigator.locks.query()).held.map(lock => lock.name) };
      held = false;
      await Promise.all([writing, closing, restarted]);
      const state = app.getSnapshot();
      const restored = { viewId: state.active?.viewId, route: state.saved.route, draft: state.active?.store.getSnapshot().draft,
        acquisitions, error: state.error, storageFailure: state.storageFailure };
      unsubscribe();
      await app.dispose();
      return { viewId, scope, heldState, restored, remainingLocks: (await navigator.locks.query()).held.map(lock => lock.name) };
    } finally {
      held = false; armed = false; unsubscribe?.(); IDBObjectStore.prototype.put = put;
      await Promise.allSettled([writing, closing, restarted]); await app.dispose();
    }
  });
  assert.equal(result.heldState.acquisitions, 1);
  assert.equal(result.heldState.oldClosed, true);
  assert.equal(result.heldState.viewId, result.viewId);
  assert.deepEqual(result.heldState.locks, [`agentui-view:${result.viewId}`]);
  assert.deepEqual(result.restored, { viewId: result.viewId, route: result.scope, draft: 'Preserved through slow physical commit',
    acquisitions: 2, error: '', storageFailure: '' });
  assert.deepEqual(result.remainingLocks, []);
});
