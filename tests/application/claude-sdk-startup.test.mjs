import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import test from 'node:test';
import { CLAUDE_SDK_RUNTIMES } from '@agentui/contracts/compatibility';
import { DatabaseSync } from 'node:sqlite';

const root = new URL('../../', import.meta.url);
async function fixture(t, model = 'sonnet') {
  const directory = await mkdtemp(join(tmpdir(), 'agentui-sdk-startup-'));
  const children = [];
  const launch = (args, key = 'unused-claude-startup-key') => {
    const child = spawn(process.execPath, ['apps/host/dist/main.js', ...args, '--data-dir', join(directory, 'data')], {
      cwd: root, env: { ...process.env, AGENTUI_ANTHROPIC_API_KEY: key === null ? undefined : key, ANTHROPIC_API_KEY: 'ambient-key-is-not-accepted' },
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
  return { directory, launch, start: () => launch(['claude-sdk', '--model', model, '--workspace', directory, '--port', '0']) };
}

test('Claude rejects missing or blank API keys before creating state or publishing a listener', async t => {
  const f = await fixture(t);
  for (const key of [null, '', '   ']) {
    const child = f.launch(['claude-sdk', '--model', 'sonnet', '--workspace', f.directory, '--port', '0'], key);
    assert.equal(await child.exited, 1);
    assert.equal(child.stdout, '');
    assert.match(child.stderr, /Set AGENTUI_ANTHROPIC_API_KEY in the host environment/);
    await assert.rejects(access(join(f.directory, 'data')), { code: 'ENOENT' });
  }
});

for (const [args, expected] of [
  [['claude-sdk'], /Provide --workspace/],
  [['claude-sdk', '--workspace', '/fixture'], /Provide --model opus or --model sonnet/],
  [['claude-sdk', '--workspace', '/fixture', '--model', 'haiku'], /Provide --model opus or --model sonnet/],
  [['claude-sdk', '--workspace', '/fixture', '--model', 'opus', '--port', 'invalid'], /Invalid listener port/],
  [['claude-sdk', '--api-key', 'unused-cli-secret'], /Unknown option/],
  [['codex-sdk', '--model', 'opus', '--workspace', '/fixture'], /--model is not valid for codex-sdk/],
]) {
  test(`Claude rejects invalid arguments ${args.join(' ')}`, async t => {
    const f = await fixture(t);
    const child = f.launch(args);
    assert.equal(await child.exited, 1);
    assert.equal(child.stdout, '');
    assert.match(child.stderr, expected);
    await assert.rejects(access(join(f.directory, 'data')), { code: 'ENOENT' });
  });
}

for (const model of ['opus', 'sonnet']) {
  test(`Claude ${model} advertises its family runtime and keeps API keys out of metadata and saved installation`, { timeout: 20_000 }, async t => {
    const f = await fixture(t, model);
    const host = f.start();
    const lines = createInterface({ input: host.child.stdout });
    const ready = await Promise.race([
      new Promise(resolve => lines.once('line', line => resolve(JSON.parse(line)))),
      host.exited.then(() => { throw new Error(host.stderr); }),
    ]);
    lines.close();
    assert.equal(ready.mode, 'claude-sdk');
    assert.equal(JSON.stringify(ready).includes('unused-claude-startup-key'), false);
    await access(join(f.directory, 'data', 'claude-sessions', model));
    await assert.rejects(access(join(f.directory, 'data', 'claude-sessions', model === 'opus' ? 'sonnet' : 'opus')), { code: 'ENOENT' });
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
      assert.deepEqual(metadata.value.compatibility.nativeRuntime, CLAUDE_SDK_RUNTIMES[model]);
      assert.equal(JSON.stringify(metadata).includes('unused-claude-startup-key'), false);
      const scope = { hostId: ready.hostId, conversationId: client.conversationId };
      assert.deepEqual((await call(client.path, { op: 'create', scope, agentId: metadata.value.defaultAgentId }, client.headers)).value, scope);
    }
    const db = new DatabaseSync(join(f.directory, 'data', 'host.sqlite'), { readOnly: true });
    try {
      const rows = db.prepare('SELECT installation FROM conversations ORDER BY conversation').all();
      assert.equal(rows.length, 2);
      for (const row of rows) {
        const installation = JSON.parse(row.installation);
        assert.equal(installation.installationId, `claude-sdk-api-key-${model}-v1`);
        assert.equal(installation.binding.nativeFormat, CLAUDE_SDK_RUNTIMES[model].format);
        assert.equal(installation.binding.account, `anthropic-api-key:${model}`);
      }
      assert.equal(JSON.stringify(rows).includes('unused-claude-startup-key'), false);
    } finally { db.close(); }
  });
}
