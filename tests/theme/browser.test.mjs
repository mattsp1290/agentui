import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir } from 'node:fs/promises';
import axe from 'axe-core';
import { chromium } from 'playwright';
import { createPreview } from './server.mjs';

test('desktop controls work with system themes, scoped overrides and accessible settings', async (t) => {
  const preview = await createPreview();
  t.after(() => preview.close());
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 }, colorScheme: 'light' });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto(preview.url);
  const scope = page.getByTestId('system');
  await page.getByRole('heading', { level: 1 }).waitFor();
  const color = (locator, name) => locator.evaluate((element, property) => getComputedStyle(element).getPropertyValue(property).trim(), name);
  const settle = () => page.evaluate(() => Promise.all(document.getAnimations().map((animation) => animation.finished)));
  assert.equal(await scope.getAttribute('data-appearance'), 'light');
  const moduleButton = page.getByTestId('module-button');
  const send = page.getByTestId('send');
  assert.notEqual(await color(moduleButton, 'background-color'), await color(send, 'background-color'));
  await page.getByLabel('Message', { exact: true }).fill('Build a calm interface');
  await send.focus();
  assert.equal(await color(send, 'outline-style'), 'solid');
  assert.ok(parseFloat(await color(send, 'outline-width')) >= 2);
  await page.keyboard.press('Enter');
  assert.match(await page.getByRole('status').textContent(), /Actions 1\. Form submissions 0\./);
  assert.equal(await page.getByRole('button', { name: 'Attach file' }).isDisabled(), true);
  await page.getByRole('button', { name: 'Clear draft' }).click();
  assert.equal(await page.getByLabel('Message', { exact: true }).inputValue(), '');

  for (const appearance of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme: appearance });
    await page.waitForFunction((value) => document.querySelector('[data-testid="system"]').dataset.appearance === value, appearance);
    await settle();
    assert.equal(await page.getByTestId('override').getAttribute('data-appearance'), appearance);
    await page.addScriptTag({ content: axe.source });
    const accessibility = await page.evaluate(async () => window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] } }));
    assert.deepEqual(accessibility.violations.map(({ id, nodes }) => ({ id, targets: nodes.map((node) => node.target) })), []);
    for (const control of await page.locator('button,input').all()) {
      const box = await control.boundingBox();
      assert.ok(box.width >= 44 && box.height >= 44, 'control has a 44px target');
    }
    if (process.env.THEME_SCREENSHOT_DIR) {
      await mkdir(process.env.THEME_SCREENSHOT_DIR, { recursive: true });
      await page.screenshot({ path: `${process.env.THEME_SCREENSHOT_DIR}/${appearance}.png`, fullPage: true });
    }
  }

  await page.getByRole('button', { name: 'Light', exact: true }).click();
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
  await page.waitForFunction(() => document.querySelector('[data-testid="system"]').dataset.reducedMotion === 'true');
  assert.equal(await scope.getAttribute('data-appearance'), 'light');
  assert.equal(await page.getByTestId('override').getAttribute('data-appearance'), 'light');
  assert.equal(await page.getByTestId('override').getAttribute('data-reduced-motion'), 'true');
  assert.ok((await color(moduleButton, 'transition-duration')).split(',').every((duration) => duration.trim() === '0s'));
  assert.ok((await color(send, 'transition-duration')).split(',').every((duration) => duration.trim() === '0s'));
  await page.getByRole('button', { name: 'System', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('[data-testid="system"]').dataset.appearance === 'dark');
  assert.equal(await scope.getAttribute('data-appearance'), 'dark');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.waitForFunction(() => document.querySelector('[data-testid="system"]').dataset.reducedMotion === 'false');
  assert.ok((await color(send, 'transition-duration')).split(',').some((duration) => duration.trim() !== '0s'));

  const initialSize = parseFloat(await color(send, 'font-size'));
  await page.evaluate(() => { document.documentElement.style.fontSize = '200%'; });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(parseFloat(await color(send, 'font-size')), initialSize * 2);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  for (const control of await page.locator('button,input').all()) {
    const sizing = await control.evaluate((element) => ({ height: element.clientHeight, contentHeight: element.scrollHeight }));
    assert.ok(sizing.height >= sizing.contentHeight, 'wrapped control content fits vertically');
  }
  const inputMetrics = await page.getByLabel('Message', { exact: true }).evaluate((element) => {
    const style = getComputedStyle(element);
    return { content: element.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom), line: parseFloat(style.lineHeight) };
  });
  assert.ok(inputMetrics.content >= inputMetrics.line, 'input has space for an enlarged text line');
  if (process.env.THEME_SCREENSHOT_DIR) {
    await settle();
    await page.screenshot({ path: `${process.env.THEME_SCREENSHOT_DIR}/scaled-mobile.png`, fullPage: true });
  }
  assert.deepEqual(errors, []);
});
