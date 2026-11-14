import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';

test('React binding observes immutable views and keeps same-scope drafts independent', async t => {
  const result = await build({ entryPoints: [fileURLToPath(new URL('./react-fixture.jsx', import.meta.url))], bundle: true, write: false, define: { 'process.env.NODE_ENV': '"development"' } });
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.setContent('<div id="root"></div>');
  await page.addScriptTag({ content: result.outputFiles[0].text });
  await page.evaluate(() => window.clientFixture.start());
  await page.waitForFunction(() => document.querySelector('[data-testid="left"]').textContent === '||0');
  await page.evaluate(() => window.clientFixture.update());
  await page.waitForFunction(() => document.querySelector('[data-testid="left"]').textContent === 'shared host|left draft|1');
  assert.equal(await page.getByTestId('right').textContent(), 'shared host|right draft|1');
  await page.evaluate(() => window.clientFixture.unmount());
  assert.equal(await page.locator('output').count(), 0);
  assert.deepEqual(errors, []);
});
