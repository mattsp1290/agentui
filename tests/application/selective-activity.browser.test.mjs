import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { createHash } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { chromium } from 'playwright';
import { startBrowserHost } from '../../apps/host/build/tsc/server.js';
import { repository, buildCustom, root } from '../customization/build/support.mjs';
import { connected, draft, wait } from './browser-support.mjs';
import { activityProvider } from './selective-activity-provider.mjs';
import { png } from '../host/image-fixtures.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const audit = mkdtempSync(join(tmpdir(), 'agentui-activity-evidence-'));
const selected = page => page.getByRole('region', { name: 'Committed activity', exact: true });
const domain = async page => JSON.parse(await selected(page).locator('pre').textContent());
const command = (revision = 1, status = { kind: 'running' }) => ({ kind: 'command-updated', activity: {
  kind: 'command', activityId: 'command', runId: 'placeholder', revision, command: 'printf activity', cwd: '/fixture',
  detailsTruncated: true, status, output: `output-${revision}`, outputTruncated: true } });
const file = (revision = 1, status = 'unknown') => ({ kind: 'file-change-updated', activity: {
  kind: 'file-change', activityId: 'file', runId: 'placeholder', revision, status: { kind: status }, omittedChanges: 2,
  changes: [{ path: 'before.ts', operation: 'update', movedTo: 'after.ts', patch: '-old\n+new', detailsTruncated: true, patchTruncated: true }] } });

let retainedArtifact;
const artifactDirectories = [audit];
after(() => { for (const directory of artifactDirectories) rmSync(directory, { recursive: true, force: true }); });
async function committed() {
  if (retainedArtifact) return retainedArtifact;
  const custom = repository(), child = repository();
  artifactDirectories.push(custom.directory);
  artifactDirectories.push(child.directory);
  const childManifest = JSON.parse(readFileSync(join(child.repo, 'package.json'), 'utf8'));
  childManifest.agentui.extension.namespace = 'activity-companion';
  child.write('package.json', JSON.stringify(childManifest));
  child.write('desktop/index.tsx', readFileSync(join(root, 'tests/application/fixtures/activity-companion.tsx'), 'utf8'));
  const childCommit = child.commit();
  const rootManifest = JSON.parse(readFileSync(join(custom.repo, 'package.json'), 'utf8'));
  rootManifest.agentui.extensions = [{ repository: child.repo, commit: childCommit }];
  custom.write('package.json', JSON.stringify(rootManifest));
  const source = readFileSync(join(root, 'tests/application/fixtures/selective-activity.tsx'), 'utf8');
  custom.write('desktop/index.tsx', source);
  const commit = custom.commit();
  custom.write('desktop/index.tsx', 'throw new Error("Dirty activity author source must never execute");');
  child.write('desktop/index.tsx', 'throw new Error("Dirty companion author source must never execute");');
  const built = JSON.parse(buildCustom(custom, commit).trim().split('\n').at(-1));
  const assets = join(custom.directory, 'browser');
  const manifest = JSON.parse(readFileSync(join(assets, 'artifact.json'), 'utf8'));
  const identity = JSON.parse(readFileSync(join(assets, 'customization-identity.json'), 'utf8'));
  assert.equal(identity.packages[0].commit, commit);
  assert.equal(identity.packages[1].commit, childCommit);
  const evidence = { commit, sourceSha256: hash(source), dirtySha256: hash(readFileSync(join(custom.repo, 'desktop/index.tsx'))),
    built, manifest, identity, served: [] };
  cpSync(assets, join(audit, 'browser-artifact'), { recursive: true, force: true });
  cpSync(custom.repo, join(audit, 'dirty-author-repository'), { recursive: true, force: true });
  cpSync(child.repo, join(audit, 'dirty-companion-repository'), { recursive: true, force: true });
  retainedArtifact = { assets, evidence };
  return retainedArtifact;
}
async function surface(t, assets, startup, extensions = []) {
  const directory = mkdtempSync(join(tmpdir(), 'agentui-activity-'));
  let host, browser;
  t.after(async () => {
    const results = await Promise.allSettled([browser?.close(), host?.close()]);
    rmSync(directory, { recursive: true, force: true });
    for (const result of results) if (result.status === 'rejected') throw result.reason;
  });
  host = await startBrowserHost({ directory, port: 0, accessMode: 'trusted', agentStartup: startup,
    hostArtifactDirectory: join(root, 'apps/host/dist'), assetsDirectory: assets,
    ...(extensions.length ? { extensions: { kind: 'transient', entries: extensions } } : {}) });
  browser = await chromium.launch();
  const page = await browser.newPage(); page.setDefaultTimeout(15_000);
  return { directory, host, browser, page };
}
async function open(page, host, mode = '') {
  await page.goto(`${host.origin}/browser.html${mode ? `?activity=${mode}` : ''}`);
  await wait(() => page.getByRole('button', { name: 'New conversation', exact: true }).isEnabled(), 'trusted owner startup');
  await page.getByRole('button', { name: 'New conversation', exact: true }).click(); await connected(page);
}
function servedAssets(page, assets) {
  const hashes = [], pending = [];
  page.on('response', response => {
    const path = new URL(response.url()).pathname.slice(1);
    if (path.endsWith('.js')) pending.push((async () => {
      const bytes = await response.body();
      assert.equal(hash(bytes), hash(readFileSync(join(assets, path))));
      hashes.push({ path, sha256: hash(bytes) });
    })());
  });
  return { hashes, complete: () => Promise.all(pending) };
}

test('committed selective activity consumes a real generic feed and preserves native messages through pause, reconnect and activity lifecycle', { timeout: 120_000 }, async t => {
  const artifact = await committed(t), provider = await activityProvider(t);
  const { page, host } = await surface(t, artifact.assets, { kind: 'extensions' }, [provider.extension]);
  const served = servedAssets(page, artifact.assets);
  await open(page, host);
  await selected(page).waitFor();
  await draft(page, 'Provider request'); await page.getByRole('button', { name: 'Send', exact: true }).click();
  await wait(() => provider.clients.size === 1, 'actual provider feed');
  const id = [...provider.saved.keys()][0];
  provider.emit(id, [{ kind: 'message-updated', messageId: 'user', revision: 1, role: 'user', text: 'Provider request', complete: true },
    { kind: 'message-updated', messageId: 'answer', revision: 1, role: 'assistant', text: '**Native Markdown** reply', complete: false }, command(), file()]);
  await page.locator('.message-assistant strong').filter({ hasText: 'Native Markdown' }).waitFor();
  await wait(async () => (await domain(page)).activities?.length === 2, 'canonical activity');
  const first = await domain(page), run = first.currentRun.runId;
  const observations = [{ phase: 'running', updates: await selected(page).getAttribute('data-updates'), run }];
  assert.equal(first.activities[0].runId, run); assert.equal(first.activities[1].status.kind, 'unknown');
  assert.equal(first.activities[0].detailsTruncated, true); assert.equal(first.activities[0].outputTruncated, true);
  assert.equal(first.activities[1].omittedChanges, 2); assert.equal(first.activities[1].changes[0].movedTo, 'after.ts');
  assert.equal(await page.locator('.command-activity,.file-activity').count(), 0);
  await draft(page, 'Retained activity draft');
  const editor = await page.getByRole('textbox', { name: 'Message', exact: true }).elementHandle();
  await page.evaluate(() => window.activityFixture.suspend());
  await page.getByText('printf activity', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.activityFixture.committed()), 1);
  assert.equal(await selected(page).isVisible(), false);
  await page.evaluate(() => window.activityFixture.resume()); await selected(page).waitFor();
  assert.equal(await page.getByRole('textbox', { name: 'Message', exact: true }).evaluate((node, original) => node === original, editor), true);
  provider.end(id);
  await page.getByRole('status').filter({ hasText: 'Updates paused. The provider stopped delivering updates.' }).waitFor();
  await wait(async () => await selected(page).getAttribute('data-updates') === 'paused', 'paused context');
  await connected(page);
  const sends = () => provider.requests.filter(request => request.path === '/submit');
  assert.equal(sends().length, 1);
  observations.push({ phase: 'feed-ended', updates: await selected(page).getAttribute('data-updates'), journal: 'connected',
    notice: await page.locator('.observation-notice').textContent(), sendCount: sends().length, run: (await domain(page)).currentRun.runId });
  await page.getByRole('button', { name: 'Check for updates', exact: true }).click();
  await wait(() => provider.clients.size === 1, 'resumed actual feed');
  await wait(async () => await selected(page).getAttribute('data-updates') === 'connected', 'resumed context');
  assert.equal((await domain(page)).currentRun.runId, run); assert.equal(sends().length, 1);
  observations.push({ phase: 'provider-retried', updates: await selected(page).getAttribute('data-updates'),
    sendCount: sends().length, run: (await domain(page)).currentRun.runId });
  let disconnected = false;
  await page.route('**/api/v1', route => {
    const op = route.request().postDataJSON().op;
    if (op === 'pull' || op === 'watch') { disconnected = true; return route.abort('failed'); }
    return route.continue();
  });
  provider.emit(id, [command(2)]);
  await wait(async () => disconnected && await selected(page).getAttribute('data-updates') === 'reconnecting', 'independent journal disconnect');
  assert.equal(await page.getByRole('status').filter({ hasText: 'Updates paused.' }).count(), 0);
  assert.equal(provider.clients.size, 1);
  observations.push({ phase: 'journal-disconnected', updates: await selected(page).getAttribute('data-updates'),
    transportAborted: disconnected, providerFeeds: provider.clients.size, pausedNotices: 0 });
  await page.unroute('**/api/v1');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Reconnect', exact: true }).click();
  await page.getByRole('button', { name: 'Chats', exact: true }).click();
  await connected(page);
  provider.emit(id, [command(3, { kind: 'completed', exitCode: 0 }), file(2, 'completed')]);
  await wait(async () => (await domain(page)).activities[0].status.kind === 'completed', 'terminal revision');
  provider.emit(id, [{ kind: 'run-ended', runId: 'placeholder', outcome: 'completed' },
    { kind: 'message-updated', messageId: 'answer', revision: 2, role: 'assistant', text: '**Native Markdown** reply', complete: true }]);
  await wait(async () => (await domain(page)).currentRun.kind === 'ended', 'real ended run');
  await page.getByRole('button', { name: 'Capture activity command', exact: true }).click();
  const previousScope = await page.locator('.scope-label').textContent();
  await page.getByRole('button', { name: 'New conversation', exact: true }).click();
  await wait(async () => await page.locator('.scope-label').textContent() !== previousScope, 'new activity target');
  await connected(page);
  await wait(() => page.getByRole('button', { name: 'New conversation', exact: true }).isEnabled(), 'navigation complete');
  const refused = await page.evaluate(async () => {
    try { await window.activityCapturedSend(); return ''; } catch (error) { return error.message; }
  });
  assert.match(refused, /Open the command’s conversation/);
  await draft(page, 'Retained activity draft');
  await page.getByRole('button', { name: 'Send activity command', exact: true }).click();
  await wait(() => sends().length === 2, 'current activity command');
  assert.equal(sends()[1].input.request.text, 'Current activity command');
  assert.notEqual(sends()[1].input.binding.creation.scope.conversationId, id);
  await wait(() => page.evaluate(() => Boolean(window.activityCommandResult)), 'current command result');
  assert.equal(await page.evaluate(() => window.activityCommandResult.kind), 'receipt');
  await page.evaluate(() => window.activityFixture.fail());
  await page.getByRole('alert').filter({ hasText: 'Committed activity failed' }).waitFor();
  await page.getByLabel('Messages', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.activityFixture.committed()), 0);
  assert.equal(await page.getByRole('textbox', { name: 'Message', exact: true }).inputValue(), 'Retained activity draft');
  assert.equal(sends().length, 2);
  await served.complete();
  writeFileSync(join(audit, 'generic-artifact.json'), JSON.stringify({ ...artifact.evidence, served: served.hashes, observations, refused,
    currentCommandResult: await page.evaluate(() => window.activityCommandResult), run, sendCount: sends().length,
    requests: provider.requests.map(request => request.path), finalProviderState: provider.saved.get(id).state }, null, 2));
});

test('the same committed activity artifact retains a decoded native image beside Codex command and file notifications', { timeout: 90_000 }, async t => {
  const artifact = await committed(t);
  const temporary = mkdtempSync(join(tmpdir(), 'agentui-activity-codex-'));
  t.after(() => rmSync(temporary, { recursive: true, force: true }));
  const log = join(temporary, 'codex.jsonl'), implementation = join(temporary, 'fixture.mjs'), executable = join(temporary, 'codex');
  const fixture = readFileSync(join(root, 'tests/host/fixtures/codex-agent.mjs'), 'utf8')
    .replace("displayName: 'GPT-9.2-Sol', hidden: false, isDefault: false", "displayName: 'GPT-9.2-Sol', hidden: false, isDefault: true")
    .replace("displayName: 'GPT-9.1-Astra', hidden: false, isDefault: true", "displayName: 'GPT-9.1-Astra', hidden: false, isDefault: false")
    .replace("notify('turn/started', { threadId, turn: { id: turn.id, status: 'inProgress', error: null, items: [] } });\n      if (previous)",
      `notify('turn/started', { threadId, turn: { id: turn.id, status: 'inProgress', error: null, items: [] } });
      notify('item/started', { threadId, turnId: turn.id, item: { id: 'activity-command', type: 'commandExecution', command: 'printf image', cwd: '/', status: 'inProgress', aggregatedOutput: null } });
      notify('item/started', { threadId, turnId: turn.id, item: { id: 'activity-file', type: 'fileChange', status: 'inProgress', changes: [{ path: 'image.ts', diff: '-old\\n+new', kind: { type: 'update', move_path: null } }] } });
      if (previous)`);
  assert.ok(fixture.includes("id: 'activity-command'"));
  writeFileSync(implementation, fixture);
  writeFileSync(executable, `#!${process.execPath}\nif (process.argv[2] === '--version') console.log('codex-cli 0.167.2'); else { process.argv = [process.execPath, 'fixture', ${JSON.stringify(log)}, 'images']; await import(${JSON.stringify(implementation)}); }\n`, { mode: 0o700 });
  const { page, host } = await surface(t, artifact.assets, { kind: 'provider', provider: { kind: 'codex', cwd: temporary, executable } });
  const served = servedAssets(page, artifact.assets);
  const operations = [];
  page.on('request', request => { if (request.method() === 'POST' && request.url().includes('/api/')) operations.push(request.postDataJSON()); });
  await open(page, host);
  const bytes = png();
  await page.getByLabel('Image file').setInputFiles({ name: 'activity.png', mimeType: 'image/png', buffer: bytes });
  await page.getByLabel('Attached image').getByRole('status').filter({ hasText: 'Ready' }).waitFor();
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  const preview = page.getByLabel('Messages', { exact: true }).getByRole('img', { name: 'activity.png', exact: true });
  await preview.waitFor();
  await wait(() => preview.evaluate(node => node.complete && node.naturalWidth === 2 && node.naturalHeight === 2), 'decoded authorized native image');
  assert.match(await preview.getAttribute('src'), /^blob:/);
  const decodedImage = await preview.evaluate(node => ({ complete: node.complete, width: node.naturalWidth, height: node.naturalHeight, source: node.src.split(':')[0] }));
  await wait(async () => (await domain(page)).activities?.length === 2, 'Codex activity beside native image');
  await page.locator('.message-assistant').filter({ hasText: 'Hello' }).waitFor();
  await draft(page, 'Image draft retained');
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await wait(() => readFileSync(log, 'utf8').includes('turn/interrupt'), 'one real cancel');
  const calls = readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse).filter(entry => entry.direction === 'in');
  assert.equal(calls.filter(entry => entry.method === 'turn/start').length, 1);
  assert.equal(calls.filter(entry => entry.method === 'turn/interrupt').length, 1);
  assert.deepEqual(calls.find(entry => entry.method === 'turn/start').params.input, [{ type: 'image', url: `data:image/png;base64,${bytes.toString('base64')}` }]);
  assert.ok(operations.some(operation => operation.op === 'image-read'));
  assert.equal(await page.getByRole('img', { name: 'activity.png', exact: true }).count(), 1);
  assert.equal(await page.getByRole('textbox', { name: 'Message', exact: true }).inputValue(), 'Image draft retained');
  await served.complete();
  writeFileSync(join(audit, 'codex-artifact.json'), JSON.stringify({ ...artifact.evidence, served: served.hashes, decodedImage,
    imageSha256: hash(bytes), domain: await domain(page), calls, imageReadCount: operations.filter(operation => operation.op === 'image-read').length }, null, 2));
});

for (const mode of ['none', 'conflict', 'activation', 'lazy', 'lazy-reject', 'transcript', 'layout', 'independent-transcript', 'independent-layout']) {
  test(`committed activity respects ${mode} selection and fallback ownership`, { timeout: 45_000 }, async t => {
    const artifact = await committed(), provider = await activityProvider(t);
    const { page, host } = await surface(t, artifact.assets, { kind: 'extensions' }, [provider.extension]);
    await open(page, host, mode);
    await wait(() => provider.clients.size === 1, 'lifecycle provider feed');
    const id = [...provider.saved.keys()][0];
    provider.emit(id, [command(), file()]);
    const native = page.getByText('printf activity', { exact: true });
    const count = () => page.evaluate(() => window.activityFixture.committed());
    const editor = page.getByRole('textbox', { name: 'Message', exact: true });
    await draft(page, 'Lifecycle draft');
    const original = await editor.elementHandle();
    if (['none', 'conflict', 'activation', 'lazy', 'lazy-reject', 'independent-transcript'].includes(mode)) {
      await native.waitFor();
      assert.equal(await count(), 0);
    }
    if (mode === 'conflict') {
      await page.getByRole('alert').filter({ hasText: 'Activity override conflict.' }).waitFor();
      assert.equal(await selected(page).count(), 0);
    } else if (mode === 'activation') {
      await page.evaluate(() => window.activityCompanion.activate());
      await selected(page).waitFor(); assert.equal(await count(), 1);
      assert.equal(await native.count(), 0);
    } else if (mode === 'lazy') {
      await page.evaluate(() => window.activityFixture.resolve());
      await selected(page).waitFor(); assert.equal(await count(), 1);
      assert.equal(await native.count(), 0);
    } else if (mode === 'lazy-reject') {
      await page.evaluate(() => window.activityFixture.reject());
      await page.getByRole('alert').filter({ hasText: 'Committed activity lazy rejected' }).waitFor();
      await native.waitFor(); assert.equal(await count(), 0);
    } else if (mode === 'transcript') {
      await page.getByText('Whole committed transcript', { exact: true }).waitFor();
      assert.equal(await count(), 0); assert.equal(await native.count(), 0);
      assert.equal(await selected(page).count(), 0);
    } else if (mode === 'independent-transcript') {
      await page.evaluate(() => window.activityCompanion.reject());
      await page.getByRole('alert').filter({ hasText: 'Independent transcript failed' }).waitFor();
      await selected(page).waitFor(); assert.equal(await count(), 1);
      assert.equal(await native.count(), 0);
    } else if (mode === 'layout' || mode === 'independent-layout') {
      await selected(page).waitFor(); assert.equal(await count(), 1);
      if (mode === 'layout') await page.getByRole('button', { name: 'Suspend activity layout', exact: true }).click();
      else await page.evaluate(() => window.activityCompanion.suspend());
      await page.getByRole('status').filter({ hasText: 'Content layout is loading.' }).waitFor();
      await native.waitFor();
      assert.equal(await count(), 1, 'fallback does not mount a second activity instance');
      assert.equal(await selected(page).isVisible(), false);
      if (mode === 'layout') await page.evaluate(() => window.resumeActivityLayout());
      else await page.evaluate(() => window.activityCompanion.resume());
      await selected(page).waitFor(); assert.equal(await count(), 1);
      if (mode === 'layout') await page.getByRole('button', { name: 'Fail activity layout', exact: true }).click();
      else await page.evaluate(() => window.activityCompanion.fail());
      await page.getByRole('alert').filter({ hasText: mode === 'layout' ? 'Committed activity layout failed' : 'Independent layout failed' }).waitFor();
      if (mode === 'layout') { await native.waitFor(); assert.equal(await count(), 0); }
      else { await selected(page).waitFor(); assert.equal(await count(), 1); }
    }
    assert.equal(await editor.inputValue(), 'Lifecycle draft');
    assert.equal(await editor.evaluate((node, original) => node === original, original), true);
    assert.equal(provider.requests.filter(request => request.path === '/submit').length, 0);
  });
}
