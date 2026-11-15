import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import test from 'node:test';
import { CODEX_SDK_RUNTIME } from '@agentui/contracts/compatibility';
import { DatabaseSync } from 'node:sqlite';

const root = new URL('../../', import.meta.url);
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'agentui-sdk-startup-'));
  const bin = join(directory, 'bin');
  await mkdir(bin);
  const fixtureUrl = new URL('../host/fixtures/codex-sdk-exec.mjs', import.meta.url).href;
  await writeFile(join(bin, 'codex'), `#!${process.execPath}\nawait import(${JSON.stringify(fixtureUrl)});\n`, { mode: 0o700 });
  const children = [];
  const launch = args => {
    const child = spawn(process.execPath, ['apps/host/dist/main.js', ...args, '--data-dir', join(directory, 'data')], {
      cwd: root, env: { ...process.env, CODEX_HOME: directory, PATH: `${bin}:${process.env.PATH ?? ''}` },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8').on('data', text => { stdout += text; });
    child.stderr.setEncoding('utf8').on('data', text => { stderr += text; });
    const exited = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', code => resolve(code));
    });
    const result = { child, exited, get stdout() { return stdout; }, get stderr() { return stderr; } };
    children.push(result);
    return result;
  };
  t.after(async () => {
    for (const { child, exited } of children) {
      if (child.exitCode !== null || child.signalCode !== null) continue;
      child.kill('SIGTERM');
      const timer = setTimeout(() => child.kill('SIGKILL'), 2000);
      try { await exited; } finally { clearTimeout(timer); }
    }
    await rm(directory, { recursive: true, force: true });
  });
  return { directory, launch, start: () => launch(['codex-sdk', '--workspace', directory, '--port', '0']) };
}

for (const [marker, expected] of [
  ['wrong-version', /Install Codex CLI 0\.169\.0/],
  ['signed-out', /Sign in with ChatGPT using codex login/],
]) {
  test(`SDK startup refuses ${marker} before publishing a listener and releases its directory`, { timeout: 15_000 }, async t => {
    const f = await fixture(t);
    await writeFile(join(f.directory, marker), '');
    const failed = f.start();
    assert.equal(await failed.exited, 1);
    assert.equal(failed.stdout, '');
    assert.match(failed.stderr, expected);
    await rm(join(f.directory, marker));
    const running = f.start();
    const lines = createInterface({ input: running.child.stdout });
    const ready = await Promise.race([
      new Promise(resolve => lines.once('line', line => resolve(JSON.parse(line)))),
      running.exited.then(() => { throw new Error(running.stderr); }),
    ]);
    lines.close();
    assert.equal(ready.mode, 'codex-sdk');
  });
}

test('SDK bootstrap advertises its separate subscription runtime to browser and native clients', { timeout: 20_000 }, async t => {
  const f = await fixture(t);
  const host = f.start();
  const lines = createInterface({ input: host.child.stdout });
  const ready = await Promise.race([
    new Promise(resolve => lines.once('line', line => resolve(JSON.parse(line)))),
    host.exited.then(() => { throw new Error(host.stderr); }),
  ]);
  lines.close();
  const invitation = async op => {
    const cli = f.launch([op]);
    assert.equal(await cli.exited, 0, cli.stderr);
    return JSON.parse(cli.stdout).value;
  };
  const call = async (path, body, headers = {}) => {
    const response = await fetch(`${ready.origin}${path}`, { method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
    assert.equal(response.status, 200);
    return { headers: response.headers, ...(await response.json()) };
  };
  const browser = await call('/api/v1', { op: 'pair', code: (await invitation('invite')).code }, { Origin: ready.origin });
  const native = await call('/native/v1/pair', { version: 1, hostId: ready.hostId, code: (await invitation('invite-native')).code });
  const clients = [
    { path: '/api/v1', headers: { Origin: ready.origin, Cookie: browser.headers.get('set-cookie').split(';')[0] }, conversationId: 'sdk-browser' },
    { path: '/native/v1', headers: { Authorization: `Bearer ${native.value.secret}` }, conversationId: 'sdk-native' },
  ];
  for (const client of clients) {
    const metadata = await call(client.path, { op: 'metadata' }, client.headers);
    assert.deepEqual(metadata.value.compatibility.nativeRuntime, CODEX_SDK_RUNTIME);
    const scope = { hostId: ready.hostId, conversationId: client.conversationId };
    assert.deepEqual((await call(client.path, { op: 'create', scope }, client.headers)).value, scope);
  }
  const db = new DatabaseSync(join(f.directory, 'data', 'host.sqlite'), { readOnly: true });
  try {
    const rows = db.prepare('SELECT installation FROM conversations ORDER BY conversation').all();
    assert.equal(rows.length, 2);
    for (const row of rows) {
      const installation = JSON.parse(row.installation);
      assert.equal(installation.installationId, 'codex-sdk-chatgpt-gpt-6-1-sol-v1');
      assert.equal(installation.binding.nativeFormat, 'codex-sdk-chat-chatgpt-gpt-6.1-sol-v1');
      assert.equal(installation.binding.account, 'chatgpt:gpt-6.1-sol');
    }
  } finally { db.close(); }
});
