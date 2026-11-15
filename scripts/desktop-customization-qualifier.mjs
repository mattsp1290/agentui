import { once } from 'node:events';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { serveAsset } from '../apps/host/build/tsc/static-assets.js';

export async function qualifyDesktopArtifact({ files, namespaces }) {
  const config = JSON.parse(await readFile(new URL('../apps/desktop/src-tauri/tauri.conf.json', import.meta.url), 'utf8'));
  let base;
  const server = createServer((request, response) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') return response.writeHead(404).end();
    const path = new URL(request.url ?? '/', base).pathname.slice(1);
    if (path !== 'index.html') return serveAsset(files, request, response, base);
    const bytes = files.get(path);
    if (!bytes) return response.writeHead(404).end();
    response.setHeader('Content-Type', 'text/html');
    response.setHeader('Content-Security-Policy', config.app.security.csp);
    response.end(bytes);
  });
  let browser;
  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    base = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch();
    const page = await browser.newPage();
    page.setDefaultTimeout(5000);
    await page.route('**/*', route => route.request().url().startsWith(`${base}/`) ? route.continue() : route.abort());
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('requestfailed', request => { if (['script', 'stylesheet'].includes(request.resourceType())) errors.push(`Request failed: ${request.url()}`); });
    await page.goto(`${base}/browser.html`, { waitUntil: 'load', timeout: 5000 });
    await page.getByRole('heading', { name: 'A conversation that stays with you.' }).waitFor();
    await page.waitForFunction(count => {
      const panels = [...document.querySelectorAll('[data-customization-state]')];
      return panels.length === count && panels.every(panel => panel.getAttribute('data-customization-state') !== 'loading');
    }, namespaces.length);
    const panels = await page.locator('[data-customization-state]').evaluateAll(nodes => nodes.map(node => ({
      namespace: node.getAttribute('data-customization-namespace'), state: node.getAttribute('data-customization-state'), text: node.textContent,
    })));
    const actual = panels.map(panel => panel.namespace);
    if (JSON.stringify(actual) !== JSON.stringify(namespaces)) throw new Error(`Customization qualification mismatch: expected ${JSON.stringify(namespaces)}, got ${JSON.stringify(actual)}`);
    const failed = panels.filter(panel => panel.state !== 'ready');
    if (failed.length) throw new Error(`Desktop customization activation failed: ${failed.map(panel => `${panel.namespace}: ${panel.text}`).join('; ')}`);
    await page.goto(`${base}/index.html`, { waitUntil: 'load', timeout: 5000 });
    await page.getByRole('heading', { name: 'No host connected' }).waitFor();
    if (errors.length) throw new Error(`Desktop artifact failed to boot: ${errors.join('; ')}`);
  } finally {
    try { await browser?.close(); }
    finally { if (server.listening) await new Promise(resolve => server.close(resolve)); }
  }
}
