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

async function observeCspViolations(page) {
  const violations = [];
  await page.exposeFunction('reportCspViolation', (violation) => { violations.push(violation); });
  await page.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (event) => {
      void window.reportCspViolation(`${event.effectiveDirective}: ${event.blockedURI}`);
    });
  });
  return violations;
}

async function revealRecovery(page) {
  const settings = page.getByRole('button', { name: 'Settings', exact: true });
  if (await settings.count()) await settings.click();
  const menu = page.locator('.recovery-menu');
  if (await menu.getAttribute('open') === null) await menu.locator('summary').click();
}

test('production desktop renders disconnected, follows appearance, and reloads', async (t) => {
  const server = await preview({
    root: fileURLToPath(desktop),
    configFile: fileURLToPath(new URL('vite.config.mjs', desktop)),
    preview: { host: '127.0.0.1', port: 0, headers: { 'Content-Security-Policy': config.app.security.csp } },
  });
  let browser;
  t.after(async () => {
    try { await browser?.close(); }
    finally { await server.close(); }
  });
  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1120, height: 780 }, colorScheme: 'light', offline: false });
  const violations = await observeCspViolations(page);
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
  await page.getByRole('button', { name: 'Connect to local Codex', exact: true }).waitFor({ timeout: 2000 });
  const appearance = (value) => page.waitForFunction((expected) => document.querySelector('.desktop-shell')?.getAttribute('data-appearance') === expected, value);
  await appearance('light');
  const background = () => page.locator('.desktop-shell').evaluate((shell) => getComputedStyle(shell).backgroundColor);
  const lightBackground = await background();
  assert.notEqual(lightBackground, 'rgba(0, 0, 0, 0)');
  await page.emulateMedia({ colorScheme: 'dark' });
  await appearance('dark');
  assert.notEqual(await background(), 'rgba(0, 0, 0, 0)');
  assert.notEqual(await background(), lightBackground);
  await revealRecovery(page);
  await page.getByRole('button', { name: 'Restore default view' }).focus();
  await page.keyboard.press('Enter');
  await page.getByRole('heading', { name: 'No host connected' }).waitFor();
  await revealRecovery(page);
  await Promise.all([page.waitForEvent('load'), page.getByRole('button', { name: 'Reload app' }).click()]);
  await page.getByRole('heading', { name: 'No host connected' }).waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => { document.documentElement.style.fontSize = '200%'; });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  assert.deepEqual(errors, []);
  assert.deepEqual(violations, []);
});

test('content failure leaves shell controls usable and restores the built-in view', async (t) => {
  const fixture = await build({
    entryPoints: [fileURLToPath(new URL('failure-fixture.jsx', import.meta.url))],
    outfile: 'fixture.js', bundle: true, write: false, jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"production"' },
  });
  const assets = new Map(fixture.outputFiles.map((file) => [file.path.endsWith('.css') ? '/fixture.css' : '/fixture.js', file.contents]));
  const server = createServer((request, response) => {
    response.setHeader('Content-Security-Policy', config.app.security.csp);
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
  let browser;
  t.after(async () => {
    try { await browser?.close(); }
    finally { await new Promise((resolve) => server.close(resolve)); }
  });
  browser = await chromium.launch();
  const page = await browser.newPage();
  const violations = await observeCspViolations(page);
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.getByRole('alert').waitFor();
  await revealRecovery(page);
  await page.getByRole('navigation', { name: 'Recovery controls' }).waitFor();
  await revealRecovery(page);
  await page.getByRole('button', { name: 'Restore default view' }).click();
  await page.getByRole('heading', { name: 'No host connected' }).waitFor();
  assert.equal(await page.getByRole('alert').count(), 0);
  await revealRecovery(page);
  await page.getByRole('button', { name: 'Restore default view' }).click();
  await page.getByRole('heading', { name: 'No host connected' }).waitFor();
  assert.deepEqual(violations, []);
});

test('chat workspace separates the icon rail and chat list and opens settings without a duplicate bar', async t => {
  const server = await preview({
    root: fileURLToPath(desktop), mode: 'browser',
    configFile: fileURLToPath(new URL('vite.config.mjs', desktop)),
    preview: { host: '127.0.0.1', port: 0 },
  });
  const browser = await chromium.launch();
  t.after(async () => { await browser.close(); await server.close(); });
  const page = await browser.newPage({ viewport: { width: 1120, height: 780 } });
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/browser.html`);
  const chats = page.getByRole('button', { name: 'Chats', exact: true });
  const settings = page.getByRole('button', { name: 'Settings', exact: true });
  await chats.waitFor();
  assert.equal(await chats.getAttribute('aria-pressed'), 'true');
  assert.equal(await page.locator('.shell-header').isVisible(), false);
  const rail = await page.getByRole('navigation', { name: 'Workspace views' }).boundingBox();
  const sidebar = await page.locator('.application-controls').boundingBox();
  assert.ok(rail.x + rail.width <= sidebar.x, 'icon rail is a separate pane beside the chat list');
  await settings.click();
  await page.getByRole('heading', { name: 'Settings', level: 1, exact: true }).waitFor();
  await page.getByRole('button', { name: 'Reconnect', exact: true }).waitFor();
  await revealRecovery(page);
  await page.getByRole('button', { name: 'Restore default view', exact: true }).click();
  assert.equal(await chats.getAttribute('aria-pressed'), 'true');
  assert.equal(await page.locator('.shell-header').isVisible(), false);
  assert.equal(await page.locator('.settings-panel').isVisible(), false);
});
