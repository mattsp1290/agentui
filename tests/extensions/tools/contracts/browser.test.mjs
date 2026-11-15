import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { build } from 'esbuild';
import { chromium } from 'playwright';

test('bundled tools run under the desktop CSP', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agentui-tools-'));
  const csp = JSON.parse(await readFile('apps/desktop/src-tauri/tauri.conf.json', 'utf8')).app
    .security.csp;
  await build({
    entryPoints: ['tests/extensions/tools/contracts/fixtures/csp-entry.js'],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    outfile: join(dir, 'bundle.js'),
  });
  const server = createServer(async (req, res) => {
    res.setHeader('Content-Security-Policy', csp);
    if (req.url === '/bundle.js') {
      res.setHeader('Content-Type', 'text/javascript');
      res.end(await readFile(join(dir, 'bundle.js')));
    } else {
      res.setHeader('Content-Type', 'text/html');
      res.end('<body><script type="module" src="/bundle.js"></script></body>');
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${server.address().port}/nested/path?query=1`);
    await page.waitForFunction(() => document.body.textContent.includes('completed'));
    assert.deepEqual(JSON.parse(await page.locator('body').textContent()), {
      outcome: { kind: 'completed', output: 'ok' },
      invalid: { kind: 'refused', code: 'invalid-arguments' },
      blocked: true,
    });
  } finally {
    await browser?.close();
    await new Promise((resolve) => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
});
