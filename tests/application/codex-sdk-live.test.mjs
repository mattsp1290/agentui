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
const live = process.env.AGENTUI_CODEX_SDK_LIVE === '1';
const wait = async (predicate, label) => {
  const end = Date.now() + 90_000;
  while (!await predicate()) {
    if (Date.now() > end) throw new Error(`Timed out waiting for ${label}`);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
};

test('live ChatGPT subscription GPT 6.1 Sol chat responds, remembers, reopens and stops through AgentUI', {
  skip: !live, timeout: 300_000,
}, async t => {
  const key = 'agentui-api-key-must-not-be-used';
  const directory = await mkdtemp(join(tmpdir(), 'agentui-codex-sdk-live-'));
  const evidence = process.env.AGENTUI_CODEX_SDK_EVIDENCE_DIR;
  if (evidence) await mkdir(evidence, { recursive: true });
  const artifact = JSON.parse(await readFile(new URL('../../apps/host/dist/artifact.json', import.meta.url), 'utf8'));
  const report = { provider: 'chatgpt-subscription', model: 'gpt-6.1-sol', sdk: '0.169.0',
    sourceRevision: artifact.sourceRevision, sourceDirty: artifact.sourceDirty, artifactId: artifact.artifactId, checks: [] };
  const root = fileURLToPath(new URL('../../', import.meta.url));
  let host;
  let browser;
  t.after(async () => {
    await browser?.close();
    await host?.close();
    await rm(directory, { recursive: true, force: true });
  });
  const open = async port => {
    const child = spawn(process.execPath, ['apps/host/dist/main.js', 'codex-sdk', '--data-dir', directory, '--workspace', directory, '--port', String(port)], { cwd: root, env: { ...process.env, OPENAI_API_KEY: key, CODEX_API_KEY: key }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    const exited = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal })); });
    const lines = createInterface({ input: child.stdout });
    const info = await Promise.race([
      new Promise(resolve => lines.once('line', line => resolve(JSON.parse(line)))),
      exited.then(() => { throw new Error(`Codex SDK host exited before startup. ${stderr.replaceAll(key, '[REDACTED]')}`); }),
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
  delete env.OPENAI_API_KEY;
  delete env.CODEX_API_KEY;
  delete env.ANTHROPIC_API_KEY;
  delete env.AGENTUI_ANTHROPIC_API_KEY;
  browser = await chromium.launch({ env });
  const page = await browser.newPage();
  page.setDefaultTimeout(20_000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${host.origin}/browser.html`);
  const newChat = page.getByRole('button', { name: 'New conversation', exact: true });
  await wait(() => newChat.isEnabled(), 'connected Codex SDK host');
  await newChat.click();
  await wait(() => page.getByRole('status').first().textContent().then(text => text.includes('Conversation connected')), 'connected Codex SDK conversation');
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
    `completed Codex SDK response ${count}`);
    return assistants.nth(count - 1).locator('p').innerText();
  }
  await prompt('Remember the phrase silver orchard 629. Reply only with READY.');
  assert.match(await completed(1), /READY/);
  report.checks.push('first live response rendered');
  await prompt('What exact phrase did I ask you to remember? Reply only with the phrase.');
  assert.match(await completed(2), /silver orchard 629/i);
  report.checks.push('same-session follow-up memory');
  if (evidence) await page.screenshot({ path: join(evidence, 'codex-sdk-follow-up.png'), fullPage: true });
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
  report.checks.push('host restart resumed native Codex thread with memory');
  await prompt('Print the integers from 1 through 10000, one per line, with no introduction. Continue until all 10000 are printed.');
  const stop = page.getByRole('button', { name: 'Stop', exact: true });
  await stop.waitFor();
  assert.equal(await send.isDisabled(), true);
  await stop.click();
  await wait(async () => await page.getByRole('button', { name: /^(?:Stop|Stopping…)$/ }).count() === 0, 'stopped native turn');
  report.checks.push('Stop interrupted active request and blocked overlapping send');
  if (evidence) {
    await page.screenshot({ path: join(evidence, 'codex-sdk-stopped.png'), fullPage: true });
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
