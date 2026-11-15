import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('../../', import.meta.url));
const literal = '## Literal user\n**not bold** `not code`\n<script>literal</script>';
const bundle = await build({ stdin: { contents: `import React from 'react';
  import { createRoot } from 'react-dom/client';
  import { flushSync } from 'react-dom';
  import { ConversationView } from './apps/desktop/src/application/ConversationView.tsx';
  const listeners = new Set();
  let view = { draft: 'Keep my draft', submitting: [], outbox: [], connection: { kind: 'connected' },
    document: { domain: { messages: [{ messageId: 'user', revision: 1, role: 'user', text: ${JSON.stringify(literal)}, complete: true }] }, decisions: {}, receipts: {} } };
  const store = { getSnapshot: () => view, subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); },
    async setDraft(draft) { flushSync(() => { view = { ...view, draft }; for (const listener of listeners) listener(); }); } };
  const active = { store, scope: { hostId: 'host', conversationId: 'reply' }, agent: { label: 'Recorded', commands: ['send'], availability: { kind: 'ready' } } };
  const root = createRoot(document.getElementById('conversation'));
  globalThis.replySource = () => view.document.domain.messages[1];
  globalThis.setReply = (text, complete = false) => flushSync(() => {
    const messages = [view.document.domain.messages[0], { messageId: 'reply', revision: (view.document.domain.messages[1]?.revision ?? 0) + 1, role: 'assistant', text, complete }];
    view = { ...view, document: { ...view.document, domain: { messages } } };
    for (const listener of listeners) listener();
  });
  flushSync(() => root.render(<ConversationView active={active} actions={{}} enabled={true} storageFailure="" />));`, resolveDir: root, loader: 'jsx' },
  bundle: true, write: false, format: 'iife', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' } });
const css = (await Promise.all([
  'packages/ui-primitives/src/styles.css', 'apps/desktop/src/shell/styles.css', 'apps/desktop/src/application/application.css',
].map(path => readFile(new URL(path, `file://${root}`), 'utf8')))).join('\n').replace(/^@import .*;$/m, '');

async function fixture(t, width = 1000) {
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const context = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'], viewport: { width, height: 800 } });
  const page = await context.newPage();
  const requests = [], errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', async route => {
    if (route.request().url() === 'https://reply.test/') await route.fulfill({ contentType: 'text/html', body: '<!doctype html><div id="root" class="desktop-shell aui-theme" data-workspace-view="chats"><nav class="view-rail"></nav><aside class="application-controls"></aside><main><div class="chat-view" id="conversation"></div></main><footer class="shell-footer"></footer></div>' });
    else { requests.push(route.request().url()); await route.abort(); }
  });
  await page.goto('https://reply.test/');
  await page.addStyleTag({ content: css });
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  t.after(() => assert.deepEqual(errors, []));
  return { page, requests, reply: (text, complete) => page.evaluate(({ text, complete }) => globalThis.setReply(text, complete), { text, complete }) };
}

test('assistant formatting follows streaming text while user text, message identity and drafts survive', async t => {
  const { page, reply } = await fixture(t);
  const partial = '## Example\n\nA **bold** and *gentle* reply with `inline`.\n\n- First\n- Second\n\n1. Ordered\n2. Items\n\n```ts\nconst value =';
  await reply(partial);
  const assistant = page.locator('.message-assistant');
  await assistant.evaluate(node => { globalThis.originalArticle = node; });
  assert.equal(await assistant.getByRole('heading', { name: 'Example', level: 2 }).count(), 1);
  assert.equal(await assistant.locator('ul li').count(), 2);
  assert.equal(await assistant.locator('ol li').count(), 2);
  assert.equal(await assistant.locator('strong').last().textContent(), 'bold');
  assert.equal(await assistant.locator('em').textContent(), 'gentle');
  assert.equal(await assistant.locator('p code').textContent(), 'inline');
  assert.equal(await assistant.locator('pre code').textContent(), 'const value =\n');
  assert.equal(await assistant.locator('.progress-label').count(), 1);
  assert.equal(await page.locator('.message-user p').textContent(), literal);
  assert.equal(await page.locator('.message-user :is(h2, code, script)').count(), 0);
  const editor = page.getByRole('textbox', { name: 'Message', exact: true });
  await editor.fill('Still my draft');
  const complete = `${partial} 1;\n\`\`\`\n\nLater **text**.`;
  await reply(complete, true);
  assert.equal(await assistant.evaluate(node => node === globalThis.originalArticle), true);
  assert.equal(await assistant.locator('pre code').textContent(), 'const value = 1;\n');
  assert.match(await assistant.textContent(), /Later text\./);
  assert.equal(await assistant.locator('.progress-label').count(), 0);
  assert.equal(await editor.inputValue(), 'Still my draft');
  assert.deepEqual(await page.evaluate(() => globalThis.replySource()), { messageId: 'reply', revision: 2, role: 'assistant', text: complete, complete: true });
  assert.equal(await assistant.locator('strong').last().evaluate(node => getComputedStyle(node).fontWeight), '700');
});

test('code buttons copy the exact displayed whitespace through the browser clipboard independently', async t => {
  const { page, reply } = await fixture(t);
  const source = '```text\n  first  \n\n\tsecond\n```\n\n```\nother\n```';
  await reply(source);
  const blocks = page.locator('.reply-code-block');
  assert.equal(await blocks.count(), 2);
  const expected = '  first  \n\n\tsecond\n';
  assert.equal(await blocks.nth(0).locator('code').textContent(), expected);
  await blocks.nth(0).getByRole('button', { name: 'Copy code' }).click();
  await blocks.nth(0).getByRole('status').filter({ hasText: 'Copied.' }).waitFor();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), expected);
  assert.equal(await blocks.nth(1).getByRole('status').textContent(), '');
  await reply(`${source}\n\nMore prose.`, true);
  assert.equal(await blocks.nth(0).getByRole('status').textContent(), 'Copied.');
  await blocks.nth(1).getByRole('button', { name: 'Copy code' }).click();
  await blocks.nth(1).getByRole('status').filter({ hasText: 'Copied.' }).waitFor();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'other\n');
});

test('pending copy cannot mark changed code copied, including A to B to A, and failures stay honest', async t => {
  const { page, reply } = await fixture(t);
  await page.evaluate(() => {
    globalThis.copies = [];
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: text => new Promise((resolve, reject) => globalThis.copies.push({ text, resolve, reject })) } });
  });
  const a = '```\nA\n```', b = '```\nB\n```';
  await reply(a);
  const button = page.getByRole('button', { name: 'Copy code' });
  const status = page.locator('.reply-code-actions [role="status"]');
  await button.click();
  assert.equal(await button.isDisabled(), true);
  assert.equal(await status.textContent(), 'Copying…');
  await reply(b);
  await reply(a);
  assert.equal(await button.isEnabled(), true);
  await page.evaluate(() => globalThis.copies[0].resolve());
  assert.equal(await status.textContent(), '');
  await button.click();
  await page.evaluate(() => globalThis.copies[1].reject(new Error('Permission denied')));
  await status.filter({ hasText: 'Copy unavailable. Select the code to copy.' }).waitFor();
  assert.equal(await button.isEnabled(), true);
  assert.deepEqual(await page.evaluate(() => globalThis.copies.map(copy => copy.text)), ['A\n', 'A\n']);
  await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined }));
  await reply(b);
  await button.click();
  await status.filter({ hasText: 'Copy unavailable. Select the code to copy.' }).waitFor();
  assert.equal(await page.locator('pre code').textContent(), 'B\n');
  assert.equal(await page.locator('pre code').evaluate(node => { const range = document.createRange(); range.selectNodeContents(node); getSelection().removeAllRanges(); getSelection().addRange(range); return getSelection().toString(); }), 'B');
});

test('HTML remains visible text and destinations cannot execute, navigate or fetch images', async t => {
  const { page, reply, requests } = await fixture(t);
  const html = '<script>globalThis.replyExecuted = true</script>\n<img src="https://evil.test/raw.png" onerror="globalThis.replyExecuted = true">';
  await reply(`${html}\n\n[safe](https://example.test/path) [unsafe](javascript:alert%281%29) [encoded](jav&#x61;script:alert%281%29)\n\n![diagram](https://evil.test/image.png) ![unsafe image](data:image/svg+xml,bad)`, true);
  const assistant = page.locator('.assistant-reply');
  assert.match(await assistant.textContent(), /<script>globalThis.replyExecuted = true<\/script>/);
  assert.match(await assistant.textContent(), /<img src="https:\/\/evil.test\/raw.png"/);
  assert.equal(await assistant.locator('script, img, a, iframe').count(), 0);
  assert.match(await assistant.textContent(), /safe \(https:\/\/example.test\/path\)/);
  assert.match(await assistant.textContent(), /unsafe \(Destination unavailable\)/);
  assert.match(await assistant.textContent(), /encoded \(Destination unavailable\)/);
  assert.match(await assistant.textContent(), /Image not loaded: diagram \(https:\/\/evil.test\/image.png\)/);
  assert.match(await assistant.textContent(), /Image not loaded: unsafe image \(Destination unavailable\)/);
  await assistant.getByText('safe (https://example.test/path)', { exact: true }).click();
  assert.equal(page.url(), 'https://reply.test/');
  assert.equal(await page.evaluate(() => globalThis.replyExecuted), undefined);
  assert.deepEqual(requests, []);
});

test('long code scrolls inside the reply at 360px and keeps the composer visible', async t => {
  const { page, reply } = await fixture(t, 360);
  await reply(`## Code\n\n\`\`\`\n${'long_code_'.repeat(200)}\n\`\`\`\n\n${'LongProse'.repeat(100)}`, true);
  const layout = await page.evaluate(() => {
    const pre = document.querySelector('pre'), composer = document.querySelector('.composer').getBoundingClientRect();
    return { pageWidth: document.documentElement.scrollWidth, viewport: innerWidth,
      codeWidth: pre.clientWidth, codeScroll: pre.scrollWidth, codeRight: pre.getBoundingClientRect().right,
      composerTop: composer.top, composerBottom: composer.bottom, height: innerHeight };
  });
  assert.ok(layout.pageWidth <= layout.viewport, JSON.stringify(layout));
  assert.ok(layout.codeScroll > layout.codeWidth, JSON.stringify(layout));
  assert.ok(layout.codeRight <= layout.viewport, JSON.stringify(layout));
  assert.ok(layout.composerTop >= 0 && layout.composerBottom <= layout.height, JSON.stringify(layout));
  await page.getByRole('button', { name: 'Copy code' }).click();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), `${'long_code_'.repeat(200)}\n`);
});
