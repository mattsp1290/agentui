import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConnection } from 'node:net';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('../../', import.meta.url));
const cli = join(root, 'apps/host/dist/main.js');
const wait = async (predicate, label) => {
  const deadline = Date.now() + 20_000;
  while (!await predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
};
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'agentui-browser-'));
  const browser = await chromium.launch();
  let child, stderr = '';
  const start = async (port = 0) => {
    child = spawn(process.execPath, [cli, 'browser-dev', '--data-dir', directory, '--port', String(port)], { cwd: root, stdio: 'pipe' });
    child.stderr.on('data', data => { stderr += data; });
    const info = await new Promise((resolve, reject) => {
      let output = '';
      const timer = setTimeout(() => reject(new Error(`Host start timed out: ${stderr}`)), 20_000);
      child.once('exit', () => { clearTimeout(timer); reject(new Error(`Host exited: ${stderr}`)); });
      child.stdout.on('data', data => {
        output += data;
        if (output.includes('\n')) { clearTimeout(timer); resolve(JSON.parse(output.split('\n')[0])); }
      });
    });
    return info;
  };
  const stop = async (signal = 'SIGTERM') => {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit'); child.kill(signal); await exited;
    }
  };
  t.after(async () => { await browser.close(); await stop(); await rm(directory, { recursive: true, force: true }); });
  const control = op => new Promise((resolve, reject) => {
    const socket = createConnection(join(directory, 'control.sock'));
    let output = '';
    socket.once('error', reject);
    socket.once('connect', () => socket.write(`${JSON.stringify(op)}\n`));
    socket.on('data', data => { output += data; });
    socket.once('end', () => { const result = JSON.parse(output); if (result.ok) resolve(result.value); else reject(new Error(result.error)); });
  });
  const info = await start();
  const page = async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    page.setDefaultTimeout(20_000);
    await page.goto(`${info.origin}/browser.html`);
    await page.getByLabel('Pairing code').fill((await control({ op: 'invite' })).code);
    await page.getByRole('button', { name: 'Pair host', exact: true }).click();
    await wait(() => page.getByRole('button', { name: 'New recorded conversation' }).isEnabled(), 'paired host');
    return page;
  };
  const entries = async () => {
    try { return (await readFile(join(directory, 'recorded.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  };
  return { ...info, directory, browser, page, control, entries, start, stop };
}
async function connected(page) { await page.getByRole('status').first().filter({ hasText: 'Conversation connected' }).waitFor(); }
async function draft(page, text) {
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill(text);
  await wait(() => page.evaluate(async expected => {
    const request = indexedDB.open('agentui-browser-views', 1);
    const db = await new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    const read = db.transaction('records').objectStore('records').getAll();
    const rows = await new Promise((resolve, reject) => { read.onsuccess = () => resolve(read.result); read.onerror = () => reject(read.error); });
    db.close();
    return rows.some(row => row.draft === expected);
  }, text), 'persisted draft');
}

test('built browser app pairs two views, streams, races approval and recovers original intents after restart', { timeout: 90_000 }, async t => {
  const host = await fixture(t);
  const alice = await host.page(), bob = await host.page();
  assert.equal(await alice.evaluate(() => document.cookie), '');
  await alice.getByRole('button', { name: 'New recorded conversation' }).click();
  await connected(alice);
  const conversation = await alice.locator('.scope-label').textContent();
  await bob.getByRole('button', { name: 'Reconnect', exact: true }).click();
  await bob.getByRole('button', { name: `Open conversation ${conversation}`, exact: true }).click();
  await connected(bob);
  await draft(alice, 'First recorded message');
  await draft(bob, 'Bob keeps this draft');
  const revisions = [];
  alice.on('response', async response => {
    if (response.url().endsWith('/api/v1')) {
      try {
        const value = (await response.json()).value;
        for (const event of value?.item?.events ?? []) if (event.event.kind === 'domain' && event.event.event.role === 'assistant') revisions.push(event.event.event.revision);
      } catch {}
    }
  });
  await alice.getByRole('button', { name: 'Send', exact: true }).click();
  await alice.getByRole('heading', { name: 'Approval required', exact: true }).waitFor();
  await bob.getByRole('heading', { name: 'Approval required', exact: true }).waitFor();
  assert.deepEqual(revisions.slice(0, 3), [1, 2, 3]);
  await Promise.all([alice.getByRole('button', { name: 'approve', exact: true }).click(), bob.getByRole('button', { name: 'decline', exact: true }).click()]);
  await wait(async () => (await host.entries()).length === 2, 'one decision winner');
  await wait(async () => await alice.getByRole('heading', { name: 'Approval required', exact: true }).count() === 0, 'decision closed');
  await wait(async () => await bob.getByRole('heading', { name: 'Approval required', exact: true }).count() === 0, 'decision closed on second view');
  assert.equal(await bob.getByRole('textbox', { name: 'Message', exact: true }).inputValue(), 'Bob keeps this draft');
  assert.equal((await host.entries()).length, 2);

  let commandId;
  let drop = true;
  await alice.route('**/api/v1', async route => {
    const body = route.request().postDataJSON();
    if (body.op === 'submit' && body.command.body.kind === 'send' && drop) {
      commandId = body.command.clientCommandId;
      await route.fetch();
      await route.abort('connectionfailed');
      return;
    }
    await route.continue();
  });
  await draft(alice, 'Accepted response will be lost');
  await alice.getByRole('button', { name: 'Send', exact: true }).click();
  await alice.getByRole('button', { name: 'Retry original command', exact: true }).waitFor();
  await wait(async () => (await host.entries()).length === 3, 'recorded acceptance before lost reply');
  await wait(() => alice.getByRole('button', { name: 'Retry original command', exact: true }).isEnabled(), 'failed submit completed');
  await draft(alice, 'A newer draft survives recovery');
  drop = false;
  await alice.reload();
  await connected(alice);
  assert.equal(await alice.getByRole('textbox', { name: 'Message', exact: true }).inputValue(), 'A newer draft survives recovery');
  assert.equal((await host.entries()).length, 3, 'reload does not dispatch');
  await alice.getByRole('button', { name: 'Retry original command', exact: true }).click();
  await wait(async () => await alice.getByRole('button', { name: 'Retry original command', exact: true }).count() === 0, 'outbox settled');
  assert.equal((await host.entries()).length, 3, 'same command does not repeat acceptance');
  assert.equal(await alice.getByRole('textbox', { name: 'Message', exact: true }).inputValue(), 'A newer draft survives recovery');
  assert.ok(commandId);

  const watches = [];
  alice.on('request', request => {
    if (request.url().endsWith('/api/v1')) { const value = request.postDataJSON(); if (value.op === 'watch') watches.push(value); }
  });
  await alice.context().setOffline(true);
  await alice.getByRole('status').first().filter({ hasText: /failed|disconnected/ }).waitFor();
  await alice.context().setOffline(false);
  await alice.getByRole('button', { name: 'Reconnect', exact: true }).click();
  await connected(alice);
  assert.equal(typeof watches.at(-1).after, 'number', 'ordinary interruption replays from applied cursor');
  await alice.reload();
  await connected(alice);
  assert.equal(watches.at(-1).after, null, 'cold reload requests snapshot');
  await alice.getByRole('button', { name: 'Restore default view', exact: true }).click();
  assert.equal(await alice.getByRole('textbox', { name: 'Message', exact: true }).inputValue(), 'A newer draft survives recovery');
  const beforeRestart = (await host.entries()).length;
  await host.stop('SIGKILL');
  const restarted = await host.start(Number(new URL(host.origin).port));
  assert.equal(restarted.hostId, host.hostId);
  await alice.reload();
  await connected(alice);
  assert.equal(await alice.locator('.scope-label').textContent(), conversation);
  assert.equal((await host.entries()).length, beforeRestart);
  await bob.reload();
  await connected(bob);
  assert.equal(await bob.getByRole('textbox', { name: 'Message', exact: true }).inputValue(), 'Bob keeps this draft');
  if (process.env.AGENTUI_SCREENSHOT) await alice.screenshot({ path: process.env.AGENTUI_SCREENSHOT, fullPage: true });
});

test('duplicate tabs acquire separate writable views and uncertain creation is explicit', { timeout: 60_000 }, async t => {
  const host = await fixture(t), page = await host.page();
  let originalScope;
  await page.route('**/api/v1', async route => {
    const request = route.request().postDataJSON();
    if (request.op === 'create') { originalScope = request.scope; await route.fetch(); await route.abort('connectionfailed'); }
    else await route.continue();
  });
  await page.getByRole('button', { name: 'New recorded conversation' }).click();
  await page.getByRole('button', { name: 'Recover creation' }).waitFor();
  await wait(() => page.getByRole('button', { name: 'Recover creation' }).isEnabled(), 'uncertain creation');
  await page.unroute('**/api/v1');
  await page.reload();
  await page.getByRole('button', { name: 'Recover creation' }).waitFor();
  assert.equal(await page.getByRole('textbox', { name: 'Message', exact: true }).count(), 0, 'reload does not create or open pending intent');
  await page.getByRole('button', { name: 'Recover creation' }).click();
  await connected(page);
  assert.equal(await page.locator('.scope-label').textContent(), originalScope.conversationId);
  await draft(page, 'Original tab draft');
  const viewId = await page.evaluate(() => sessionStorage.getItem('agentui.viewId'));
  const popupPromise = page.waitForEvent('popup');
  await page.evaluate(() => window.open('/browser.html', '_blank'));
  const duplicate = await popupPromise;
  await duplicate.getByRole('button', { name: 'New recorded conversation' }).waitFor();
  await wait(async () => await duplicate.evaluate(() => sessionStorage.getItem('agentui.viewId')) !== viewId, 'exclusive duplicate view');
  await duplicate.getByRole('button', { name: `Open conversation ${originalScope.conversationId}`, exact: true }).click();
  await connected(duplicate);
  assert.equal(await duplicate.getByRole('textbox', { name: 'Message', exact: true }).inputValue(), '');
  await draft(duplicate, 'Duplicate tab draft');
  assert.equal(await page.getByRole('textbox', { name: 'Message', exact: true }).inputValue(), 'Original tab draft');
  await duplicate.getByRole('button', { name: `Reopen saved view ${viewId}`, exact: true }).click();
  await duplicate.getByRole('alert').filter({ hasText: 'already open in another tab' }).waitFor();
  assert.equal(await duplicate.getByRole('textbox', { name: 'Message', exact: true }).inputValue(), 'Duplicate tab draft');
  const context = page.context();
  await page.close();
  const reopened = await context.newPage();
  await reopened.goto(`${host.origin}/browser.html`);
  await reopened.getByRole('button', { name: `Reopen saved view ${viewId}`, exact: true }).click();
  await connected(reopened);
  assert.equal(await reopened.getByRole('textbox', { name: 'Message', exact: true }).inputValue(), 'Original tab draft');
  assert.equal(await reopened.evaluate(() => sessionStorage.getItem('agentui.viewId')), viewId);
});

test('custom content failure keeps host controls and restores the same connected store', { timeout: 45_000 }, async t => {
  const host = await fixture(t), page = await host.page();
  const fixtureBundle = await build({ stdin: { contents: `import React from 'react'; import {createRoot} from 'react-dom/client';
    import {BrowserApplication} from './apps/desktop/src/shell/BrowserApplication.tsx';
    function Broken(){throw new Error('Custom content failed');}
    createRoot(document.getElementById('root')).render(<BrowserApplication><Broken /></BrowserApplication>);`,
    resolveDir: root, loader: 'jsx' }, bundle: true, write: false, outfile: 'fixture.js', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' } });
  const script = fixtureBundle.outputFiles.find(file => file.path.endsWith('.js')).contents;
  await page.route('**/crash.html', route => route.fulfill({ contentType: 'text/html', body: '<div id="root"></div><script src="/crash.js"></script>' }));
  await page.route('**/crash.js', route => route.fulfill({ contentType: 'text/javascript', body: Buffer.from(script) }));
  let watches = 0;
  page.on('request', request => { if (request.url().endsWith('/api/v1') && request.postDataJSON().op === 'watch') watches++; });
  await page.goto(`${host.origin}/crash.html`);
  await page.getByText('This view could not load.', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'New recorded conversation' }).click();
  await connected(page);
  const before = watches;
  await page.getByRole('button', { name: 'Restore default view', exact: true }).click();
  await page.getByRole('heading', { name: 'Your conversation', exact: true }).waitFor();
  assert.equal(watches, before, 'restore does not reconstruct the store');
  await draft(page, 'Draft survives restored content');
  await page.getByRole('button', { name: 'Restore default view', exact: true }).click();
  assert.equal(await page.getByRole('textbox', { name: 'Message', exact: true }).inputValue(), 'Draft survives restored content');
  assert.equal(watches, before);
});

test('explicit reconciliation recovers a crashed host and revocation blocks the open browser', { timeout: 45_000 }, async t => {
  const host = await fixture(t), page = await host.page();
  await page.getByRole('button', { name: 'New recorded conversation' }).click();
  await connected(page);
  await draft(page, 'Recover this recorded result');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await wait(async () => (await host.entries()).length === 1, 'durable external acceptance');
  await host.stop('SIGKILL');
  await host.start(Number(new URL(host.origin).port));
  await page.reload();
  await connected(page);
  await page.getByRole('button', { name: 'Reconcile command', exact: true }).waitFor();
  assert.equal((await host.entries()).length, 1);
  await draft(page, 'Newer draft before reconciliation');
  await page.getByRole('button', { name: 'Reconcile command', exact: true }).click();
  await page.getByRole('heading', { name: 'Approval required', exact: true }).waitFor();
  await wait(async () => await page.getByRole('button', { name: 'Retry original command', exact: true }).count() === 0, 'reconciled outbox cleared without submission');
  assert.equal((await host.entries()).length, 1, 'reconciliation does not repeat the effect');
  assert.equal(await page.getByRole('textbox', { name: 'Message', exact: true }).inputValue(), 'Newer draft before reconciliation');
  const principalId = await page.evaluate(async () => (await (await fetch('/api/v1', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ op: 'metadata' }) })).json()).value.principalId);
  await host.control({ op: 'revoke', id: principalId });
  await page.getByLabel('Pairing code').waitFor();
  assert.equal(await page.getByRole('button', { name: 'Send', exact: true }).isEnabled(), false);
  assert.equal(await page.getByRole('button', { name: 'approve', exact: true }).isEnabled(), false);
  assert.equal((await host.entries()).length, 1);
});

test('incompatible metadata and unsupported draft storage block commands without discarding saved records', { timeout: 45_000 }, async t => {
  const host = await fixture(t), page = await host.page();
  await page.getByRole('button', { name: 'New recorded conversation' }).click();
  await connected(page);
  await draft(page, 'Do not discard this draft');
  let submits = 0;
  page.on('request', request => { if (request.url().endsWith('/api/v1') && request.postDataJSON().op === 'submit') submits++; });
  await page.route('**/api/v1', async route => {
    if (route.request().postDataJSON().op === 'metadata') {
      const response = await route.fetch(), body = await response.json();
      body.value.compatibility.wireVersion = 2;
      await route.fulfill({ response, json: body });
    } else await route.continue();
  });
  await page.reload();
  await page.getByRole('alert').filter({ hasText: 'This host is incompatible' }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'New recorded conversation' }).isEnabled(), false);
  assert.equal(submits, 0);
  await page.unroute('**/api/v1');
  await page.reload();
  await connected(page);
  assert.equal(await page.getByRole('textbox', { name: 'Message', exact: true }).inputValue(), 'Do not discard this draft');
  await page.evaluate(async () => {
    const open = indexedDB.open('agentui-browser-views', 1);
    const db = await new Promise((resolve, reject) => { open.onsuccess = () => resolve(open.result); open.onerror = () => reject(open.error); });
    const transaction = db.transaction('records', 'readwrite'), store = transaction.objectStore('records');
    const cursor = store.openCursor();
    cursor.onsuccess = () => {
      if (!cursor.result) return;
      if (cursor.result.value.draft === 'Do not discard this draft') cursor.result.update({ ...cursor.result.value, version: 2 });
      cursor.result.continue();
    };
    await new Promise((resolve, reject) => { transaction.oncomplete = resolve; transaction.onerror = () => reject(transaction.error); });
    db.close();
  });
  await page.reload();
  await page.getByRole('alert').filter({ hasText: 'Local storage unavailable. Commands are blocked.' }).waitFor();
  await page.getByText('Unsupported local storage version', { exact: true }).first().waitFor();
  assert.equal(await page.getByRole('button', { name: 'New recorded conversation' }).isEnabled(), false);
  assert.equal(submits, 0);
  assert.deepEqual(await host.entries(), []);
});

test('browser catalog reads every page and opens a conversation beyond the first hundred', { timeout: 45_000 }, async t => {
  const host = await fixture(t), page = await host.page();
  await page.evaluate(async hostId => {
    for (let index = 0; index < 105; index++) {
      const response = await fetch('/api/v1', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ op: 'create', scope: { hostId, conversationId: `catalog-${String(index).padStart(3, '0')}` } }) });
      if (!response.ok) throw new Error('Catalog setup failed');
    }
  }, host.hostId);
  await page.getByRole('button', { name: 'Reconnect', exact: true }).click();
  const catalog = page.getByRole('navigation', { name: 'Host conversations', exact: true });
  await wait(async () => await catalog.getByRole('button').count() === 105, 'complete paginated catalog');
  await catalog.getByRole('button', { name: 'Open conversation catalog-104', exact: true }).click();
  await connected(page);
  assert.equal(await page.locator('.scope-label').textContent(), 'catalog-104');
});
