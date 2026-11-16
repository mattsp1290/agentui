import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConnection } from 'node:net';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright';

export const root = fileURLToPath(new URL('../../', import.meta.url));
const cli = join(root, 'apps/host/dist/main.js');
export const wait = async (predicate, label) => {
  const deadline = Date.now() + 20_000;
  while (!await predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
};
export async function fixture(t, assets) {
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
export async function connected(page) { await page.getByRole('status').filter({ hasText: 'Conversation connected' }).first().waitFor(); }
export async function draft(page, text) {
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

export async function revealRecovery(page) {
  const settings = page.getByRole('button', { name: 'Settings', exact: true });
  if (await settings.count()) await settings.click();
  const menu = page.locator('.recovery-menu');
  if (await menu.getAttribute('open') === null) await menu.locator('summary').click();
}

export async function customRuntime(page, host, selection, breakDefault = false, extra = '') {
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
        const manifest = { namespace: 'fixture', trust: 'full', sdkVersion: '0.4.0', entries: [{ kind: 'desktop', module: './desktop.js' }] };
        export default [{ manifest, ${selection} }${extra}];`, loader: 'tsx' }));
    } }] });
  await page.route('**/custom.html', route => route.fulfill({ contentType: 'text/html', body: '<div id="root"></div><script src="/custom.js"></script>' }));
  await page.route('**/custom.js', route => route.fulfill({ contentType: 'text/javascript', body: Buffer.from(bundled.outputFiles.find(file => file.path.endsWith('.js')).contents) }));
  await page.goto(`${host.origin}/custom.html`);
  if (!breakDefault) await connected(page);
}
