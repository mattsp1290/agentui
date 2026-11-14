import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { preview } from 'vite';
import { chromium } from 'playwright';

const root = new URL('../../../', import.meta.url);
const desktop = new URL('apps/desktop/', root);
const config = JSON.parse(await readFile(new URL('src-tauri/tauri.conf.json', desktop), 'utf8'));

test('production desktop renders disconnected, follows appearance, and reloads', async (t) => {
  const server = await preview({
    root: fileURLToPath(desktop),
    configFile: fileURLToPath(new URL('vite.config.mjs', desktop)),
    preview: { host: '127.0.0.1', port: 0, headers: { 'Content-Security-Policy': config.app.security.csp } },
  });
  t.after(() => new Promise((resolve) => server.httpServer.close(resolve)));
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1120, height: 780 }, colorScheme: 'light', offline: false });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const address = server.httpServer.address();
  assert.ok(address && typeof address === 'object');
  const url = `http://127.0.0.1:${address.port}`;
  const response = await page.goto(url);
  assert.equal(response.status(), 200);
  assert.match(await response.headerValue('content-security-policy'), /connect-src 'none'/);
  await page.getByRole('heading', { name: 'A home for your conversations.' }).waitFor();
  await page.getByRole('heading', { name: 'No host connected' }).waitFor();
  const appearance = (value) => page.waitForFunction((expected) => document.querySelector('.desktop-shell')?.getAttribute('data-appearance') === expected, value);
  await appearance('light');
  await page.emulateMedia({ colorScheme: 'dark' });
  await appearance('dark');
  await page.getByRole('button', { name: 'Restore default view' }).focus();
  await page.keyboard.press('Enter');
  await page.getByRole('heading', { name: 'No host connected' }).waitFor();
  await Promise.all([page.waitForEvent('load'), page.getByRole('button', { name: 'Reload app' }).click()]);
  await page.getByRole('heading', { name: 'No host connected' }).waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => { document.documentElement.style.fontSize = '200%'; });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  assert.deepEqual(errors, []);
});

test('content failure leaves shell controls usable and restores the built-in view', async (t) => {
  const fixture = await build({
    entryPoints: [fileURLToPath(new URL('failure-fixture.jsx', import.meta.url))],
    outfile: 'fixture.js', bundle: true, write: false, jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"production"' },
  });
  const assets = new Map(fixture.outputFiles.map((file) => [file.path.endsWith('.css') ? '/fixture.css' : '/fixture.js', file.contents]));
  const server = createServer((request, response) => {
    if (request.url === '/') {
      response.setHeader('Content-Type', 'text/html');
      response.end('<!doctype html><html lang="en"><head><title>Shell recovery test</title><link rel="stylesheet" href="/fixture.css"></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>');
    } else if (assets.has(request.url)) {
      response.setHeader('Content-Type', request.url.endsWith('.css') ? 'text/css' : 'text/javascript');
      response.end(assets.get(request.url));
    } else response.writeHead(404).end();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.getByRole('alert').waitFor();
  await page.getByRole('navigation', { name: 'Recovery controls' }).waitFor();
  await page.getByRole('button', { name: 'Restore default view' }).click();
  await page.getByRole('heading', { name: 'No host connected' }).waitFor();
  assert.equal(await page.getByRole('alert').count(), 0);
  await page.getByRole('button', { name: 'Restore default view' }).click();
  await page.getByRole('heading', { name: 'No host connected' }).waitFor();
});
