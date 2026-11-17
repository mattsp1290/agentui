import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { chromium } from 'playwright';
import { startBrowserHost } from '../../apps/host/build/tsc/server.js';
import { repository, buildCustom, root } from '../customization/build/support.mjs';
import { connected, draft, wait, revealRecovery } from './browser-support.mjs';
import { png } from '../host/image-fixtures.mjs';

const editor = page => page.getByRole('textbox', { name: 'Message', exact: true });
async function decoded(preview) {
  await preview.waitFor({ state: 'visible' });
  await wait(() => preview.evaluate(node => node.complete && node.naturalWidth === 2 && node.naturalHeight === 2), 'decoded authorized image');
  assert.match(await preview.getAttribute('src'), /^blob:/);
}

for (const suspendedTranscript of [false, true]) test(`committed layout keeps sent images inside its ${suspendedTranscript ? 'independently suspended' : 'text-only'} transcript and protects the composer through loading, failure and restore`, { timeout: 90_000 }, async t => {
  const custom = repository(), child = repository();
  const directory = mkdtempSync(join(tmpdir(), 'agentui-img-'));
  let host, browser;
  t.after(async () => {
    const closed = await Promise.allSettled([browser?.close(), host?.close()]);
    for (const path of [directory, custom.directory, child.directory]) rmSync(path, { recursive: true, force: true });
    const failure = closed.find(result => result.status === 'rejected');
    if (failure) throw failure.reason;
  });
  const childManifest = JSON.parse(readFileSync(join(child.repo, 'package.json'), 'utf8'));
  childManifest.agentui.extension.namespace = 'transcript';
  child.write('package.json', JSON.stringify(childManifest));
  child.write('desktop/index.tsx', readFileSync(join(root, `tests/application/fixtures/${suspendedTranscript ? 'suspending-image-transcript' : 'transcript-override'}.tsx`), 'utf8'));
  const manifest = JSON.parse(readFileSync(join(custom.repo, 'package.json'), 'utf8'));
  manifest.agentui.extensions = [{ repository: child.repo, commit: child.commit() }];
  custom.write('package.json', JSON.stringify(manifest));
  custom.write('desktop/index.tsx', readFileSync(join(root, 'tests/application/fixtures/image-layout.tsx'), 'utf8'));
  const commit = custom.commit();
  child.write('desktop/index.tsx', 'throw new Error("Dirty transcript source must not enter artifact");');
  custom.write('desktop/index.tsx', 'throw new Error("Dirty layout source must not enter artifact");');
  t.diagnostic(buildCustom(custom, commit).trim().split('\n').at(-1));
  const log = join(directory, 'codex.jsonl'), implementation = join(directory, 'fixture.mjs'), executable = join(directory, 'codex');
  const copiedFixture = readFileSync(join(root, 'tests/host/fixtures/codex-agent.mjs'), 'utf8')
    .replace("displayName: 'GPT-9.2-Sol', hidden: false, isDefault: false", "displayName: 'GPT-9.2-Sol', hidden: false, isDefault: true")
    .replace("displayName: 'GPT-9.1-Astra', hidden: false, isDefault: true", "displayName: 'GPT-9.1-Astra', hidden: false, isDefault: false");
  assert.ok(copiedFixture.includes("displayName: 'GPT-9.2-Sol', hidden: false, isDefault: true"));
  assert.ok(copiedFixture.includes("displayName: 'GPT-9.1-Astra', hidden: false, isDefault: false"));
  writeFileSync(implementation, copiedFixture);
  writeFileSync(executable, `#!${process.execPath}\nif (process.argv[2] === '--version') console.log('codex-cli 0.167.2'); else { process.argv = [process.execPath, 'fixture', ${JSON.stringify(log)}, 'images']; await import(${JSON.stringify(implementation)}); }\n`, { mode: 0o700 });
  host = await startBrowserHost({ agentStartup: { kind: 'provider', provider: { kind: 'codex', cwd: directory, executable } },
    directory, port: 0, hostArtifactDirectory: join(root, 'apps/host/dist'), assetsDirectory: join(custom.directory, 'browser') });
  browser = await chromium.launch();
  const page = await browser.newPage(); page.setDefaultTimeout(15_000);
  const operations = [], errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (request.method() === 'POST' && request.url().includes('/api/')) operations.push({ path: new URL(request.url()).pathname, body: request.postDataJSON() }); });
  await page.goto(`${host.origin}/browser.html`);
  await wait(() => page.getByRole('button', { name: 'New conversation', exact: true }).isEnabled(), 'connected fixture host');
  await page.getByRole('button', { name: 'New conversation', exact: true }).click(); await connected(page);
  const layoutTranscript = page.getByRole('main', { name: 'Layout transcript', exact: true });
  const transcriptRegion = layoutTranscript.getByRole('region', { name: 'Committed transcript', exact: true });
  const nativeMessages = page.getByLabel('Messages', { exact: true });
  await (suspendedTranscript ? layoutTranscript.getByLabel('Messages', { exact: true }) : transcriptRegion).waitFor();
  assert.equal(await transcriptRegion.count(), suspendedTranscript ? 0 : 1);
  assert.equal(await nativeMessages.count(), suspendedTranscript ? 1 : 0);
  const bytes = png();
  await page.getByLabel('Image file').setInputFiles({ name: 'canonical.png', mimeType: 'image/png', buffer: bytes });
  await page.getByLabel('Attached image').getByRole('status').filter({ hasText: 'Ready' }).waitFor();
  assert.equal(await editor(page).inputValue(), '');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  const sent = page.getByRole('region', { name: 'Sent images', exact: true });
  const arrangedPreview = layoutTranscript.getByRole('img', { name: 'canonical.png', exact: true });
  const uniqueImage = async () => {
    assert.equal(await page.getByRole('img', { name: 'canonical.png', exact: true }).count(), 1, 'Each sent image must have exactly one visible preview');
  };
  await draft(page, 'Protected image draft');
  const originalEditor = await editor(page).elementHandle();
  const originalStop = await page.getByRole('button', { name: 'Stop', exact: true }).elementHandle();
  const stable = async () => {
    assert.equal(await editor(page).evaluate((node, original) => node === original, originalEditor), true);
    assert.equal(await editor(page).inputValue(), 'Protected image draft');
    assert.equal(await page.getByRole('button', { name: 'Stop', exact: true }).evaluate((node, original) => node === original, originalStop), true);
  };
  const originalLayout = await layoutTranscript.elementHandle();
  if (suspendedTranscript) {
    await decoded(nativeMessages.getByRole('img', { name: 'canonical.png', exact: true }));
    await uniqueImage();
    assert.equal(await sent.count(), 0);
    await page.evaluate(() => window.imageTranscript.resolve());
    await transcriptRegion.waitFor();
  }
  await decoded(arrangedPreview);
  await uniqueImage(); await stable();
  assert.equal(await layoutTranscript.evaluate((node, original) => node === original, originalLayout), true);
  assert.equal(await sent.getByRole('img', { name: 'canonical.png', exact: true }).count(), 1);
  assert.equal(await page.locator('.message-user').count(), 0);
  if (suspendedTranscript) {
    const originalTranscript = await transcriptRegion.elementHandle();
    await page.evaluate(() => window.imageTranscript.suspend());
    await decoded(nativeMessages.getByRole('img', { name: 'canonical.png', exact: true }));
    await uniqueImage(); await stable();
    assert.equal(await sent.count(), 0);
    assert.equal(await originalTranscript.evaluate(node => node.isConnected), true);
    assert.equal(await layoutTranscript.evaluate((node, original) => node === original, originalLayout), true);
    await page.evaluate(() => window.imageTranscript.resume());
    await decoded(arrangedPreview);
    await uniqueImage(); await stable();
    assert.equal(await nativeMessages.count(), 0);
    assert.equal(await transcriptRegion.evaluate((node, original) => node === original, originalTranscript), true);
  }
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Reconnect', exact: true }).waitFor();
  assert.equal(await layoutTranscript.isVisible(), false);
  assert.equal(await originalLayout.evaluate(node => node.isConnected), true);
  assert.equal(await originalEditor.evaluate(node => node.isConnected && node.value === 'Protected image draft'), true);
  await page.getByRole('button', { name: 'Chats', exact: true }).click();
  await decoded(arrangedPreview);
  assert.equal(await layoutTranscript.evaluate((node, original) => node === original, originalLayout), true);
  await stable();
  await page.getByRole('button', { name: 'Suspend image layout', exact: true }).click();
  await page.getByRole('status').filter({ hasText: 'Content layout is loading' }).waitFor();
  await decoded(page.getByLabel('Messages', { exact: true }).getByRole('img', { name: 'canonical.png', exact: true }));
  await uniqueImage(); await stable();
  await page.evaluate(() => window.resumeImageLayout());
  await decoded(arrangedPreview); await stable();
  assert.equal(await page.getByLabel('Messages', { exact: true }).count(), 0);
  if (suspendedTranscript) {
    await page.evaluate(() => window.imageTranscript.fail());
    await page.getByRole('alert').filter({ hasText: 'Committed image transcript failed' }).waitFor();
    await decoded(nativeMessages.getByRole('img', { name: 'canonical.png', exact: true }));
    await uniqueImage(); await stable();
    assert.equal(await sent.count(), 0);
    assert.equal(await transcriptRegion.count(), 0);
    assert.equal(await layoutTranscript.evaluate((node, original) => node === original, originalLayout), true);
  }
  await page.getByRole('button', { name: 'Fail image layout', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: 'Committed image layout failed' }).waitFor();
  if (!suspendedTranscript) await page.getByRole('region', { name: 'Committed transcript', exact: true }).waitFor();
  await decoded((suspendedTranscript ? nativeMessages : sent).getByRole('img', { name: 'canonical.png', exact: true }));
  await uniqueImage(); await stable();
  assert.equal(await layoutTranscript.count(), 0);
  assert.equal(await nativeMessages.count(), suspendedTranscript ? 1 : 0);
  await revealRecovery(page); await page.getByRole('button', { name: 'Restore default view', exact: true }).click();
  await decoded(page.getByLabel('Messages', { exact: true }).getByRole('img', { name: 'canonical.png', exact: true }));
  await uniqueImage();
  assert.equal(await sent.count(), 0);
  assert.equal(await page.getByRole('region', { name: 'Committed transcript', exact: true }).count(), 0);
  await stable();
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await wait(async () => await page.getByRole('button', { name: /^(?:Stop|Stopping…)$/ }).count() === 0, 'fixture stop settled');
  await wait(() => readFileSync(log, 'utf8').split('\n').filter(Boolean).map(JSON.parse).some(entry => entry.direction === 'in' && entry.method === 'turn/interrupt'), 'fixture received Stop');
  assert.equal(await editor(page).inputValue(), 'Protected image draft');
  const database = new DatabaseSync(join(directory, 'host.sqlite'));
  let commands;
  try { commands = database.prepare('SELECT intent FROM commands').all().map(row => JSON.parse(row.intent)); }
  finally { database.close(); }
  const sends = commands.filter(command => command.body.kind === 'send');
  assert.equal(sends.length, 1); assert.equal(sends[0].body.text, ''); assert.ok(sends[0].body.imageId);
  assert.equal(commands.filter(command => command.body.kind === 'cancel').length, 1);
  const imageReads = operations.filter(operation => operation.body.op === 'image-read');
  assert.ok(imageReads.length > 0);
  assert.ok(imageReads.every(operation => operation.path === '/api/v1/images' && operation.body.imageId === sends[0].body.imageId));
  const calls = readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse).filter(entry => entry.direction === 'in');
  const turns = calls.filter(entry => entry.method === 'turn/start');
  assert.equal(turns.length, 1);
  assert.deepEqual(turns[0].params.input, [{ type: 'image', url: `data:image/png;base64,${bytes.toString('base64')}` }]);
  assert.equal(calls.filter(entry => entry.method === 'turn/interrupt').length, 1);
  assert.deepEqual(errors, []);
});
