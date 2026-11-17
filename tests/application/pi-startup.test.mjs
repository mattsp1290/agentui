import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { chromium } from 'playwright';

const root = new URL('../../', import.meta.url);

function launch(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['apps/host/dist/main.js', ...args], {
      cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8').on('data', text => { stdout += text; });
    child.stderr.setEncoding('utf8').on('data', text => { stderr += text; });
    child.once('error', reject);
    child.once('exit', code => resolve({ code, stdout, stderr }));
  });
}

test('Pi requires a host-only OpenCode Go key before creating data or publishing a listener', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'agentui-pi-startup-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const env = { ...process.env };
  delete env.OPENCODE_GO_API_KEY;
  for (const token of [undefined, '', '   ']) {
    const data = join(directory, `data-${String(token).length}`);
    const result = await launch(['pi', '--workspace', directory, '--data-dir', data, '--port', '0'], {
      ...env, ...(token === undefined ? {} : { OPENCODE_GO_API_KEY: token }),
    });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /Set OPENCODE_GO_API_KEY in the host environment/);
    assert.equal(result.stdout, '');
    assert.equal(existsSync(data), false);
  }
});

for (const [args, expected] of [
  [['pi'], /Provide --workspace/],
  [['pi', '--workspace', '/fixture', '--port', 'invalid'], /Invalid listener port/],
  [['pi', '--workspace', '/fixture', '--model', 'opus'], /--model is not valid for pi/],
  [['pi', '--workspace', '/fixture', 'extra'], /Use serve, codex, pi, browser-dev/],
]) {
  test(`Pi rejects invalid command arguments ${args.join(' ')}`, async t => {
    const directory = mkdtempSync(join(tmpdir(), 'agentui-pi-args-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const data = join(directory, 'data');
    const result = await launch([...args, '--data-dir', data], { ...process.env, OPENCODE_GO_API_KEY: 'unused-test-key' });
    assert.equal(result.code, 1);
    assert.match(result.stderr, expected);
    assert.equal(result.stdout, '');
    assert.doesNotMatch(result.stderr, /unused-test-key/);
    assert.equal(existsSync(data), false);
  });
}

test('Pi startup advertises one runtime to browser and native clients and labels its chat-only UI', { timeout: 20_000 }, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'agentui-pi-ready-'));
  const data = join(directory, 'data');
  const token = 'unused-pi-startup-key';
  const env = { ...process.env, OPENCODE_GO_API_KEY: token };
  const child = spawn(process.execPath, ['apps/host/dist/main.js', 'pi', '--workspace', directory,
    '--data-dir', data, '--port', '0'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.setEncoding('utf8').on('data', text => { stderr += text; });
  const exited = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', code => resolve(code));
  });
  let browser;
  t.after(async () => {
    await browser?.close();
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      const timer = setTimeout(() => child.kill('SIGKILL'), 2000);
      try { await exited; } finally { clearTimeout(timer); }
    }
    rmSync(directory, { recursive: true, force: true });
  });
  const lines = createInterface({ input: child.stdout });
  const ready = await Promise.race([
    new Promise(resolve => lines.once('line', line => resolve(JSON.parse(line)))),
    exited.then(() => { throw new Error(`Pi host failed to start. ${stderr}`); }),
  ]);
  lines.close();
  assert.equal(ready.mode, 'pi');
  assert.doesNotMatch(JSON.stringify(ready), new RegExp(token));
  const call = (path, body, headers = {}) => new Promise((resolve, reject) => {
    const outgoing = request(`${ready.origin}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers } }, incoming => {
      let text = '';
      incoming.setEncoding('utf8').on('data', value => { text += value; });
      incoming.once('error', reject);
      incoming.once('end', () => resolve({ status: incoming.statusCode, headers: incoming.headers, body: JSON.parse(text) }));
    });
    outgoing.once('error', reject);
    outgoing.setTimeout(5000, () => outgoing.destroy(new Error('Pi host request timed out')));
    outgoing.end(JSON.stringify(body));
  });
  const runtime = { engine: 'pi', version: '1.5.2', format: 'pi-sdk-chat-opencode-go-glm-5.3-v1' };
  for (const client of [
    { path: '/api/v1', headers: { Origin: ready.origin }, conversationId: 'browser-pi' },
    { path: '/native/v1', headers: {}, conversationId: 'native-pi' },
  ]) {
    const metadata = await call(client.path, { op: 'metadata' }, client.headers);
    assert.equal(metadata.status, 200);
    assert.deepEqual(metadata.body.value.compatibility.nativeRuntime, runtime);
    assert.doesNotMatch(JSON.stringify(metadata.body), new RegExp(`${token}|OPENCODE_GO_API_KEY`));
    const scope = { hostId: ready.hostId, conversationId: client.conversationId };
    assert.deepEqual((await call(client.path, { op: 'create', scope, agentId: metadata.body.value.defaultAgentId }, client.headers)).body, { ok: true, value: scope });
  }
  const database = new DatabaseSync(join(data, 'host.sqlite'), { readOnly: true });
  try {
    const rows = database.prepare('SELECT installation FROM conversations ORDER BY conversation').all();
    assert.equal(rows.length, 2);
    for (const row of rows) {
      assert.deepEqual(JSON.parse(row.installation), { installationId: 'pi-opencode-go-glm-5-3-v1', binding: {
        engine: 'pi', nativeVersion: '1.5.2', nativeFormat: 'pi-sdk-chat-opencode-go-glm-5.3-v1',
        account: 'opencode-go:glm-5.3', authorizedScope: realpathSync(directory),
      } });
      assert.doesNotMatch(row.installation, new RegExp(token));
    }
  } finally { database.close(); }
  browser = await chromium.launch();
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${ready.origin}/browser.html`);
  await page.getByRole('button', { name: 'New conversation', exact: true }).click();
  await page.getByPlaceholder('Write to Pi…').waitFor();
  assert.match(await page.locator('.composer-footer').textContent(), /Pi · GLM 5.3 · OpenCode Go · Chat only · No tools/);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  assert.match(await page.locator('.application-status').textContent(), /Pi · GLM 5.3 · OpenCode Go/);
  assert.match(await page.getByRole('region', { name: 'Settings', exact: true }).textContent(), /Pi provides text chat without tools/);
  assert.deepEqual(errors, []);
  child.kill('SIGTERM');
  assert.equal(await exited, 0, stderr);
  assert.doesNotMatch(stderr, new RegExp(token));
});
