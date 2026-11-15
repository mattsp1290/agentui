import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { createConnection } from 'node:net';
import { chromium } from 'playwright';

const live = process.env.AGENTUI_CLAUDE_SDK_LIVE === '1';
const models = ['opus', 'sonnet'];
const root = fileURLToPath(new URL('../../', import.meta.url));

function requestControl(path, request) {
  return new Promise((resolve, reject) => {
    const socket = createConnection(path);
    let output = '';
    socket.setTimeout(5000, () => socket.destroy(new Error('Host control timed out')));
    socket.once('error', reject);
    socket.once('connect', () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on('data', chunk => { output += chunk; });
    socket.once('end', () => {
      try { resolve(JSON.parse(output)); }
      catch { reject(new Error('Host control returned invalid JSON')); }
    });
  });
}

async function wait(predicate, label) {
  const end = Date.now() + 90_000;
  while (!await predicate()) {
    if (Date.now() > end) throw new Error(`Timed out waiting for ${label}`);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

function withoutCredentials() {
  return Object.fromEntries(Object.entries(process.env).filter(([name]) =>
    !/(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i.test(name)));
}

function persisted(directory, conversationId) {
  const db = new DatabaseSync(join(directory, 'host.sqlite'), { readOnly: true });
  try {
    const row = db.prepare('SELECT document FROM conversations WHERE conversation=?').get(conversationId);
    assert(row, 'Conversation must be persisted');
    const runs = db.prepare('SELECT data FROM runs WHERE conversation=? ORDER BY rowid').all(conversationId)
      .map(value => JSON.parse(value.data));
    const actualModels = db.prepare("SELECT observation FROM commands WHERE conversation=? AND json_extract(intent, '$.body.kind')='send'")
      .all(conversationId).flatMap(value => {
        const model = value.observation === null ? undefined
          : JSON.parse(value.observation).evidence?.observation?.data?.model;
        return typeof model === 'string' ? [model] : [];
      });
    return { document: JSON.parse(row.document), runs, actualModels: [...new Set(actualModels)] };
  } finally { db.close(); }
}

async function noSecrets(path, key) {
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const file = join(path, entry.name);
    if (entry.isDirectory()) await noSecrets(file, key);
    else if (entry.isFile()) {
      assert(!(await readFile(file)).includes(Buffer.from(key)), 'Host files must not persist the provider credential');
    }
  }
}

for (const model of models) {
  test(`live Claude SDK ${model} chat responds, remembers, reopens and stops through AgentUI`, {
    skip: !live, timeout: 360_000,
  }, async t => {
    const key = process.env.AGENTUI_ANTHROPIC_API_KEY?.trim();
    assert(key?.trim(), 'Load AGENTUI_ANTHROPIC_API_KEY in the host process before this test');
    const redact = value => String(value).replaceAll(key, '[REDACTED]');
    const directory = await mkdtemp(join(tmpdir(), `agentui-claude-sdk-${model}-live-`));
    let browser;
    const children = [];
    t.after(async () => {
      try { await browser?.close(); }
      finally {
        try { await Promise.all(children.map(close => close(false))); }
        finally { await rm(directory, { recursive: true, force: true }); }
      }
    });
    const evidence = process.env.AGENTUI_CLAUDE_SDK_EVIDENCE_DIR
      ? join(process.env.AGENTUI_CLAUDE_SDK_EVIDENCE_DIR, model) : undefined;
    if (evidence) await mkdir(evidence, { recursive: true });
    const artifact = JSON.parse(await readFile(new URL('../../apps/host/dist/artifact.json', import.meta.url), 'utf8'));
    const report = {
      provider: 'claude-sdk', requestedModel: model,
      sourceRevision: artifact.sourceRevision, sourceDirty: artifact.sourceDirty,
      artifactId: artifact.artifactId, checks: [],
    };

    async function open(port) {
      const child = spawn(process.execPath, ['apps/host/dist/main.js', 'claude-sdk', '--model', model,
        '--data-dir', directory, '--workspace', directory, '--port', String(port)], {
        cwd: root, env: { ...withoutCredentials(), AGENTUI_ANTHROPIC_API_KEY: key },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stderr = '';
      child.stderr.setEncoding('utf8').on('data', chunk => { stderr = `${stderr}${redact(chunk)}`.slice(-16_384); });
      const exited = new Promise(resolve => {
        child.once('error', () => resolve({ code: null, signal: null, spawnFailed: true }));
        child.once('exit', (code, signal) => resolve({ code, signal, spawnFailed: false }));
      });
      let closing;
      function close(checkExit = true) {
        closing ??= (async () => {
          if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
          const deadline = setTimeout(() => child.kill('SIGKILL'), 10_000);
          try { return await exited; }
          finally { clearTimeout(deadline); }
        })();
        return closing.then(result => {
          if (checkExit) assert.equal(result.code, 0, `Claude SDK host failed to shut down. ${redact(stderr)}`);
        });
      }
      children.push(close);
      t.after(() => close(false));
      const lines = createInterface({ input: child.stdout });
      let deadline;
      try {
        const info = await Promise.race([
          new Promise((resolve, reject) => lines.once('line', line => {
            try {
              const ready = JSON.parse(line);
              assert.equal(new URL(ready.origin).hostname, '127.0.0.1');
              resolve(ready);
            } catch { reject(new Error('Claude SDK host returned invalid startup metadata')); }
          })),
          exited.then(() => { throw new Error(`Claude SDK host exited before startup. ${redact(stderr)}`); }),
          new Promise((_, reject) => {
            deadline = setTimeout(() => reject(new Error(`Claude SDK host startup timed out. ${redact(stderr)}`)), 30_000);
          }),
        ]);
        return { ...info, close };
      } catch (error) {
        await close(false);
        throw error;
      } finally {
        clearTimeout(deadline);
        lines.close();
        child.stdout.resume();
      }
    }

    let host = await open(0);
    const port = Number(new URL(host.origin).port);
    browser = await chromium.launch({ env: withoutCredentials() });
    const context = await browser.newContext();
    const page = await context.newPage();
    page.setDefaultTimeout(20_000);
    const errors = [];
    page.on('pageerror', error => errors.push(redact(error.message)));
    await page.goto(`${host.origin}/browser.html`);
    const invite = await requestControl(join(directory, 'control.sock'), { op: 'invite' });
    assert.equal(invite.ok, true);
    await page.getByLabel('Pairing code').fill(invite.value.code);
    await page.getByRole('button', { name: 'Pair host', exact: true }).click();
    const newChat = page.getByRole('button', { name: 'New conversation', exact: true });
    await wait(() => newChat.isEnabled(), 'paired Claude SDK host');
    await newChat.click();
    await wait(() => page.getByRole('status').first().textContent()
      .then(text => text.includes('Conversation connected')), 'connected Claude SDK conversation');
    const conversationId = await page.locator('.scope-label').textContent();
    report.conversationId = conversationId;
    const editor = page.getByRole('textbox', { name: 'Message', exact: true });
    const send = page.getByRole('button', { name: 'Send', exact: true });
    const assistants = page.locator('.message-assistant');
    async function prompt(text) {
      await editor.fill(text);
      await wait(() => send.isEnabled(), 'saved prompt');
      await send.click();
    }
    async function completed(count) {
      await wait(async () => await assistants.count() === count &&
        await page.locator('.progress-label').count() === 0 &&
        await page.getByRole('button', { name: 'Stop', exact: true }).count() === 0,
      `completed Claude SDK response ${count}`);
      return assistants.nth(count - 1).innerText();
    }

    const nonce = `memory-${model}-${randomUUID()}`;
    await prompt(`Remember the exact phrase ${nonce}. Reply only with READY.`);
    assert((await completed(1)).includes('READY'), 'First live response must acknowledge the memory request');
    report.checks.push('first live response rendered');
    await prompt('What exact phrase did I ask you to remember? Reply only with the phrase.');
    assert((await completed(2)).includes(nonce), 'Follow-up must recall the randomly generated phrase');
    report.checks.push('same-session follow-up memory');
    if (evidence) await page.screenshot({ path: join(evidence, 'follow-up.png'), fullPage: true });
    await page.reload();
    await wait(async () => await assistants.count() === 2, 'reloaded transcript');
    assert.equal(await page.locator('.scope-label').textContent(), conversationId);
    assert((await assistants.nth(1).innerText()).includes(nonce), 'Reload must retain the completed response');
    report.checks.push('browser reload retained conversation and transcript');

    await host.close();
    const beforeRestart = persisted(directory, conversationId);
    assert.equal(beforeRestart.runs.length, 2, 'Both completed turns must have native run references');
    const nativeSessionId = beforeRestart.runs[0].reference.opaque;
    assert.equal(typeof nativeSessionId, 'string');
    assert(nativeSessionId.length > 0, 'Native session ID must be nonempty');
    assert(beforeRestart.runs.every(run => run.reference.opaque === nativeSessionId), 'Follow-up must use the same native session');
    report.nativeSessionStable = true;
    host = await open(port);
    await page.reload();
    await wait(async () => await editor.isVisible() && await assistants.count() === 2, 'reopened host conversation');
    assert.equal(await page.locator('.scope-label').textContent(), conversationId);
    await prompt('After the restart, what exact phrase did I ask you to remember? Reply only with the phrase.');
    assert((await completed(3)).includes(nonce), 'Restarted host must recall the random phrase without another reminder');
    report.checks.push('host restart recalled native session memory');

    await prompt('Print the integers from 1 through 10000, one per line, with no introduction. Continue until all 10000 are printed.');
    const stop = page.getByRole('button', { name: 'Stop', exact: true });
    await stop.waitFor();
    assert.equal(await send.isDisabled(), true);
    await stop.click();
    await wait(async () => await page.getByRole('button', { name: /^(?:Stop|Stopping…)$/ }).count() === 0 &&
      await page.locator('.progress-label').count() === 0,
      'stopped native Claude turn');
    report.checks.push('Stop interrupted active request and blocked overlapping send');
    if (evidence) await page.screenshot({ path: join(evidence, 'stopped.png'), fullPage: true });
    await host.close();

    const afterRestart = persisted(directory, conversationId);
    assert.equal(afterRestart.runs.length, 4, 'Restart and Stop must each persist a native run');
    assert(afterRestart.runs.every(run => run.reference.opaque === nativeSessionId), 'Host restart must resume the same native session');
    report.checks.push('persisted native session ID remained unchanged across host restart');
    assert(afterRestart.actualModels.length > 0, 'Native acknowledgements must identify the actual model');
    assert(afterRestart.actualModels.every(value => value.includes(model) && !value.includes(key)),
      'Observed Claude model must match the requested model family');
    report.actualModels = afterRestart.actualModels;
    report.checks.push('native acknowledgement reported the selected model family');
    assert.equal(afterRestart.document.domain.currentRun.kind, 'ended');
    assert.equal(afterRestart.document.domain.currentRun.outcome, 'interrupted');
    report.checks.push('persisted native terminal outcome is interrupted');
    host = await open(port);
    await page.reload();
    await wait(() => editor.isVisible(), 'conversation after Stop');
    const nextResponse = await assistants.count() + 1;
    await prompt('What exact phrase did I ask you to remember before the interrupted response? Reply only with the phrase.');
    assert((await completed(nextResponse)).includes(nonce), 'Native session must remain resumable after Stop');
    await host.close();
    const continued = persisted(directory, conversationId);
    assert.equal(continued.runs.length, 5);
    assert(continued.runs.every(run => run.reference.opaque === nativeSessionId));
    report.checks.push('same native session resumed with memory after Stop and another host restart');
    await noSecrets(directory, key);
    const browserStorage = {
      state: await context.storageState({ indexedDB: true }),
      session: await page.evaluate(() => ({ ...sessionStorage })),
    };
    assert(!JSON.stringify(browserStorage).includes(key), 'Browser storage must not contain the provider credential');
    assert.equal(errors.length, 0, `Browser must not report page errors. ${errors.join('\n')}`);
    report.checks.push('credential absent from host files and browser storage');
    if (evidence) await writeFile(join(evidence, 'result.json'), `${JSON.stringify(report, null, 2)}\n`);
  });
}
