#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('../', import.meta.url));
const defaults = ['local', 'lunus@100.102.195.3', 'infra-admin@100.82.43.93', 'punk1290@100.69.236.34'];
const options = { targets: [], output: resolve(root, '.audit/single-user-launch/live'), workspace: undefined };
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  const flag = args[i];
  if (flag === '--help') {
    process.stdout.write('Usage: node scripts/verify-agentui-launch.mjs [--target local|USER@HOST]... [--workspace PATH] [--output DIRECTORY]\nRuns real Pi GLM 5.3 chats and verifies history after restarting each launcher. Build first with ./agentui.\n');
    process.exit(0);
  }
  if (!['--target', '--workspace', '--output'].includes(flag) || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`Invalid argument: ${flag}`);
  const value = args[++i];
  if (flag === '--target') options.targets.push(value);
  if (flag === '--workspace') options.workspace = value;
  if (flag === '--output') options.output = resolve(value);
}
if (!options.targets.length) options.targets = defaults;

const abort = new AbortController();
let activeLauncher;
let browser;
const results = [];
function checkAbort() { if (abort.signal.aborted) throw new Error('Verification interrupted'); }
async function waitFor(check, label, timeout = 120_000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    checkAbort();
    if (activeLauncher?.child.exitCode !== null || activeLauncher?.child.signalCode !== null) {
      throw new Error(`Launcher stopped while waiting for ${label}. ${activeLauncher?.tail ?? ''}`);
    }
    if (await check()) return;
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise(done => setTimeout(done, 100));
  }
}
function launch(target, logPath) {
  const launchArgs = ['--skip-build', '--no-open', '--agent', 'pi'];
  if (target !== 'local') launchArgs.push('--ssh', target);
  if (options.workspace) launchArgs.push('--workspace', options.workspace);
  const child = spawn(join(root, 'agentui'), launchArgs, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  const log = createWriteStream(logPath);
  let tail = '', lines = '', resolveReady, rejectReady, stopped;
  const ready = new Promise((resolveReadyValue, rejectReadyValue) => { resolveReady = resolveReadyValue; rejectReady = rejectReadyValue; });
  const timer = setTimeout(() => rejectReady(new Error(`Launcher readiness timed out. ${tail}`)), 600_000);
  const exited = new Promise(done => {
    child.once('error', error => { clearTimeout(timer); rejectReady(error); done({ error }); });
    child.once('close', (code, signal) => {
      clearTimeout(timer); log.end();
      rejectReady(new Error(`Launcher exited before readiness (${code ?? signal}). ${tail}`));
      done({ code, signal });
    });
  });
  function record(stream, data) {
    const text = data.toString();
    log.write(`[${stream}] ${text}`);
    tail = (tail + text).slice(-32_000);
    if (stream !== 'stdout') return;
    lines += text;
    let end;
    while ((end = lines.indexOf('\n')) !== -1) {
      const line = lines.slice(0, end); lines = lines.slice(end + 1);
      let value;
      try { value = JSON.parse(line); } catch { continue; }
      if (value?.event !== 'ready') continue;
      if (typeof value.url !== 'string' || !/^http:\/\/127\.0\.0\.1:\d+\/browser\.html$/.test(value.url)) {
        rejectReady(new Error('Launcher returned an invalid client URL')); continue;
      }
      clearTimeout(timer); resolveReady(value);
    }
  }
  child.stdout.on('data', data => record('stdout', data));
  child.stderr.on('data', data => record('stderr', data));
  return {
    child, ready, get tail() { return tail; },
    stop() {
      stopped ??= (async () => {
        clearTimeout(timer);
        if (child.exitCode !== null || child.signalCode !== null) return;
        child.kill('SIGTERM');
        const kill = setTimeout(() => child.kill('SIGKILL'), 20_000);
        try { await exited; } finally { clearTimeout(kill); }
      })();
      return stopped;
    },
  };
}
async function openClient(info) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1050 } });
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);
  await page.goto(info.url, { waitUntil: 'domcontentloaded' });
  const button = page.getByRole('button', { name: 'New conversation', exact: true });
  await waitFor(() => button.isEnabled(), 'ready Pi client');
  assert.equal(await page.getByLabel('Pairing code', { exact: true }).count(), 0, 'client must not require pairing');
  assert.equal(await page.getByRole('heading', { name: 'Connect this Mac', exact: true }).count(), 0, 'client must not enter Keychain enrollment');
  const origin = new URL(info.url).origin;
  const response = await context.request.post(`${origin}/api/v1`, { data: { op: 'metadata' }, headers: { Origin: origin } });
  assert.equal(response.status(), 200, 'fresh client metadata must work without a pairing cookie');
  const metadata = await response.json();
  assert.equal(metadata.ok, true);
  assert.equal(metadata.value.compatibility.nativeRuntime.engine, 'pi', 'verification requires real Pi mode');
  assert.equal(metadata.value.compatibility.nativeRuntime.format, 'pi-sdk-chat-opencode-go-glm-5.3-v1', 'verification requires the GLM 5.3 model');
  assert.deepEqual(await context.cookies(), [], 'trusted client must not need or receive a pairing cookie');
  return { context, page, metadata: metadata.value };
}
async function send(page, token, count, prompt = `Reply with exactly ${token} and nothing else. Do not use tools or inspect files.`) {
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill(prompt);
  const button = page.getByRole('button', { name: 'Send', exact: true });
  await waitFor(() => button.isEnabled(), 'saved message draft');
  await button.click();
  const replies = page.locator('.message-assistant');
  await waitFor(async () => {
    if (await replies.count() !== count) return false;
    const reply = replies.last();
    const complete = await reply.locator('.progress-label').count() === 0 && await page.getByRole('button', { name: 'Stop', exact: true }).count() === 0;
    if (!complete) return false;
    assert.equal((await reply.locator('.assistant-reply').innerText()).trim(), token, 'Pi returned a different or failed final response');
    return true;
  }, `completed assistant reply ${token}`);
}
async function openSavedConversation(page, conversationId) {
  const button = page.getByRole('button', { name: new RegExp(`Open conversation ${conversationId}$`) });
  for (let n = 0; !await button.count(); n++) {
    const more = page.getByRole('button', { name: 'More conversations', exact: true });
    assert.ok(n < 100 && await more.count(), `Saved conversation ${conversationId} is missing from the host catalog`);
    await more.click();
  }
  await button.click();
  await page.getByRole('textbox', { name: 'Message', exact: true }).waitFor();
  assert.equal((await page.locator('.scope-label').innerText()).trim(), conversationId);
}
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
  abort.abort();
  void activeLauncher?.stop();
  void browser?.close();
});

await mkdir(options.output, { recursive: true });
try {
  const browserEnvironment = { ...process.env };
  delete browserEnvironment.OPENCODE_GO_API_KEY;
  browser = await chromium.launch({ env: browserEnvironment });
  for (const target of options.targets) {
    checkAbort();
    const slug = target.replace(/[^a-zA-Z0-9_.-]/g, '_');
    const result = { target, status: 'NOT VERIFIED', startedAt: new Date().toISOString() };
    results.push(result);
    let session;
    try {
      process.stdout.write(`Verifying ${target}\n`);
      activeLauncher = launch(target, join(options.output, `${slug}-start.log`));
      const info = await activeLauncher.ready;
      result.launch = info;
      session = await openClient(info);
      result.runtime = session.metadata.compatibility.nativeRuntime;
      result.hostId = session.metadata.hostId;
      const token = `AGENTUI_VERIFY_${randomBytes(6).toString('hex').toUpperCase()}`;
      result.token = token;
      await session.page.getByRole('button', { name: 'New conversation', exact: true }).click();
      await session.page.getByRole('textbox', { name: 'Message', exact: true }).waitFor();
      result.conversationId = (await session.page.locator('.scope-label').innerText()).trim();
      await send(session.page, token, 1);
      const followup = `${token}_FOLLOWUP`;
      await send(session.page, followup, 2);
      await session.page.screenshot({ path: join(options.output, `${slug}-chat.png`), fullPage: true });
      await session.context.close(); session = undefined;
      await activeLauncher.stop();
      activeLauncher = launch(target, join(options.output, `${slug}-restart.log`));
      const restarted = await activeLauncher.ready;
      assert.equal(restarted.url, info.url, 'restart must preserve the client origin');
      assert.equal(restarted.dataDir, info.dataDir, 'restart must preserve the host data directory');
      session = await openClient(restarted);
      assert.equal(session.metadata.hostId, result.hostId, 'restart must preserve host identity');
      await openSavedConversation(session.page, result.conversationId);
      await waitFor(async () => {
        const replies = await session.page.locator('.message-assistant .assistant-reply').allInnerTexts();
        return replies.length === 2 && replies[0].trim() === token && replies[1].trim() === followup;
      }, 'both completed replies after host restart');
      await send(session.page, token, 3, 'Repeat the first exact token I requested earlier, nothing else. Do not use tools or inspect files.');
      await session.page.screenshot({ path: join(options.output, `${slug}-restored.png`), fullPage: true });
      result.status = 'VERIFIED';
      result.checks = ['no pairing', 'real Pi GLM 5.3 reply', 'follow-up reply', 'stable client origin', 'host identity and history after restart', 'Pi session recalls the first token after restart'];
      process.stdout.write(`VERIFIED ${target}, conversation ${result.conversationId}\n`);
    } catch (error) {
      result.error = error instanceof Error ? error.message : String(error);
      if (session) await session.page.screenshot({ path: join(options.output, `${slug}-failure.png`), fullPage: true }).catch(() => {});
      process.stderr.write(`NOT VERIFIED ${target}: ${result.error}\n`);
      process.exitCode = 1;
    } finally {
      await session?.context.close().catch(() => {});
      await activeLauncher?.stop(); activeLauncher = undefined;
      result.finishedAt = new Date().toISOString();
      await writeFile(join(options.output, 'results.json'), `${JSON.stringify({ generatedAt: new Date().toISOString(), results }, null, 2)}\n`);
    }
  }
} finally {
  await activeLauncher?.stop();
  await browser?.close();
}
if (abort.signal.aborted) process.exitCode = 130;
