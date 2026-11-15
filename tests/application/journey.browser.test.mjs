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
import { preview } from 'vite';
import { repository, buildCustom } from '../customization/build/support.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const cli = join(root, 'apps/host/dist/main.js');
const wait = async (predicate, label) => {
  const deadline = Date.now() + 20_000;
  while (!await predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
};
async function fixture(t, assets) {
  const directory = await mkdtemp(join(tmpdir(), 'agentui-browser-'));
  const browser = await chromium.launch();
  let child, stderr = '';
  const start = async (port = 0) => {
    child = spawn(process.execPath, [cli, 'browser-dev', '--data-dir', directory, '--port', String(port), ...(assets ? ['--assets', assets] : [])], { cwd: root, stdio: 'pipe' });
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
async function connected(page) { await page.getByRole('status').filter({ hasText: 'Conversation connected' }).first().waitFor(); }
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

async function revealRecovery(page) {
  const settings = page.getByRole('button', { name: 'Settings', exact: true });
  if (await settings.count()) await settings.click();
  const menu = page.locator('.recovery-menu');
  if (await menu.getAttribute('open') === null) await menu.locator('summary').click();
}

test('desktop connection action opens the paired host app and keeps conversations on return', { timeout: 45_000 }, async t => {
  const host = await fixture(t);
  const desktop = join(root, 'apps/desktop');
  const config = JSON.parse(await readFile(join(desktop, 'src-tauri/tauri.conf.json'), 'utf8'));
  const server = await preview({
    root: desktop, configFile: join(desktop, 'vite.config.mjs'),
    preview: { host: '127.0.0.1', port: 0, headers: { 'Content-Security-Policy': config.app.security.csp } },
  });
  t.after(() => server.close());
  const page = await host.browser.newPage();
  page.setDefaultTimeout(5000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  let navigations = 0;
  await page.route('http://127.0.0.1:7140/**', async route => {
    assert.equal(route.request().url(), 'http://127.0.0.1:7140/browser.html');
    assert.equal(route.request().isNavigationRequest(), true);
    navigations++;
    await route.fulfill({ status: 307, headers: { location: `${host.origin}/browser.html` } });
  });
  const landing = `http://127.0.0.1:${server.httpServer.address().port}`;
  const connect = async () => {
    await page.goto(landing);
    await page.getByRole('button', { name: 'Connect to local Codex', exact: true }).click();
    await page.waitForURL(`${host.origin}/browser.html`);
  };
  await connect();
  await page.getByLabel('Pairing code').fill((await host.control({ op: 'invite' })).code);
  await page.getByRole('button', { name: 'Pair host', exact: true }).click();
  await wait(() => page.getByRole('button', { name: 'New recorded conversation' }).isEnabled(), 'paired host');
  await page.getByRole('button', { name: 'New recorded conversation' }).click();
  await connected(page);
  const conversation = await page.locator('.scope-label').textContent();
  await draft(page, 'Keep this private draft');
  await connect();
  await connected(page);
  assert.equal(await page.getByLabel('Pairing code').count(), 0);
  assert.equal(await page.locator('.scope-label').textContent(), conversation);
  assert.equal(await page.getByRole('textbox', { name: 'Message', exact: true }).inputValue(), 'Keep this private draft');
  await revealRecovery(page);
  await page.getByRole('button', { name: 'Restore default view' }).click();
  await connected(page);
  await revealRecovery(page);
  await Promise.all([page.waitForEvent('load'), page.getByRole('button', { name: 'Reload app' }).click()]);
  await connected(page);
  assert.equal(await page.locator('.scope-label').textContent(), conversation);
  assert.equal(navigations, 2);
  assert.deepEqual(errors, []);
});

test('built browser app pairs two views, streams, races approval and recovers original intents after restart', { timeout: 90_000 }, async t => {
  const host = await fixture(t);
  const alice = await host.page(), bob = await host.page();
  assert.equal(await alice.evaluate(() => document.cookie), '');
  await alice.getByRole('button', { name: 'New recorded conversation' }).click();
  await connected(alice);
  const conversation = await alice.locator('.scope-label').textContent();
  await bob.getByRole('button', { name: 'Settings', exact: true }).click();
  await bob.getByRole('button', { name: 'Reconnect', exact: true }).click();
  await bob.getByRole('button', { name: 'Chats', exact: true }).click();
  await bob.getByRole('button', { name: new RegExp(`Open conversation ${conversation}$`) }).click();
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
  const approvalLayout = await alice.locator('.decision-card p').evaluate(node => {
    const original = node.textContent;
    node.textContent = `Run:\nprintf first\nprintf second\n${'long-file-name'.repeat(100)}`;
    const text = node.firstChild;
    const lineTop = content => {
      const start = text.textContent.indexOf(content);
      const range = document.createRange();
      range.setStart(text, start); range.setEnd(text, start + content.length);
      return range.getBoundingClientRect().top;
    };
    const result = { first: lineTop('printf first'), second: lineTop('printf second'), fits: node.scrollWidth <= node.clientWidth };
    node.textContent = original;
    return result;
  });
  assert.ok(approvalLayout.second > approvalLayout.first, 'approval commands retain separate visible lines');
  assert.equal(approvalLayout.fits, true, 'long approval paths fit within the card');
  await alice.setViewportSize({ width: 360, height: 480 });
  await alice.getByRole('button', { name: 'Send', exact: true }).scrollIntoViewIfNeeded();
  const composerBounds = await alice.locator('.composer button').boundingBox();
  const mainBounds = await alice.locator('main').boundingBox();
  assert.ok(composerBounds.y + composerBounds.height <= mainBounds.y + mainBounds.height,
    'composer remains reachable with an approval at minimum window size');
  await alice.setViewportSize({ width: 1280, height: 720 });
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
  await alice.getByRole('button', { name: 'Settings', exact: true }).click();
  await alice.getByRole('button', { name: 'Reconnect', exact: true }).click();
  await alice.getByRole('button', { name: 'Chats', exact: true }).click();
  await connected(alice);
  assert.equal(typeof watches.at(-1).after, 'number', 'ordinary interruption replays from applied cursor');
  await alice.reload();
  await connected(alice);
  assert.equal(watches.at(-1).after, null, 'cold reload requests snapshot');
  await revealRecovery(alice);
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
  await duplicate.getByRole('button', { name: new RegExp(`Open conversation ${originalScope.conversationId}$`) }).click();
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
  await revealRecovery(page);
  await page.getByRole('button', { name: 'Restore default view', exact: true }).click();
  await page.getByRole('heading', { name: 'Your conversation', exact: true }).waitFor();
  assert.equal(watches, before, 'restore does not reconstruct the store');
  await draft(page, 'Draft survives restored content');
  await revealRecovery(page);
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

test('saved chat labels follow first prompts through new chats, reopening and reload with separate drafts', { timeout: 60_000 }, async t => {
  const host = await fixture(t), page = await host.page();
  const catalog = page.getByRole('navigation', { name: 'Host conversations', exact: true });
  const create = async () => {
    const previous = await page.locator('.scope-label').count() ? await page.locator('.scope-label').textContent() : null;
    await page.getByRole('button', { name: 'New recorded conversation', exact: true }).click();
    await wait(async () => await page.locator('.scope-label').count() > 0 && await page.locator('.scope-label').textContent() !== previous, 'new chat opens');
    await connected(page);
    return page.locator('.scope-label').textContent();
  };
  const first = await create();
  const firstPrompt = 'Plan a balcony garden with herbs';
  const firstButton = catalog.getByRole('button', { name: new RegExp(`Open conversation ${first}$`) });
  const emptyLabel = await firstButton.textContent();
  await page.reload();
  await connected(page);
  assert.equal(await firstButton.textContent(), emptyLabel);
  await draft(page, firstPrompt);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await wait(async () => await firstButton.textContent() === firstPrompt, 'first prompt becomes the label without reload');
  await page.getByRole('heading', { name: 'Approval required', exact: true }).waitFor();
  await draft(page, 'Garden draft stays here');

  const second = await create();
  const secondPrompt = `Write a travel checklist\n\n${'packing essentials '.repeat(20)}`;
  const secondButton = catalog.getByRole('button', { name: new RegExp(`Open conversation ${second}$`) });
  await draft(page, secondPrompt);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await wait(async () => (await secondButton.textContent()).startsWith('Write a travel checklist packing essentials'), 'second prompt becomes a readable label');
  const boundedLabel = await secondButton.textContent();
  assert.ok(boundedLabel.length <= 80);
  assert.equal(boundedLabel.includes('\n'), false);
  assert.equal(boundedLabel.endsWith('…'), true);
  await page.getByRole('heading', { name: 'Approval required', exact: true }).waitFor();
  await draft(page, 'Travel draft stays here');

  const third = await create();
  const thirdButton = catalog.getByRole('button', { name: new RegExp(`Open conversation ${third}$`) });
  const thirdLabel = await thirdButton.textContent();
  assert.equal(await firstButton.textContent(), firstPrompt);
  assert.equal(await secondButton.textContent(), boundedLabel);
  await page.reload();
  await connected(page);
  assert.equal(await thirdButton.textContent(), thirdLabel);
  assert.equal(await firstButton.textContent(), firstPrompt);
  assert.equal(await secondButton.textContent(), boundedLabel);
  for (const [button, id, prompt, savedDraft] of [
    [firstButton, first, firstPrompt, 'Garden draft stays here'],
    [secondButton, second, secondPrompt, 'Travel draft stays here'],
  ]) {
    await button.click();
    await wait(async () => await page.locator('.scope-label').textContent() === id, 'selected chat opens');
    await connected(page);
    assert.equal(await page.locator('.scope-label').textContent(), id);
    assert.equal(await page.locator('.message-user p').first().textContent(), prompt);
    assert.equal(await page.getByRole('textbox', { name: 'Message', exact: true }).inputValue(), savedDraft);
  }
});

test('saved chat search finds old message text, selects with keys and preserves active recovery state', { timeout: 60_000 }, async t => {
  const host = await fixture(t), page = await host.page();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.evaluate(async hostId => {
    const call = async body => {
      const response = await fetch('/api/v1', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (!response.ok) throw new Error('Search setup failed');
    };
    for (let index = 0; index < 105; index++) await call({ op: 'create', scope: { hostId, conversationId: `search-${String(index).padStart(3, '0')}` } });
    for (const [id, text] of [
      ['search-103', `Search project alpha ${'planning '.repeat(25)}Lavender treasure`],
      ['search-104', 'Search project beta'],
    ]) await call({ op: 'submit', command: { version: 1, scope: { hostId, conversationId: id }, clientCommandId: `seed-${id}`, body: { kind: 'send', text } } });
  }, host.hostId);
  await page.getByRole('button', { name: 'New recorded conversation' }).click();
  await connected(page);
  const original = await page.locator('.scope-label').textContent();
  let drop = true, failSearch = true;
  const oldEntered = Promise.withResolvers(), oldReply = Promise.withResolvers();
  const oldFinished = Promise.withResolvers();
  const searched = [];
  await page.route('**/api/v1', async route => {
    const request = route.request().postDataJSON();
    if (drop && request.op === 'submit') { drop = false; await route.fetch(); await route.abort('connectionfailed'); return; }
    if (request.op === 'search') {
      searched.push(request);
      if (request.query === 'delayed lavender' && request.after === null) {
        const response = await route.fetch(); oldEntered.resolve(); await oldReply.promise;
        await route.fulfill({ response }); oldFinished.resolve(); return;
      }
      if (request.query === 'unavailable query' && failSearch) {
        await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ ok: false, error: { kind: 'unavailable', message: 'Search temporarily unavailable' } }) }); return;
      }
    }
    await route.continue();
  });
  await draft(page, 'Recover this original command');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await wait(() => page.getByRole('button', { name: 'Retry original command', exact: true }).isEnabled(), 'original command retained');
  await draft(page, 'My active unsent draft');
  const editor = await page.getByRole('textbox', { name: 'Message', exact: true }).elementHandle();
  const recovery = await page.getByRole('region', { name: 'Command recovery' }).textContent();
  const query = page.getByRole('combobox', { name: 'Search chats', exact: true });
  const results = page.getByRole('listbox', { name: 'Search results' });
  const unchanged = async () => {
    assert.equal(await page.locator('.scope-label').textContent(), original);
    assert.equal(await page.getByRole('textbox', { name: 'Message', exact: true }).inputValue(), 'My active unsent draft');
    assert.equal(await page.getByRole('textbox', { name: 'Message', exact: true }).evaluate((node, old) => node === old, editor), true);
    assert.equal(await page.getByRole('region', { name: 'Command recovery' }).textContent(), recovery);
    assert.equal(await page.getByRole('button', { name: 'Retry original command', exact: true }).isEnabled(), true);
  };
  await query.fill('LAVENDER');
  await page.getByRole('status').filter({ hasText: '1 matching chat.' }).waitFor();
  assert.match(await results.getByRole('option').textContent(), /Lavender treasure/);
  assert.ok(searched.some(request => request.query === 'LAVENDER' && request.after !== null), 'search scans beyond the first hundred chats');
  await unchanged();
  await query.fill('recorded response complete');
  await page.getByRole('status').filter({ hasText: '3 matching chats.' }).waitFor();
  await unchanged();
  await query.fill('not present anywhere');
  await page.getByText('No matching chats.', { exact: true }).waitFor();
  await unchanged();
  await query.fill('delayed lavender'); await oldEntered.promise;
  await query.fill('beta');
  await page.getByRole('status').filter({ hasText: '1 matching chat.' }).waitFor();
  oldReply.resolve(); await oldFinished.promise;
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.match(await results.getByRole('option').textContent(), /Search project beta/);
  await query.fill(' beta ');
  await page.getByRole('status').filter({ hasText: '1 matching chat.' }).waitFor();
  assert.match(await results.getByRole('option').textContent(), /Search project beta/);
  assert.equal(searched.filter(request => request.query === 'delayed lavender').length, 1, 'stale search does not fetch another page');
  await query.fill('unavailable query');
  await page.getByRole('alert').filter({ hasText: 'Search temporarily unavailable' }).waitFor();
  await unchanged();
  failSearch = false;
  await page.getByRole('button', { name: 'Retry search' }).click();
  await page.getByText('No matching chats.', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Clear search' }).click();
  await unchanged();
  await query.fill('Search project');
  await page.getByRole('status').filter({ hasText: '2 matching chats.' }).waitFor();
  await query.press('ArrowDown'); await query.press('ArrowDown'); await query.press('ArrowUp'); await query.press('Enter');
  await wait(async () => await page.locator('.scope-label').textContent() === 'search-103', 'keyboard result selected');
  await connected(page);
  await query.press('Escape');
  const catalog = page.getByRole('navigation', { name: 'Host conversations', exact: true });
  await catalog.getByRole('button', { name: new RegExp(`Open conversation ${original}$`) }).click();
  await wait(async () => await page.locator('.scope-label').textContent() === original, 'original chat restored');
  await connected(page);
  assert.equal(await page.getByRole('textbox', { name: 'Message', exact: true }).inputValue(), 'My active unsent draft');
  await query.fill('Search project');
  await page.getByRole('status').filter({ hasText: '2 matching chats.' }).waitFor();
  await page.reload(); await connected(page);
  assert.equal(await query.inputValue(), '');
  assert.equal(await page.locator('.scope-label').textContent(), original);
  assert.equal(await page.getByRole('textbox', { name: 'Message', exact: true }).inputValue(), 'My active unsent draft');
  await page.getByRole('button', { name: 'Retry original command', exact: true }).waitFor();
  assert.deepEqual(errors, []);
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
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Reconnect', exact: true }).click();
  await page.getByRole('button', { name: 'Chats', exact: true }).click();
  const catalog = page.getByRole('navigation', { name: 'Host conversations', exact: true });
  await wait(async () => await catalog.getByRole('button').count() === 101, 'first bounded catalog page');
  await catalog.getByRole('button', { name: 'More conversations', exact: true }).click();
  await wait(async () => await catalog.getByRole('button').count() === 105, 'complete paginated catalog');
  await catalog.getByRole('button', { name: /Open conversation catalog-104$/ }).click();
  await connected(page);
  assert.equal(await page.locator('.scope-label').textContent(), 'catalog-104');
});

test('an unreadable foreign saved view leaves the current conversation and draft usable', { timeout: 30000 }, async t => {
  const host = await fixture(t), page = await host.page();
  await page.getByRole('button', { name: 'New recorded conversation' }).click();
  await connected(page);
  const conversation = await page.locator('.scope-label').textContent();
  await draft(page, 'My own draft survives another view’s bad record');
  await page.evaluate(async hostId => {
    const request = indexedDB.open('agentui-browser-views', 1);
    const db = await new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    const transaction = db.transaction('records', 'readwrite');
    transaction.objectStore('records').put({ version: 2, route: null, pendingCreation: null }, ['view', 'unreadable-other-view', hostId]);
    await new Promise((resolve, reject) => { transaction.oncomplete = resolve; transaction.onerror = () => reject(transaction.error); });
    db.close();
  }, host.hostId);
  await page.reload();
  await connected(page);
  await page.getByRole('note').filter({ hasText: 'records were left untouched' }).waitFor();
  assert.equal(await page.locator('.scope-label').textContent(), conversation);
  assert.equal(await page.getByRole('textbox', { name: 'Message', exact: true }).inputValue(), 'My own draft survives another view’s bad record');
  assert.equal(await page.getByRole('button', { name: 'Send', exact: true }).isEnabled(), true);
  assert.deepEqual(await host.entries(), []);
});


test('committed custom artifact sends one exact prompt, retains drafts and restores the healthy composer', { timeout: 90_000 }, async t => {
  const custom = repository();
  t.after(() => rm(custom.directory, { recursive: true, force: true }));
  const commit = custom.commit();
  custom.write('shared/prompts.ts', "export const reviewPrompt = 'DIRTY PROMPT';");
  buildCustom(custom, commit);
  const host = await fixture(t, join(custom.directory, 'browser')), page = await host.page();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const prompt = 'Review our current plan. Identify the next useful step and any unresolved decision.';
  let submissions = 0;
  page.on('request', request => {
    if (request.url().endsWith('/api/v1') && request.postDataJSON().op === 'submit') submissions++;
  });
  const send = async text => {
    const previous = await page.locator('.scope-label').count() ? await page.locator('.scope-label').textContent() : null;
    await page.getByRole('button', { name: 'New recorded conversation' }).click();
    await wait(async () => await page.locator('.scope-label').count() > 0 && await page.locator('.scope-label').textContent() !== previous, 'new custom conversation opens');
    await connected(page);
    await draft(page, text);
    const review = page.getByRole('button', { name: 'Review the plan', exact: true });
    await wait(() => review.isEnabled(), 'custom review ready');
    const before = submissions;
    await review.evaluate(button => { button.click(); button.click(); });
    await page.getByRole('status').filter({ hasText: /Review (request sent|pending)\./ }).waitFor();
    await page.locator('.message-user p').filter({ hasText: prompt }).waitFor();
    assert.equal(submissions, before + 1);
    assert.equal(await page.getByRole('textbox', { name: 'Message', exact: true }).inputValue(), text);
    await page.getByRole('heading', { name: 'Approval required', exact: true }).waitFor();
    return page.locator('.scope-label').textContent();
  };
  const first = await send(prompt);
  const second = await send('A different draft');
  await page.getByRole('button', { name: new RegExp(`Open conversation ${first}$`) }).click();
  await wait(async () => await page.locator('.scope-label').textContent() === first, 'first custom conversation selected');
  await connected(page);
  assert.equal(await page.getByRole('textbox', { name: 'Message', exact: true }).inputValue(), prompt);
  await page.getByRole('button', { name: new RegExp(`Open conversation ${second}$`) }).click();
  await wait(async () => await page.locator('.scope-label').textContent() === second, 'second custom conversation selected');
  await connected(page);
  await page.reload();
  await connected(page);
  await page.getByRole('heading', { name: 'Plan review', exact: true }).waitFor();
  assert.equal(await page.getByRole('textbox', { name: 'Message', exact: true }).inputValue(), 'A different draft');
  const customEditor = await page.getByRole('textbox', { name: 'Message', exact: true }).elementHandle();
  const search = page.getByRole('combobox', { name: 'Search chats', exact: true });
  await search.fill('unmatched custom search');
  await page.getByText('No matching chats.', { exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Review the plan', exact: true }).isEnabled(), true);
  assert.equal(await page.getByRole('textbox', { name: 'Message', exact: true }).evaluate((node, old) => node === old, customEditor), true);
  await search.fill('Review our current plan');
  await page.getByRole('status').filter({ hasText: '2 matching chats.' }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Review the plan', exact: true }).isEnabled(), true);
  await page.getByRole('button', { name: 'Clear search' }).click();
  await page.setViewportSize({ width: 360, height: 480 });
  await page.getByRole('button', { name: 'Review the plan', exact: true }).scrollIntoViewIfNeeded();
  await page.getByRole('button', { name: 'approve', exact: true }).scrollIntoViewIfNeeded();
  assert.equal(await page.getByRole('button', { name: 'approve', exact: true }).isEnabled(), true);
  await page.getByRole('button', { name: 'Send', exact: true }).scrollIntoViewIfNeeded();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'no horizontal overflow at minimum size');
  if (process.env.AGENTUI_CUSTOM_SCREENSHOT) await page.screenshot({ path: process.env.AGENTUI_CUSTOM_SCREENSHOT, fullPage: true });
  const editor = await page.getByRole('textbox', { name: 'Message', exact: true }).elementHandle();
  await revealRecovery(page);
  await page.getByRole('button', { name: 'Restore default view', exact: true }).click();
  assert.equal(await page.getByRole('heading', { name: 'Plan review', exact: true }).count(), 0);
  assert.equal(await page.getByRole('textbox', { name: 'Message', exact: true }).evaluate((node, old) => node === old, editor), true);
  assert.equal(await page.getByRole('textbox', { name: 'Message', exact: true }).inputValue(), 'A different draft');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page.locator('.message-user p').filter({ hasText: 'A different draft' }).waitFor();
  assert.equal(submissions, 3);
  assert.deepEqual(errors, []);
});

async function customRuntime(page, host, selection, breakDefault = false) {
  const bundled = await build({ stdin: { contents: `import React from 'react'; import {createRoot} from 'react-dom/client';
    import {BrowserApplication} from './apps/desktop/src/shell/BrowserApplication.tsx';
    createRoot(document.getElementById('root')).render(<BrowserApplication />);`, resolveDir: root, loader: 'jsx' },
    bundle: true, write: false, outfile: 'custom.js', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' },
    plugins: [{ name: 'custom-runtime-fixture', setup(plugin) {
      if (breakDefault) plugin.onLoad({ filter: /ConversationView\.tsx$/ }, async () => ({
        contents: `import { createElement } from 'react';\n` +
          (await readFile(join(root, 'apps/desktop/src/application/ConversationView.tsx'), 'utf8')).replace('export function ConversationView(', 'function HealthyConversationView(') +
          `\nexport function ConversationView(props) { if (window.failDefault) throw new Error('Default view failed'); return createElement(HealthyConversationView, props); }`, loader: 'tsx' }));
      plugin.onLoad({ filter: /customization-selection\.ts$/ }, () => ({ contents: `import * as React from 'react';
        const manifest = { namespace: 'fixture', trust: 'full', sdkVersion: '0.0.0', entries: [{ kind: 'desktop', module: './desktop.js' }] };
        export default { manifest, ${selection} };`, loader: 'tsx' }));
    } }] });
  await page.route('**/custom.html', route => route.fulfill({ contentType: 'text/html', body: '<div id="root"></div><script src="/custom.js"></script>' }));
  await page.route('**/custom.js', route => route.fulfill({ contentType: 'text/javascript', body: Buffer.from(bundled.outputFiles.find(file => file.path.endsWith('.js')).contents) }));
  await page.goto(`${host.origin}/custom.html`);
  if (!breakDefault) await connected(page);
}

for (const [label, body, disposed] of [
  ['import', "load: async () => { throw new Error('Import failed'); }", 0],
  ['activation', "load: async () => ({ default: { kind: 'desktop', sdkVersion: '0.0.0', activate() { throw new Error('Activation failed'); } } })", 0],
  ['compatibility', "load: async () => ({ default: { kind: 'desktop', sdkVersion: 'bad', activate() {} } })", 0],
  ['invalid contributions', "load: async () => ({ default: { kind: 'desktop', sdkVersion: '0.0.0', activate() { return { dispose() { window.disposals = (window.disposals || 0) + 1; }, modules: null }; } } })", 1],
  ['unsupported actions', "load: async () => ({ default: { kind: 'desktop', sdkVersion: '0.0.0', activate() { return { dispose() { window.disposals = (window.disposals || 0) + 1; }, modules: [{ id: 'x', label: 'X', component() { return null; }, actions: [] }] }; } } })", 1],
  ['render', "load: async () => ({ default: { kind: 'desktop', sdkVersion: '0.0.0', activate() { return { dispose() { window.disposals = (window.disposals || 0) + 1; }, modules: [{ id: 'x', label: 'X', component() { throw new Error('Render failed'); } }] }; } } })", 1],
]) test(`custom ${label} failure stays local and disposes its lifetime`, { timeout: 45_000 }, async t => {
  const host = await fixture(t), page = await host.page();
  await page.getByRole('button', { name: 'New recorded conversation' }).click();
  await connected(page);
  await customRuntime(page, host, body);
  await page.getByRole('alert').filter({ hasText: 'Custom tools could not load.' }).waitFor();
  await draft(page, 'Keep this composer');
  const editor = await page.getByRole('textbox', { name: 'Message', exact: true }).elementHandle();
  await revealRecovery(page);
  await page.getByRole('button', { name: 'Restore default view', exact: true }).click();
  assert.equal(await page.getByRole('textbox', { name: 'Message', exact: true }).evaluate((node, old) => node === old, editor), true);
  assert.equal(await page.evaluate(() => window.disposals || 0), disposed);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page.getByRole('heading', { name: 'Approval required', exact: true }).waitFor();
});

test('restoring during activation disposes a late lifetime once and catches cleanup rejection', { timeout: 45_000 }, async t => {
  const host = await fixture(t), page = await host.page();
  await page.getByRole('button', { name: 'New recorded conversation' }).click();
  await connected(page);
  await customRuntime(page, host, `load: async () => ({ default: { kind: 'desktop', sdkVersion: '0.0.0', activate() {
    return new Promise(resolve => { window.finishActivation = () => resolve({ modules: [], dispose() { window.disposals = (window.disposals || 0) + 1; return Promise.reject(new Error('Cleanup rejected')); } }); });
  } } })`);
  await wait(() => page.evaluate(() => typeof window.finishActivation === 'function'), 'pending activation');
  await draft(page, 'Late activation draft');
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await revealRecovery(page);
  await page.getByRole('button', { name: 'Restore default view', exact: true }).click();
  await page.evaluate(() => window.finishActivation());
  await wait(() => page.evaluate(() => window.disposals === 1), 'late disposal');
  assert.equal(await page.getByRole('textbox', { name: 'Message', exact: true }).inputValue(), 'Late activation draft');
  assert.deepEqual(errors, []);
});


test('activation survives navigation and healthy restore disposes once while keeping the composer', { timeout: 45_000 }, async t => {
  const host = await fixture(t), page = await host.page();
  await page.getByRole('button', { name: 'New recorded conversation' }).click();
  await connected(page);
  const first = await page.locator('.scope-label').textContent();
  await customRuntime(page, host, `load: async () => ({ default: { kind: 'desktop', sdkVersion: '0.0.0', activate() {
    window.activations = (window.activations || 0) + 1;
    return { modules: [{ id: 'working', label: 'Working', component({ conversation }) {
      const [count, setCount] = React.useState(0);
      return React.createElement('button', { onClick: () => setCount(count + 1) }, 'Custom count ' + count + ' ' + conversation.conversationId);
    } }], dispose() { window.disposals = (window.disposals || 0) + 1; } };
  } } })`);
  await page.getByRole('button', { name: `Custom count 0 ${first}`, exact: true }).click();
  await page.getByRole('button', { name: `Custom count 1 ${first}`, exact: true }).waitFor();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Chats', exact: true }).click();
  await page.getByRole('button', { name: `Custom count 1 ${first}`, exact: true }).waitFor();
  await page.getByRole('button', { name: 'New recorded conversation' }).click();
  await wait(async () => await page.locator('.scope-label').textContent() !== first, 'next conversation selected');
  const second = await page.locator('.scope-label').textContent();
  await page.getByRole('button', { name: `Custom count 0 ${second}`, exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.activations), 1);
  await draft(page, 'Healthy lifetime draft');
  await revealRecovery(page);
  await page.getByRole('button', { name: 'Restore default view', exact: true }).click();
  assert.equal(await page.evaluate(() => window.disposals), 1);
  assert.equal(await page.getByRole('textbox', { name: 'Message', exact: true }).inputValue(), 'Healthy lifetime draft');
});

test('managed restore retries a failed default conversation boundary', { timeout: 45_000 }, async t => {
  const host = await fixture(t), page = await host.page();
  await page.getByRole('button', { name: 'New recorded conversation' }).click();
  await connected(page);
  await draft(page, 'Recover the default composer');
  await page.addInitScript(() => { window.failDefault = true; });
  await customRuntime(page, host, 'load: async () => ({ default: {} })', true);
  await page.getByText('This view could not load.', { exact: true }).waitFor();
  await page.evaluate(() => { window.failDefault = false; });
  await revealRecovery(page);
  await page.getByRole('button', { name: 'Restore default view', exact: true }).click();
  await connected(page);
  assert.equal(await page.getByRole('textbox', { name: 'Message', exact: true }).inputValue(), 'Recover the default composer');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page.getByRole('heading', { name: 'Approval required', exact: true }).waitFor();
});
