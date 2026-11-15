import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import test from 'node:test';
import { CODEX_SDK_RUNTIME } from '@agentui/contracts/compatibility';
import { DatabaseSync } from 'node:sqlite';
import { readAgentConfiguration } from '../../apps/host/build/tsc/agent-config.js';

const root = new URL('../../', import.meta.url);
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'agentui-sdk-startup-'));
  const bin = join(directory, 'bin');
  await mkdir(bin);
  const fixtureUrl = new URL('../host/fixtures/codex-sdk-exec.mjs', import.meta.url).href;
  await writeFile(join(bin, 'codex'), `#!${process.execPath}\nawait import(${JSON.stringify(fixtureUrl)});\n`, { mode: 0o700 });
  const children = [];
  const launch = (args, environment = {}) => {
    const child = spawn(process.execPath, ['apps/host/dist/main.js', ...args, '--data-dir', join(directory, 'data')], {
      cwd: root, env: { ...process.env, CODEX_HOME: directory, PATH: `${bin}:${process.env.PATH ?? ''}`, ...environment },
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
    assert.deepEqual((await call(client.path, { op: 'create', scope, agentId: metadata.value.defaultAgentId }, client.headers)).value, scope);
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

test('configured agents probe and launch their exact binaries while missing optional agents stay isolated', { timeout: 30000 }, async t => {
  const f = await fixture(t), sdk = join(f.directory, 'pinned-sdk'), rpc = join(f.directory, 'pinned-rpc');
  const sdkFixture = new URL('../host/fixtures/codex-sdk-exec.mjs', import.meta.url).href;
  const rpcFixture = new URL('../host/fixtures/codex-agent.mjs', import.meta.url).href;
  const launches = join(f.directory, 'configured-launches.jsonl');
  const wrapper = name => `#!${process.execPath}\nimport { appendFileSync } from 'node:fs';\nappendFileSync(${JSON.stringify(launches)}, JSON.stringify({ name: ${JSON.stringify(name)}, pid: process.pid, args: process.argv.slice(2) }) + '\\n');\n`;
  await writeFile(sdk, wrapper('sdk') + `await import(${JSON.stringify(sdkFixture)});\n`, { mode: 0o700 });
  await writeFile(rpc, wrapper('rpc') + `if (process.argv[2] === '--version') process.stdout.write('codex-cli 0.167.2\\n');\nelse { process.argv = [process.execPath, 'fixture', ${JSON.stringify(join(f.directory, 'rpc.jsonl'))}]; await import(${JSON.stringify(rpcFixture)}); }\n`, { mode: 0o700 });
  await writeFile(join(f.directory, 'bin', 'codex'), `#!${process.execPath}\nthrow new Error('Unselected PATH executable');\n`, { mode: 0o700 });
  const otherWorkspace = join(f.directory, 'other-workspace');
  await mkdir(otherWorkspace);
  const configuration = { version: 1, default: 'sol', agents: [
    { name: 'sol', kind: 'codex-sdk', workspace: f.directory, executable: sdk },
    { name: 'rpc', kind: 'codex', workspace: f.directory, executable: rpc },
    { name: 'missing-binary', kind: 'codex-sdk', workspace: otherWorkspace, executable: join(f.directory, 'not-installed') },
    { name: 'sonnet', kind: 'claude-sdk', model: 'sonnet', workspace: f.directory },
    { name: 'pi', kind: 'pi', workspace: f.directory },
  ] };
  const config = join(f.directory, 'agents.json');
  await writeFile(config, JSON.stringify(configuration));
  const host = f.launch(['serve', '--config', config, '--port', '0'], { AGENTUI_ANTHROPIC_API_KEY: '', OPENCODE_GO_API_KEY: '' });
  const lines = createInterface({ input: host.child.stdout });
  const ready = await Promise.race([new Promise(resolve => lines.once('line', line => resolve(JSON.parse(line)))), host.exited.then(() => { throw new Error(host.stderr); })]);
  lines.close();
  assert.equal(ready.mode, 'serve');
  const invitation = f.launch(['invite']);
  assert.equal(await invitation.exited, 0, invitation.stderr);
  let cookie = '';
  const call = async body => {
    const response = await fetch(`${ready.origin}/api/v1`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: ready.origin, Cookie: cookie }, body: JSON.stringify(body) });
    if (response.headers.has('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
    const result = await response.json();
    assert.equal(result.ok, true, JSON.stringify(result));
    return result.value;
  };
  await call({ op: 'pair', code: JSON.parse(invitation.stdout).value.code });
  const metadata = await call({ op: 'metadata' });
  assert.deepEqual(metadata.agents.map(agent => agent.availability.kind), ['ready', 'ready', 'unavailable', 'unavailable', 'unavailable']);
  assert.equal(metadata.defaultAgentId, metadata.agents[0].id);
  assert.match(metadata.agents[0].label, /^sol · Codex/);
  assert.match(metadata.agents[2].label, /^missing-binary · Codex/);
  assert.doesNotMatch(JSON.stringify(metadata), /not-installed|private|AGENTUI_ANTHROPIC|OPENCODE_GO|Unselected/);
  for (const [index, agent] of metadata.agents.slice(0, 2).entries()) {
    const scope = { hostId: ready.hostId, conversationId: `configured-${index}` };
    await call({ op: 'create', scope, agentId: agent.id });
    const result = await call({ op: 'submit', command: { version: 1, scope, clientCommandId: 'same-id', body: { kind: 'send', text: 'hello' } } });
    assert.equal(result.kind, 'receipt');
    assert.equal((await call({ op: 'conversation-agent', scope })).id, agent.id);
  }
  const records = (await readFile(launches, 'utf8')).trim().split('\n').map(JSON.parse);
  for (const name of ['sdk', 'rpc']) assert.ok(records.some(record => record.name === name && record.args[0] === '--version'));
  assert.ok(records.some(record => record.name === 'rpc' && record.args[0] === 'app-server'));
  assert.ok(records.some(record => record.name === 'sdk' && record.args.includes('exec')));
  host.child.kill('SIGTERM');
  assert.equal(await host.exited, 0, host.stderr);
  for (const { pid } of records) assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  configuration.default = 'missing-binary';
  await writeFile(config, JSON.stringify(configuration));
  const unavailableDefault = f.launch(['serve', '--config', config, '--port', '0'], { AGENTUI_ANTHROPIC_API_KEY: '', OPENCODE_GO_API_KEY: '' });
  const nextLines = createInterface({ input: unavailableDefault.child.stdout });
  const next = await Promise.race([new Promise(resolve => nextLines.once('line', line => resolve(JSON.parse(line)))), unavailableDefault.exited.then(() => { throw new Error(unavailableDefault.stderr); })]);
  nextLines.close();
  const response = await fetch(`${next.origin}/api/v1`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: next.origin, Cookie: cookie }, body: JSON.stringify({ op: 'metadata' }) });
  const reopened = (await response.json()).value;
  assert.equal(reopened.defaultAgentId, metadata.agents[2].id);
  assert.equal(reopened.agents[0].availability.kind, 'ready');
  assert.equal(reopened.agents[2].availability.kind, 'unavailable');
});

test('agent configuration refuses embedded credentials, unsupported models and an absent default', async t => {
  const f = await fixture(t), config = join(f.directory, 'invalid-agents.json');
  const agent = { name: 'sol', kind: 'codex-sdk', workspace: f.directory };
  for (const value of [
    { version: 1, default: 'sol', agents: [{ ...agent, apiKey: 'must-not-be-accepted' }] },
    { version: 1, default: 'sol', agents: [{ ...agent, kind: 'claude-sdk', model: 'haiku' }] },
    { version: 1, default: 'missing', agents: [agent] },
  ]) {
    await writeFile(config, JSON.stringify(value));
    assert.throws(() => readAgentConfiguration(config));
  }
});
