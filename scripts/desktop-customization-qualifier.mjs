import { once } from 'node:events';
import { createServer } from 'node:http';
import { extname } from 'node:path';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.png': 'image/png' };
const config = JSON.parse(await readFile(new URL('../apps/desktop/src-tauri/tauri.conf.json', import.meta.url), 'utf8'));
export async function qualifyDesktopArtifact({ files, entry, namespaces }) {
  const server = createServer((request, response) => {
    const path = new URL(request.url, 'http://localhost').pathname.slice(1);
    const bytes = files.get(path);
    if (!bytes) return response.writeHead(404).end();
    response.setHeader('Content-Type', types[extname(path)] ?? 'application/octet-stream');
    if (path === 'index.html') response.setHeader('Content-Security-Policy', config.app.security.csp);
    response.end(bytes);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  let browser;
  try {
    browser = await chromium.launch();
    const page = await browser.newPage();
    page.setDefaultTimeout(5000);
    const base = `http://127.0.0.1:${server.address().port}`;
    await page.route('**/*', route => route.request().url().startsWith(`${base}/`) ? route.continue() : route.abort());
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('requestfailed', request => { if (['script', 'stylesheet'].includes(request.resourceType())) errors.push(`Request failed: ${request.url()}`); });
    await page.goto(`${base}/browser.html`, { waitUntil: 'load', timeout: 5000 });
    await page.getByRole('heading', { name: 'A conversation that stays with you.' }).waitFor();
    let timer;
    const result = await Promise.race([
      page.evaluate(async path => { await import(path); return globalThis.__agentuiQualification; }, `${base}/${entry}`),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Customization qualification timed out')), 5000); }),
    ]).finally(() => clearTimeout(timer));
    if (JSON.stringify(result) !== JSON.stringify(namespaces)) throw new Error('Customization qualification count mismatch');
    await page.waitForFunction(() => ![...document.querySelectorAll('[role=status]')].some(node => node.textContent.includes('Loading custom tools…')));
    if (await page.getByRole('alert').filter({ hasText: 'Custom tools could not load.' }).count()) throw new Error('Desktop customization activation failed');
    await page.goto(`${base}/index.html`, { waitUntil: 'load', timeout: 5000 });
    await page.getByRole('heading', { name: 'No host connected' }).waitFor();
    if (errors.length) throw new Error(`Desktop artifact failed to boot: ${errors.join('; ')}`);
  } finally {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
  }
}
