import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { chromium } from 'playwright';
import { createConnection } from 'node:net';
function requestControl(path, request) {
  return new Promise((resolve, reject) => {
    const socket = createConnection(path);
    let output = '';
    socket.setTimeout(5000, () => socket.destroy(new Error('Host control timed out')));
    socket.once('error', reject);
    socket.once('connect', () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on('data', chunk => { output += chunk; });
    socket.once('end', () => { try { resolve(JSON.parse(output)); } catch (error) { reject(error); } });
  });
}

const live = process.env.AGENTUI_PI_LIVE === '1';
const wait = async (predicate, label) => {
  const end = Date.now() + 90_000;
  while (!await predicate()) {
    if (Date.now() > end) throw new Error(`Timed out waiting for ${label}`);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
};

test('live OpenCode Go GLM 5.3 chat streams, remembers, reopens and stops through AgentUI', {
  skip: !live, timeout: 300_000,
}, async t => {
  const key = process.env.OPENCODE_GO_API_KEY;
  assert(key?.trim(), 'Load OPENCODE_GO_API_KEY in the host process before this test');
  const directory = await mkdtemp(join(tmpdir(), 'agentui-pi-live-'));
  const evidence = process.env.AGENTUI_PI_EVIDENCE_DIR;
  if (evidence) await mkdir(evidence, { recursive: true });
  const report = { provider: 'opencode-go', model: 'glm-5.3', sdk: '1.5.2', checks: [] };
  const root = fileURLToPath(new URL('../../', import.meta.url));
  let host;
  let browser;
  t.after(async () => {
    await browser?.close();
    await host?.close();
    await rm(directory, { recursive: true, force: true });
  });
  const open = async port => {
    const child = spawn(process.execPath, ['apps/host/dist/main.js', 'pi', '--data-dir', directory, '--workspace', directory, '--port', String(port)], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    const exited = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal })); });
    const lines = createInterface({ input: child.stdout });
    const info = await Promise.race([
      new Promise(resolve => lines.once('line', line => resolve(JSON.parse(line)))),
      exited.then(() => { throw new Error(`Pi host exited before startup. ${stderr.replaceAll(key, '[REDACTED]')}`); }),
    ]);
    lines.close();
    host = { ...info, async close() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill('SIGTERM');
      const deadline = setTimeout(() => child.kill('SIGKILL'), 10_000);
      try { assert.equal((await exited).code, 0, stderr.replaceAll(key, '[REDACTED]')); }
      finally { clearTimeout(deadline); }
    } };
    return host;
  };
  await open(0);
  const port = Number(new URL(host.origin).port);
  const env = { ...process.env };
  delete env.OPENCODE_GO_API_KEY;
  delete env.OPENCODE_API_KEY;
  browser = await chromium.launch({ env });
  const page = await browser.newPage();
  page.setDefaultTimeout(20_000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${host.origin}/browser.html`);
  const invite = await requestControl(join(directory, 'control.sock'), { op: 'invite' });
  assert.equal(invite.ok, true);
  await page.getByLabel('Pairing code').fill(invite.value.code);
  await page.getByRole('button', { name: 'Pair host', exact: true }).click();
  const newChat = page.getByRole('button', { name: 'New conversation', exact: true });
  await wait(() => newChat.isEnabled(), 'paired Pi host');
  await newChat.click();
  await wait(() => page.getByRole('status').first().textContent().then(text => text.includes('Conversation connected')), 'connected Pi conversation');
  const conversationId = await page.locator('.scope-label').textContent();
  const editor = page.getByRole('textbox', { name: 'Message', exact: true });
  const send = page.getByRole('button', { name: 'Send', exact: true });
  async function prompt(text) {
    await editor.fill(text);
    await wait(() => send.isEnabled(), 'saved prompt');
    await send.click();
  }
  const assistants = page.locator('.message-assistant');
  async function completed(count) {
    await wait(async () => await assistants.count() === count &&
      await page.locator('.progress-label').count() === 0 &&
      await page.getByRole('button', { name: 'Stop', exact: true }).count() === 0,
    `completed Pi response ${count}`);
    return assistants.nth(count - 1).locator('p').innerText();
  }
  await prompt('Remember the phrase silver orchard 629. Reply only with READY.');
  assert.match(await completed(1), /READY/);
  report.checks.push('first live response rendered');
  await prompt('What exact phrase did I ask you to remember? Reply only with the phrase.');
  assert.match(await completed(2), /silver orchard 629/i);
  report.checks.push('same-session follow-up memory');
  if (evidence) await page.screenshot({ path: join(evidence, 'pi-follow-up.png'), fullPage: true });
  await page.reload();
  await wait(async () => await assistants.count() === 2, 'reloaded transcript');
  assert.equal(await page.locator('.scope-label').textContent(), conversationId);
  report.checks.push('browser reload retained conversation');
  await host.close();
  host = undefined;
  await open(port);
  await page.reload();
  await wait(() => editor.isVisible(), 'reopened host conversation');
  assert.equal(await page.locator('.scope-label').textContent(), conversationId);
  await prompt('After the restart, what exact phrase did I ask you to remember? Reply only with the phrase.');
  assert.match(await completed(3), /silver orchard 629/i);
  report.checks.push('host restart resumed native journal with memory');
  await prompt('Print the integers from 1 through 10000, one per line, with no introduction. Continue until all 10000 are printed.');
  const stop = page.getByRole('button', { name: 'Stop', exact: true });
  await stop.waitFor();
  await wait(async () => await assistants.count() === 4 &&
    (await assistants.nth(3).locator('p').innerText()).length > 5, 'partial streamed Pi response');
  assert.equal(await send.isDisabled(), true);
  await stop.click();
  const partial = await completed(4);
  assert(partial.length > 5, 'Stop preserves streamed partial output');
  assert(!partial.includes('10000'), 'The requested long response was interrupted');
  report.checks.push('Stop retained partial text and blocked overlapping send');
  if (evidence) {
    await assistants.nth(3).scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(evidence, 'pi-stopped.png'), fullPage: true });
  }
  await host.close();
  host = undefined;
  const db = new DatabaseSync(join(directory, 'host.sqlite'));
  try {
    const row = db.prepare('SELECT document FROM conversations WHERE conversation=?').get(conversationId);
    const document = JSON.parse(row.document);
    assert.equal(document.domain.currentRun.kind, 'ended');
    assert.equal(document.domain.currentRun.outcome, 'interrupted');
    report.checks.push('native terminal outcome is interrupted');
  } finally { db.close(); }
  async function noSecrets(path) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const file = join(path, entry.name);
      if (entry.isDirectory()) await noSecrets(file);
      else if (entry.isFile()) assert(!(await readFile(file)).includes(Buffer.from(key)), 'Host files must not persist the provider credential');
    }
  }
  await noSecrets(directory);
  assert(!JSON.stringify(await page.evaluate(() => ({ local: { ...localStorage }, session: { ...sessionStorage } }))).includes(key));
  assert.deepEqual(errors, []);
  report.checks.push('credential absent from host files and browser web storage');
  if (evidence) await writeFile(join(evidence, 'result.json'), `${JSON.stringify(report, null, 2)}\n`);
});
