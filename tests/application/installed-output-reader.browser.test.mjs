import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, readFileSync, rmSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { chromium } from 'playwright';
import { createBrowserConnection } from '@agentui/client/service';
import { EXTENSION_SDK_VERSION } from '@agentui/sdk';
import { startBrowserHost } from '../../apps/host/build/tsc/server.js';
import { instance } from '../../examples/generated-text-output/dist/model.js';
import { repository, buildCustom, root } from '../customization/build/support.mjs';
import { connected, draft, wait } from './browser-support.mjs';

const record = value => { if (process.env.AGENTUI_OUTPUT_AUDIT_RESOURCES) appendFileSync(process.env.AGENTUI_OUTPUT_AUDIT_RESOURCES, `${JSON.stringify(value)}\n`); };

for (const rejected of [false, true]) test(`committed authored reader uses normal report HTTP with exact owned bytes and retired ${rejected ? 'error' : 'result'} suppression`, { timeout: 120_000 }, async () => {
  const custom = repository(), directory = mkdtempSync(join(tmpdir(), 'agentui-authored-output-'));
  record({ kind: 'temporary-directory', path: custom.directory, pid: process.pid });
  record({ kind: 'temporary-directory', path: directory, pid: process.pid });
  const previous = process.env.AGENTUI_REPORT_DATABASE;
  process.env.AGENTUI_REPORT_DATABASE = join(directory, 'reports.sqlite');
  let host, browser;
  try {
    custom.write('desktop/index.tsx', readFileSync(join(root, 'tests/application/fixtures/output-reader.tsx'), 'utf8'));
    const commit = custom.commit();
    custom.write('desktop/index.tsx', 'throw new Error("Dirty working file must not load");');
    const build = JSON.parse(buildCustom(custom, commit).trim().split('\n').at(-1));
    record({ kind: 'authored-artifact', commit, build, sourceSha256: createHash('sha256').update(readFileSync(join(root, 'tests/application/fixtures/output-reader.tsx'))).digest('hex'),
      manifest: JSON.parse(readFileSync(join(build.directory, 'artifact.json'), 'utf8')), identity: JSON.parse(readFileSync(join(build.directory, 'customization-identity.json'), 'utf8')) });
    host = await startBrowserHost({ directory: join(directory, 'host'), port: 0, agentStartup: { kind: 'extensions' },
      assetsDirectory: join(custom.directory, 'browser'), hostArtifactDirectory: join(root, 'apps/host/dist'),
      extensions: { kind: 'transient', entries: [{ kind: 'installed', directory: join(root, 'examples/generated-text-output'),
        manifest: { namespace: 'reports', trust: 'full', sdkVersion: EXTENSION_SDK_VERSION, entries: [{ kind: 'server', module: './dist/server.js' }] },
        installations: [{ id: 'reports', instance, service: 'http://127.0.0.1:1', expectedAuthority: 'remote-provider', authentication: { kind: 'unauthenticated' } }] }] } });
    record({ kind: 'listener', origin: host.origin, pid: process.pid });
    const operations = [], client = createBrowserConnection({ fetch: (path, init) => {
      operations.push({ path, op: JSON.parse(init.body).op });
      return fetch(host.origin + path, { ...init, headers: { ...init.headers, Origin: host.origin } });
    } });
    const scope = { hostId: host.hostId, conversationId: 'authored-reports' };
    await client.create(scope, (await client.metadata()).defaultAgentId);
    browser = await chromium.launch(); const page = await browser.newPage(); page.setDefaultTimeout(15_000);
    const browserOperations = [], errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => { if (new URL(request.url()).pathname === '/api/v1') browserOperations.push(request.postDataJSON()); });
    await page.goto(`${host.origin}/browser.html?automatic`);
    await page.getByRole('button', { name: 'Chats', exact: true }).click();
    await page.locator('.conversation-catalog button').click();
    await connected(page);
    const status = page.getByTestId('output-status');
    await status.filter({ hasText: '0 outputs' }).waitFor();
    const autoCount = browserOperations.filter(request => request.op === 'output-list').length;
    const reader = await page.evaluateHandle(() => window.outputProbe.current);
    const module = await page.getByTestId('reports').elementHandle();
    await draft(page, 'Protected authored draft');
    const editor = await page.getByRole('textbox', { name: 'Message', exact: true }).elementHandle();
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.evaluate(() => window.outputProbe.rerender());
    await page.waitForFunction(() => document.querySelector('[data-testid="reports"]').dataset.revision === '1');
    assert.equal(browserOperations.filter(request => request.op === 'output-list').length, autoCount);
    assert.equal(await page.evaluate(old => window.outputProbe.current === old, reader), true);
    const text = '\ufeffReport é🐦\n\r\t\u0000', commandId = randomUUID();
    const send = (text, clientCommandId = randomUUID()) => client.conversation(scope).submit({ version: 1, scope, clientCommandId, body: { kind: 'send', text } });
    const first = await send(text, commandId);
    assert.equal(first.receipt.state.kind, 'completed');
    assert.equal(browserOperations.filter(request => request.op === 'output-list').length, autoCount);
    await page.getByRole('button', { name: 'List outputs', exact: true }).click();
    await status.filter({ hasText: '1 outputs' }).waitFor();
    const outputId = await page.evaluate(() => window.outputProbe.results.at(-1).outputs[0].outputId);
    await page.getByRole('button', { name: 'Read output', exact: true }).click();
    await status.filter({ hasText: 'bytes' }).waitFor();
    assert.deepEqual(await page.evaluate(() => Array.from(window.outputProbe.results.at(-1).bytes)), Array.from(new TextEncoder().encode(text)));
    await page.evaluate(() => { window.outputProbe.results.at(-1).bytes.fill(0); });
    await page.getByRole('button', { name: 'Read output', exact: true }).click();
    await wait(async () => await page.evaluate(() => window.outputProbe.results.filter(result => 'bytes' in result).length) === 2, 'second owned byte read');
    assert.deepEqual(await page.evaluate(() => Array.from(window.outputProbe.results.at(-1).bytes)), Array.from(new TextEncoder().encode(text)));
    const beforeCommand = browserOperations.filter(request => request.op === 'output-list').length;
    await page.getByRole('button', { name: 'Authored send', exact: true }).click();
    await page.getByRole('status', { name: 'Authored send status', exact: true }).filter({ hasText: 'Command completed.' }).waitFor();
    assert.equal(browserOperations.filter(request => request.op === 'output-list').length, beforeCommand);
    if (process.env.AGENTUI_OUTPUT_AUDIT_RESOURCES) await page.screenshot({ path: process.env.AGENTUI_OUTPUT_AUDIT_RESOURCES + (rejected ? '.rejected.png' : '.resolved.png') });
    const beforeSuspension = browserOperations.filter(request => request.op === 'output-list').length;
    await page.getByRole('button', { name: 'Suspend layout', exact: true }).click();
    await page.getByText('Content layout is loading. Module actions will return when it is ready.', { exact: true }).waitFor();
    await page.evaluate(() => window.outputProbe.resume());
    await status.filter({ hasText: 'bytes' }).waitFor();
    assert.equal(await page.getByTestId('reports').evaluate((node, old) => node === old, module), true);
    assert.equal(await page.evaluate(old => window.outputProbe.current === old, reader), true);
    assert.equal(browserOperations.filter(request => request.op === 'output-list').length, beforeSuspension);
    assert.equal(await page.getByRole('textbox', { name: 'Message', exact: true }).evaluate((node, old) => node === old, editor), true);
    assert.equal(await page.getByRole('textbox', { name: 'Message', exact: true }).inputValue(), 'Protected authored draft');
    let release, entered;
    const admission = new Promise(resolve => { entered = resolve; });
    const held = new Promise(resolve => { release = resolve; });
    await page.route('**/api/v1', async route => {
      if (route.request().postDataJSON().op !== 'output-read') return route.continue();
      const response = await route.fetch(); entered(); await held; if (rejected) await route.abort('failed'); else await route.fulfill({ response });
    });
    const settlements = await page.evaluate(() => window.outputProbe.settlements);
    await page.getByRole('button', { name: 'Read output', exact: true }).click(); await admission;
    await page.evaluate(() => window.outputProbe.fail());
    await page.getByRole('alert').filter({ hasText: 'Authored layout failed' }).waitFor();
    release();
    await page.waitForFunction(count => window.outputProbe.settlements > count, settlements);
    assert.equal(await page.getByTestId('reports').count(), 0);
    await page.unroute('**/api/v1');
    const retained = await page.evaluate(async reader => (await reader.list()).kind, reader);
    assert.equal(retained, 'available');
    assert.equal(await page.getByRole('textbox', { name: 'Message', exact: true }).evaluate((node, old) => node === old, editor), true);
    for (let index = 2; index < 33; index++) assert.equal((await send(`report ${index}`)).receipt.state.kind, 'completed');
    assert.deepEqual(await page.evaluate(async ([reader, id]) => reader.read(id), [reader, outputId]), { kind: 'missing', reason: 'output-missing' });
    const ids = (await client.conversationOutputs(scope)).outputs.map(row => row.outputId);
    assert.deepEqual(await send(text, commandId), first);
    assert.deepEqual(await client.reconcile(scope, commandId), first.receipt);
    assert.deepEqual((await client.conversationOutputs(scope)).outputs.map(row => row.outputId), ids);
    assert.ok(operations.every(request => request.path === '/api/v1'));
    assert.ok(browserOperations.some(request => request.op === 'output-list'));
    assert.ok(browserOperations.some(request => request.op === 'output-read'));
    assert.equal(browserOperations.some(request => /credential|secret|token/i.test(JSON.stringify(request))), false);
    assert.equal(errors.some(message => !message.includes('Authored layout failed')), false);
    record({ kind: 'observations', sdk: EXTENSION_SDK_VERSION, operations, browserOperations, exactBytes: Array.from(new TextEncoder().encode(text)), errors });
    await page.close();
  } finally {
    if (browser) await browser.close();
    if (host) await host.close();
    if (previous === undefined) delete process.env.AGENTUI_REPORT_DATABASE; else process.env.AGENTUI_REPORT_DATABASE = previous;
    rmSync(custom.directory, { recursive: true, force: true }); rmSync(directory, { recursive: true, force: true });
    record({ kind: 'cleanup', paths: [custom.directory, directory], browserConnected: browser?.isConnected() ?? false });
  }
});
