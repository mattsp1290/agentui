import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createConnection } from 'node:net';
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

test('committed layout keeps sent images inside its text-only transcript and protects the composer through loading, failure and restore', { timeout: 90_000 }, async t => {
  const custom = repository(), child = repository();
  t.after(() => { rmSync(custom.directory, { recursive: true, force: true }); rmSync(child.directory, { recursive: true, force: true }); });
  const childManifest = JSON.parse(readFileSync(join(child.repo, 'package.json'), 'utf8'));
  childManifest.agentui.extension.namespace = 'transcript';
  child.write('package.json', JSON.stringify(childManifest));
  child.write('desktop/index.tsx', readFileSync(join(root, 'tests/application/fixtures/transcript-override.tsx'), 'utf8'));
  const manifest = JSON.parse(readFileSync(join(custom.repo, 'package.json'), 'utf8'));
  manifest.agentui.extensions = [{ repository: child.repo, commit: child.commit() }];
  custom.write('package.json', JSON.stringify(manifest));
  custom.write('desktop/index.tsx', readFileSync(join(root, 'tests/application/fixtures/image-layout.tsx'), 'utf8'));
  const commit = custom.commit();
  buildCustom(custom, commit);
  child.write('desktop/index.tsx', 'throw new Error("Dirty transcript source must not enter artifact");');
  custom.write('desktop/index.tsx', 'throw new Error("Dirty layout source must not enter artifact");');
  const directory = join(custom.directory, 'host');
  mkdirSync(directory, { mode: 0o700 });
  const log = join(directory, 'codex.jsonl'), implementation = join(directory, 'fixture.mjs'), executable = join(directory, 'codex');
  writeFileSync(implementation, readFileSync(join(root, 'tests/host/fixtures/codex-agent.mjs'), 'utf8')
    .replace("displayName: 'GPT-9.2-Sol', hidden: false, isDefault: false", "displayName: 'GPT-9.2-Sol', hidden: false, isDefault: true")
    .replace("displayName: 'GPT-9.1-Astra', hidden: false, isDefault: true", "displayName: 'GPT-9.1-Astra', hidden: false, isDefault: false"));
  writeFileSync(executable, `#!${process.execPath}\nif (process.argv[2] === '--version') console.log('codex-cli 0.167.2'); else { process.argv = [process.execPath, 'fixture', ${JSON.stringify(log)}, 'images']; await import(${JSON.stringify(implementation)}); }\n`, { mode: 0o700 });
  const host = await startBrowserHost({ agentStartup: { kind: 'provider', provider: { kind: 'codex', cwd: directory, executable } },
    directory, port: 0, hostArtifactDirectory: join(root, 'apps/host/dist'), assetsDirectory: join(custom.directory, 'browser') });
  t.after(() => host.close());
  const control = op => new Promise((resolve, reject) => {
    const socket = createConnection(join(directory, 'control.sock')); let output = '';
    socket.once('error', reject); socket.once('connect', () => socket.end(JSON.stringify(op) + '\n'));
    socket.on('data', part => { output += part; });
    socket.once('end', () => { const value = JSON.parse(output); if (value.ok) resolve(value.value); else reject(new Error(value.error)); });
  });
  const browser = await chromium.launch(); t.after(() => browser.close());
  const page = await browser.newPage(); page.setDefaultTimeout(15_000);
  const operations = [], errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (request.method() === 'POST' && request.url().includes('/api/')) operations.push({ path: new URL(request.url()).pathname, body: request.postDataJSON() }); });
  await page.goto(`${host.origin}/browser.html`);
  await page.getByLabel('Pairing code').fill((await control({ op: 'invite' })).code);
  await page.getByRole('button', { name: 'Pair host', exact: true }).click();
  await wait(() => page.getByRole('button', { name: 'New conversation', exact: true }).isEnabled(), 'paired fixture host');
  await page.getByRole('button', { name: 'New conversation', exact: true }).click(); await connected(page);
  const layoutTranscript = page.getByRole('main', { name: 'Layout transcript', exact: true });
  await layoutTranscript.getByRole('region', { name: 'Committed transcript', exact: true }).waitFor();
  assert.equal(await page.getByLabel('Messages', { exact: true }).count(), 0);
  const bytes = png();
  await page.getByLabel('Image file').setInputFiles({ name: 'canonical.png', mimeType: 'image/png', buffer: bytes });
  await page.getByLabel('Attached image').getByRole('status').filter({ hasText: 'Ready' }).waitFor();
  assert.equal(await editor(page).inputValue(), '');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  const sent = page.getByRole('region', { name: 'Sent images', exact: true });
  const arrangedPreview = layoutTranscript.getByRole('img', { name: 'canonical.png', exact: true });
  await decoded(arrangedPreview);
  assert.equal(await sent.getByRole('img', { name: 'canonical.png', exact: true }).count(), 1);
  assert.equal(await page.locator('.message-user').count(), 0);
  await draft(page, 'Protected image draft');
  const originalEditor = await editor(page).elementHandle();
  const originalStop = await page.getByRole('button', { name: 'Stop', exact: true }).elementHandle();
  const stable = async () => {
    assert.equal(await editor(page).evaluate((node, original) => node === original, originalEditor), true);
    assert.equal(await editor(page).inputValue(), 'Protected image draft');
    assert.equal(await page.getByRole('button', { name: 'Stop', exact: true }).evaluate((node, original) => node === original, originalStop), true);
  };
  await page.getByRole('button', { name: 'Suspend image layout', exact: true }).click();
  await page.getByRole('status').filter({ hasText: 'Content layout is loading' }).waitFor();
  await decoded(page.getByLabel('Messages', { exact: true }).getByRole('img', { name: 'canonical.png', exact: true }));
  await stable();
  await page.evaluate(() => window.resumeImageLayout());
  await decoded(arrangedPreview); await stable();
  assert.equal(await page.getByLabel('Messages', { exact: true }).count(), 0);
  await page.getByRole('button', { name: 'Fail image layout', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: 'Committed image layout failed' }).waitFor();
  await page.getByRole('region', { name: 'Committed transcript', exact: true }).waitFor();
  await decoded(sent.getByRole('img', { name: 'canonical.png', exact: true })); await stable();
  assert.equal(await layoutTranscript.count(), 0);
  await revealRecovery(page); await page.getByRole('button', { name: 'Restore default view', exact: true }).click();
  await decoded(page.getByLabel('Messages', { exact: true }).getByRole('img', { name: 'canonical.png', exact: true }));
  assert.equal(await sent.count(), 0);
  assert.equal(await page.getByRole('region', { name: 'Committed transcript', exact: true }).count(), 0);
  await stable();
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await wait(() => page.getByRole('button', { name: 'Stop', exact: true }).count().then(count => count === 0), 'fixture stop settled');
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
