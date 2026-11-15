import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { CODEX_RUNTIME } from '@agentui/contracts/compatibility';

const root = new URL('../../', import.meta.url);
async function until(predicate) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail('Timed out waiting for fixture state');
}
function alive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}

test('Codex startup gives browser and native conversations the same runtime and workspace installation', { timeout: 20_000 }, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'agentui-native-codex-'));
  const workspace = join(directory, 'workspace'), bin = join(directory, 'bin');
  mkdirSync(workspace); mkdirSync(bin);
  const pidPath = join(directory, 'codex-pids.jsonl'), logPath = join(directory, 'rpc.jsonl');
  const fixturePath = join(directory, 'codex-agent.mjs');
  copyFileSync(new URL('../host/fixtures/codex-agent.mjs', import.meta.url), fixturePath);
  writeFileSync(join(bin, 'codex'), `#!${process.execPath}
import assert from 'node:assert/strict';
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(pidPath)}, JSON.stringify({ pid: process.pid, args }) + '\\n');
if (args.length === 1 && args[0] === '--version') {
  process.stdout.write(${JSON.stringify(`codex-cli ${CODEX_RUNTIME.version}\n`)});
} else {
  assert.deepEqual(args, ['app-server', '--stdio']);
  process.argv = [process.execPath, ${JSON.stringify(fixturePath)}, ${JSON.stringify(logPath)}];
  await import(pathToFileURL(${JSON.stringify(fixturePath)}).href);
}
`, { mode: 0o700 });
  const records = path => existsSync(path) ? readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
  const children = [];
  const launch = args => {
    const child = spawn(process.execPath, ['apps/host/dist/main.js', ...args, '--data-dir', join(directory, 'data')], {
      cwd: root, env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '', stdout = '';
    child.stderr.setEncoding('utf8').on('data', value => { stderr += value; });
    child.stdout.setEncoding('utf8').on('data', value => { stdout += value; });
    const exited = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => resolve({ code, signal }));
    });
    const result = { child, exited, get stderr() { return stderr; }, get stdout() { return stdout; } };
    children.push(result);
    return result;
  };
  const stop = async ({ child, exited }) => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 2000);
    try { await exited; } finally { clearTimeout(timer); }
  };
  t.after(async () => {
    try {
      await Promise.all(children.map(stop));
      await until(() => records(pidPath).every(({ pid }) => !alive(pid)));
    } finally {
      for (const { pid } of records(pidPath)) if (alive(pid)) process.kill(pid, 'SIGKILL');
      rmSync(directory, { recursive: true, force: true });
    }
  });
  const host = launch(['codex', '--port', '0', '--workspace', workspace]);
  const lines = createInterface({ input: host.child.stdout });
  const ready = await Promise.race([
    new Promise(resolve => lines.once('line', line => resolve(JSON.parse(line)))),
    host.exited.then(() => { throw new Error(`Host failed to start ${host.stderr}`); }),
  ]);
  lines.close();
  assert.equal(ready.mode, 'codex');
  const invite = async op => {
    const cli = launch([op]);
    assert.equal((await cli.exited).code, 0, cli.stderr);
    const result = JSON.parse(cli.stdout);
    assert.equal(result.ok, true);
    return result.value;
  };
  const call = (path, body, headers = {}) => new Promise((resolve, reject) => {
    const outgoing = request(`${ready.origin}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers } }, incoming => {
      let text = '';
      incoming.setEncoding('utf8').on('data', value => { text += value; });
      incoming.once('error', reject);
      incoming.once('end', () => resolve({ status: incoming.statusCode, headers: incoming.headers, body: JSON.parse(text) }));
    });
    outgoing.once('error', reject);
    outgoing.setTimeout(5000, () => outgoing.destroy(new Error('Host request timed out')));
    outgoing.end(JSON.stringify(body));
  });
  const browserInvite = await invite('invite');
  const browser = await call('/api/v1', { op: 'pair', code: browserInvite.code }, { Origin: ready.origin });
  assert.equal(browser.status, 200);
  const cookie = browser.headers['set-cookie'][0].split(';')[0];
  const nativeInvite = await invite('invite-native');
  const native = await call('/native/v1/pair', { version: 1, hostId: ready.hostId, code: nativeInvite.code });
  assert.equal(native.status, 200);
  const clients = [
    { path: '/api/v1', headers: { Origin: ready.origin, Cookie: cookie }, conversationId: 'browser-codex' },
    { path: '/native/v1', headers: { Authorization: `Bearer ${native.body.value.secret}` }, conversationId: 'native-codex' },
  ];
  for (const client of clients) {
    const metadata = await call(client.path, { op: 'metadata' }, client.headers);
    assert.equal(metadata.status, 200);
    assert.deepEqual(metadata.body.value.compatibility.nativeRuntime, CODEX_RUNTIME, client.conversationId);
    const scope = { hostId: ready.hostId, conversationId: client.conversationId };
    const created = await call(client.path, { op: 'create', scope, agentId: metadata.body.value.defaultAgentId }, client.headers);
    assert.equal(created.status, 200);
    assert.deepEqual(created.body, { ok: true, value: scope });
  }
  const db = new DatabaseSync(join(directory, 'data', 'host.sqlite'), { readOnly: true });
  try {
    const rows = db.prepare('SELECT conversation, installation FROM conversations ORDER BY conversation').all();
    assert.deepEqual(rows.map(row => row.conversation), clients.map(client => client.conversationId));
    for (const row of rows) assert.deepEqual(JSON.parse(row.installation), {
      installationId: 'codex-local-v1', binding: {
        engine: 'codex', nativeVersion: CODEX_RUNTIME.version, account: 'local', authorizedScope: workspace,
        nativeFormat: CODEX_RUNTIME.format,
      },
    }, row.conversation);
  } finally { db.close(); }
  await until(() => records(pidPath).some(({ args }) => args[0] === 'app-server'));
  assert.deepEqual(records(pidPath).map(({ args }) => args), [['--version'], ['app-server', '--stdio']]);
  await stop(host);
  assert.equal((await host.exited).code, 0, host.stderr);
  await until(() => records(pidPath).every(({ pid }) => !alive(pid)));
});
