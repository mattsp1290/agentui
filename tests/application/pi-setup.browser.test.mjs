import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { chromium } from 'playwright';

test('Pi setup guidance activates without exposing the key to chat and survives reconnect', { timeout: 30_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'agentui-pi-setup-browser-'));
  const capability = 'b'.repeat(64), apiKey = 'synthetic-pi-setup-browser-marker';
  const env = { ...process.env, AGENTUI_SETUP_CAPABILITY: capability };
  delete env.OPENCODE_GO_API_KEY;
  let child;
  const stop = async () => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, 'exit');
    child.kill('SIGTERM');
    const deadline = setTimeout(() => child.kill('SIGKILL'), 5000);
    try { assert.equal((await exited)[0], 0); } finally { clearTimeout(deadline); }
  };
  const browser = await chromium.launch();
  t.after(async () => { await browser.close(); await stop(); await rm(directory, { recursive: true, force: true }); });
  let logs = '';
  const start = async (port = 0) => {
    child = spawn(process.execPath, ['apps/host/dist/main.js', 'desktop', '--preferred', 'pi',
      '--workspace', directory, '--data-dir', join(directory, 'data'), '--port', String(port)], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stderr.on('data', data => { logs += data; });
    return new Promise((resolve, reject) => {
      let output = '';
      const deadline = setTimeout(() => reject(new Error('Pi setup host timed out')), 10000);
      child.once('error', error => { clearTimeout(deadline); reject(error); });
      child.once('exit', () => { clearTimeout(deadline); reject(new Error(`Pi setup host exited. ${logs}`)); });
      child.stdout.on('data', data => {
        output += data;
        if (output.includes('\n')) {
          clearTimeout(deadline);
          resolve(JSON.parse(output.split('\n')[0]));
        }
      });
    });
  };
  const { origin } = await start();
  const page = await browser.newPage();
  page.setDefaultTimeout(5000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${origin}/browser.html`);
  await page.getByRole('button', { name: 'Harness, Select harness', exact: true }).click();
  await page.getByRole('button', { name: 'Pi, set up OpenCode Go', exact: true }).click();
  const settings = page.getByRole('region', { name: 'Pi and OpenCode Go', exact: true });
  await settings.waitFor();
  assert.match(await settings.textContent(), /compatible Pi runtime/);
  assert.match(await settings.textContent(), /OpenCode Go/);
  assert.equal(await settings.getByRole('link', { name: 'Open secure Pi setup' }).getAttribute('href'), '/setup/pi');
  assert.equal(await page.locator('input[type=password]').count(), 0);
  const denied = await page.evaluate(async () => {
    const response = await fetch('/setup/pi', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ op: 'status' }) });
    return response.status;
  });
  assert.ok(denied === 400 || denied === 403);
  const configured = await fetch(`${origin}/setup/pi`, { method: 'POST', headers: {
    Authorization: `Bearer ${capability}`, 'Content-Type': 'application/json',
  }, body: JSON.stringify({ op: 'configure', apiKey }) });
  assert.equal(configured.status, 200, await configured.clone().text());
  assert.equal((await configured.json()).value.kind, 'ready');
  await page.getByRole('button', { name: 'Reconnect', exact: true }).click();
  await page.getByText('Pi is configured for GLM 5.3 through OpenCode Go.', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Chats', exact: true }).click();
  await page.getByRole('button', { name: 'New conversation', exact: true }).click();
  const message = page.getByRole('textbox', { name: 'Message', exact: true });
  await message.fill('Retain this draft across Pi setup and reconnect.');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Reconnect', exact: true }).click();
  await page.getByRole('button', { name: 'Chats', exact: true }).click();
  assert.equal(await message.inputValue(), 'Retain this draft across Pi setup and reconnect.');
  const storage = await page.evaluate(async () => {
    const values = [];
    for (const database of await indexedDB.databases()) {
      const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open(database.name);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      for (const name of db.objectStoreNames) {
        values.push(await new Promise((resolve, reject) => {
          const request = db.transaction(name).objectStore(name).getAll();
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        }));
      }
      db.close();
    }
    return JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage }, indexed: values });
  });
  assert.ok(!storage.includes(apiKey));
  assert.ok(!storage.includes(capability));
  assert.ok(!(await page.content()).includes(apiKey));
  await stop();
  await start(Number(new URL(origin).port));
  await page.reload();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  assert.doesNotMatch(await settings.textContent(), /Pi is configured for GLM/);
  const inspectFiles = async path => {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const file = join(path, entry.name);
      if (entry.isDirectory()) await inspectFiles(file);
      else if (entry.isFile()) assert.ok(!(await readFile(file)).includes(Buffer.from(apiKey)), `No key in ${entry.name}`);
    }
  };
  await stop();
  await inspectFiles(directory);
  assert.ok(!logs.includes(apiKey));
  assert.ok(!logs.includes(capability));
  assert.deepEqual(errors, []);
});
