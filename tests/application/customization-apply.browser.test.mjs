import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { chromium } from 'playwright';
import { startCustomizationWorker } from '../../scripts/agentui-customization-worker.mjs';
import { customizationFixtureFiles, fixtureConnection } from '../support/customization-fixture.mjs';
import { seedRemote } from '../support/customization-session.mjs';
import { draft, root } from './browser-support.mjs';

const ALPHA = 'AGENTUI_EXTENSION_ALPHA_TOKEN', BETA = 'AGENTUI_EXTENSION_BETA_TOKEN';
const until = async (predicate, label, timeout = 300_000) => {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
};

/**
 * A host started by the real session wrapper, the way the launcher starts it, with a real worker in this process, a local
 * bare remote and real builds of the dependency-free fixture. Every directory is temporary.
 */
async function session(t) {
  const directory = await mkdtemp(join(tmpdir(), 'agentui-apply-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { remote, git, gitEnvironment, home } = await seedRemote(directory, customizationFixtureFiles());
  const data = join(directory, 'data');
  await mkdir(data, { mode: 0o700 });
  const port = await new Promise(resolve => { const server = createServer().listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolve(port)); }); });
  const origin = `http://127.0.0.1:${port}`;
  // A temporary HOME: the host and its Pi setup never read or write the real one.
  const environment = { ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('AGENTUI_EXTENSION_'))), HOME: home };
  const workspace = join(directory, 'workspace');
  await mkdir(workspace);
  // The launcher's own host command line for a Pi session.
  const wrapper = spawn(process.execPath, [join(root, 'scripts/agentui-launch-session.mjs'), process.execPath, join(root, 'apps/host/dist/main.js'), 'desktop',
    '--preferred', 'pi', '--workspace', workspace, '--data-dir', data, '--assets', join(root, 'apps/desktop/web-dist-browser'), '--port', String(port)],
    { cwd: root, env: environment, stdio: ['pipe', 'pipe', 'pipe'] });
  let output = '', errors = '';
  wrapper.stdout.on('data', chunk => { output += chunk; });
  wrapper.stderr.on('data', chunk => { errors += chunk; });
  const closed = new Promise(resolve => wrapper.once('close', resolve));
  const tokens = { [ALPHA]: 'alpha-test-token', [BETA]: 'beta-test-token' };
  wrapper.stdin.write(`${JSON.stringify({ OPENCODE_GO_API_KEY: null, AGENTUI_SETUP_CAPABILITY: randomBytes(32).toString('hex'), extensionVariables: tokens })}\n`);
  const controller = new AbortController();
  let worker;
  t.after(async () => { controller.abort(); await worker?.stopped; wrapper.stdin.end(); await closed; });
  await until(() => output.includes('"hostId"'), 'host ready', 30_000).catch(error => { throw new Error(`${error.message}\n${errors}`); });
  worker = startCustomizationWorker({ origin, localSetupRoot: join(directory, 'setup'), repositoryRoot: root, signal: controller.signal, gitEnvironment,
    environment: tokens, pushIntervalMs: 500, profileId: 'browser-test' });
  const call = async body => {
    const response = await fetch(`${origin}/api/v1`, { method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify(body) });
    const reply = await response.json();
    if (!reply.ok) throw new Error(reply.error.message);
    return reply.value;
  };
  const status = () => call({ op: 'customization-status' });
  const mutate = async (op, fields = {}) => {
    const requestId = randomUUID();
    const reply = await call({ op: `customization-${op}`, requestId, ...fields });
    if (reply.kind !== 'accepted') return { refused: reply.cause };
    return (await until(async () => (await status()).results.find(item => item.requestId === requestId), `${op} result`, 120_000)).outcome;
  };
  const agents = async () => (await call({ op: 'metadata' })).agents.map(agent => agent.label);
  return { origin, data, remote, git, call, status, mutate, agents, output: () => output, errors: () => errors };
}

async function applyFromPage(page, s, buildKey) {
  await page.getByRole('navigation', { name: 'Workspace views' }).getByRole('button', { name: 'Extensions', exact: true }).click();
  const apply = page.getByRole('button', { name: 'Apply and restart' });
  await until(() => apply.isVisible(), 'the apply button', 60_000);
  await apply.click();
  // The page reconnects by itself and reloads once, when the restarted host serves the applied build.
  await until(async () => (await s.status().catch(() => null))?.running.buildKey === buildKey, 'the host running the applied build', 120_000);
}
async function pickerAgents(page) {
  await page.getByRole('button', { name: /^Harness, / }).first().click();
  await page.getByRole('button', { name: /^Provider/ }).click();
  const options = page.getByRole('dialog', { name: 'Choose model' }).locator('.composer-picker-option');
  const names = await options.evaluateAll(buttons => buttons.map(button => button.getAttribute('aria-label')));
  await page.keyboard.press('Escape');
  return names;
}

test('apply restarts the host through the wrapper; the page reconnects and reloads by itself, and a disabled extension’s agent is gone', { timeout: 900_000 }, async t => {
  const s = await session(t);
  await until(async () => (await s.status()).support === 'supported', 'worker online', 30_000);
  assert.equal(await s.mutate('connect', fixtureConnection(s.remote)), 'ok');
  const first = await until(async () => { const build = (await s.status()).build; return build?.state === 'ready' ? build : build?.state === 'failed' ? assert.fail(JSON.stringify(build)) : null; }, 'first build');
  assert.deepEqual(first.namespaces, ['alpha', 'beta']);
  assert.equal((await s.agents()).some(label => /fixture agent/u.test(label)), false);

  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await (await browser.newContext()).newPage();
  page.setDefaultTimeout(30_000);
  let loads = 0;
  page.on('load', () => { loads++; });
  await page.goto(`${s.origin}/browser.html`);
  await applyFromPage(page, s, first.buildKey);
  await until(() => loads === 2, 'one reload', 60_000);
  assert.deepEqual((await s.agents()).filter(label => /fixture agent/u.test(label)).sort(), ['alpha fixture agent', 'beta fixture agent']);

  // A conversation with the applied extension's agent, and a draft typed in it before the next apply.
  await page.getByRole('navigation', { name: 'Workspace views' }).getByRole('button', { name: 'Chats', exact: true }).click();
  await until(async () => (await pickerAgents(page)).some(name => /alpha fixture agent/u.test(name)), 'the picker after the reload', 30_000);
  await page.getByRole('button', { name: /^Harness, / }).first().click();
  await page.getByRole('button', { name: /^Provider/ }).click();
  await page.getByRole('button', { name: 'Start new chat with alpha fixture agent' }).click();
  await page.locator('#message').waitFor();
  const text = `kept across the restart ${randomBytes(4).toString('hex')}`;
  await draft(page, text);

  // Turn beta off: one commit on the remote, a new build, then apply from the page again.
  const head = (await s.status()).head;
  assert.equal(await s.mutate('toggle', { key: 'ext/beta', enabled: false, expectedHead: head }), 'ok');
  assert.match(s.git(s.remote, 'log', '-1', '--format=%s', 'customization'), /^Disable ext\/beta extension$/u);
  const second = await until(async () => { const build = (await s.status()).build; return build?.state === 'ready' && build.buildKey !== first.buildKey ? build : null; }, 'second build');
  assert.deepEqual(second.namespaces, ['alpha']);
  await applyFromPage(page, s, second.buildKey);
  await until(() => loads === 3, 'the second reload', 60_000);
  assert.deepEqual((await s.agents()).filter(label => /fixture agent/u.test(label)), ['alpha fixture agent']);
  await page.getByRole('navigation', { name: 'Workspace views' }).getByRole('button', { name: 'Chats', exact: true }).click();
  await until(async () => await page.getByRole('textbox', { name: 'Message', exact: true }).inputValue().catch(() => '') === text, 'the draft after the reload', 30_000);
  const picker = await pickerAgents(page);
  assert.ok(picker.some(name => /alpha fixture agent/u.test(name)), picker.join());
  assert.equal(picker.some(name => /beta fixture agent/u.test(name)), false);
  assert.equal(loads, 3, 'each apply reloads exactly once');
  assert.doesNotMatch(s.output(), /alpha-test-token|beta-test-token/u);
});
