import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { openSync, closeSync, writeFileSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, readlink, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { CODEX_RUNTIME, PI_RUNTIME, CLAUDE_SDK_RUNTIMES } from '@agentui/contracts/compatibility';
import { harnessSpecifications, parseSetupArgs, setupScript } from '../../scripts/agentui-setup.mjs';
import { shellQuote } from '../../scripts/agentui-runtime.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const entry = join(root, 'scripts/agentui-setup.mjs');

async function fixture(t, beforeCleanup = () => {}) {
  const directory = await mkdtemp(join(tmpdir(), 'agentui-harness-'));
  t.after(async () => { try { await beforeCleanup(); } finally { await rm(directory, { recursive: true, force: true }); } });
  const home = join(directory, 'home'), bin = join(directory, 'bin');
  await Promise.all([mkdir(home), mkdir(bin)]);
  await symlink(process.execPath, join(bin, 'node'));
  const log = join(directory, 'npm.jsonl');
  await writeFile(join(bin, 'npm'), `#!${process.execPath}
import fs from 'node:fs';
import path from 'node:path';
const args=process.argv.slice(2),prefix=args[args.indexOf('--prefix')+1],spec=args.at(-1),at=spec.lastIndexOf('@'),pkg=spec.slice(0,at),version=spec.slice(at+1);
fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(args)+'\\n');
if(process.env.TEST_INSTALL_FAIL)process.exit(17);
const id=pkg==='@openai/codex'?'codex':pkg==='@anthropic-ai/claude-code'?'claude':'pi';
const expected=id==='codex'?'codex-cli '+version:id==='claude'?version+' (Claude Code)':version;
fs.mkdirSync(path.join(prefix,'node_modules',pkg),{recursive:true});
fs.mkdirSync(path.join(prefix,'node_modules/.bin'),{recursive:true});
const code='#!${process.execPath}\\nif(process.argv[2]!=="--version")process.exit(19);console.log('+JSON.stringify(expected)+');\\n';
let optionalDependencies;
if(id==='claude'){
  const musl=process.platform==='linux'&&!process.report.getReport().header.glibcVersionRuntime;
  const native=pkg+'-'+process.platform+'-'+process.arch+(musl?'-musl':'');
  optionalDependencies={[native]:version};
  fs.mkdirSync(path.join(prefix,'node_modules',native),{recursive:true});
  fs.writeFileSync(path.join(prefix,'node_modules',native,'package.json'),JSON.stringify({name:native,version}));
  fs.writeFileSync(path.join(prefix,'node_modules',native,'claude'),code,{mode:0o644});
}
fs.writeFileSync(path.join(prefix,'node_modules',pkg,'package.json'),JSON.stringify({name:pkg,version,optionalDependencies}));
fs.writeFileSync(path.join(prefix,'node_modules/.bin',id),id==='claude'?'PLACEHOLDER':code,{mode:0o755});
`, { mode: 0o755 });
  return { directory, home, bin, log, env: { ...process.env, HOME: home, PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin` } };
}

function run(script, env) {
  return spawnSync('/bin/sh', ['-s'], { input: script, env, encoding: 'utf8', timeout: 20_000 });
}

test('setup validates target and harness options before installing', () => {
  assert.deepEqual(parseSetupArgs(['--agent', 'claude', '--ssh', 'user@host']), { agent: 'claude', target: { kind: 'ssh', destination: 'user@host' } });
  assert.deepEqual(parseSetupArgs(['--agent', 'pi']), { agent: 'pi', target: { kind: 'local' } });
  for (const args of [[], ['--agent'], ['--agent', 'other'], ['--agent', 'pi', '--agent', 'codex'], ['--agent', 'pi', '--workspace', '/tmp'], ['--agent', 'pi', '--ssh', '-bad'], ['--agent', 'pi', '--ssh', 'host;echo bad'], ['--help', '--ssh', 'host']]) {
    assert.throws(() => parseSetupArgs(args), /Usage/u);
  }
});

test('setup pins match the host integration and Claude SDK bundled CLI', async () => {
  const specifications = await harnessSpecifications();
  assert.equal(specifications.codex.version, CODEX_RUNTIME.version);
  assert.equal(specifications.pi.version, PI_RUNTIME.version);
  const sdk = JSON.parse(await readFile(join(root, 'node_modules/@anthropic-ai/claude-agent-sdk/package.json'), 'utf8'));
  assert.equal(sdk.version, CLAUDE_SDK_RUNTIMES.opus.version);
  assert.equal(specifications.claude.version, sdk.claudeCodeVersion);
});

for (const id of ['codex', 'pi', 'claude']) test(`fresh ${id} setup completes signed out and repeat uses the installed harness`, async t => {
  const f = await fixture(t), specifications = await harnessSpecifications();
  const script = setupScript(process.versions.node, specifications[id]);
  const first = run(script, f.env);
  assert.ifError(first.error);
  assert.equal(first.status, 0, first.stderr);
  const result = JSON.parse(first.stdout.split('\n').find(line => line.startsWith('AGENTUI_INSTALLED ')).slice('AGENTUI_INSTALLED '.length));
  assert.equal(result.agent, id);
  assert.equal(result.authentication, 'not-checked');
  assert.equal(result.version, specifications[id].version);
  const installed = await readlink(join(f.home, '.local/share/agentui/tools/harnesses', `${id}-${result.version}`));
  assert.ok(installed.startsWith(join(f.home, '.local/share/agentui/tools/.harness-')));
  if (id === 'claude') assert.match(await readlink(result.executable), /claude-code-.*\/claude$/u);
  const second = run(script, f.env);
  assert.equal(second.status, 0, second.stderr);
  const calls = (await readFile(f.log, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.equal(calls.length, 1);
  for (const flag of ['--ignore-scripts', '--no-audit', '--userconfig', '--globalconfig', '--registry=https://registry.npmjs.org']) assert.ok(calls[0].includes(flag));
  assert.deepEqual(await readdir(f.home), ['.local']);
});

test('failed installation publishes no harness and a retry converges', async t => {
  const f = await fixture(t), specifications = await harnessSpecifications();
  const script = setupScript(process.versions.node, specifications.codex);
  const failed = run(script, { ...f.env, TEST_INSTALL_FAIL: '1' });
  assert.notEqual(failed.status, 0);
  assert.doesNotMatch(failed.stdout, /AGENTUI_INSTALLED/u);
  assert.deepEqual(await readdir(join(f.home, '.local/share/agentui/tools/harnesses')), []);
  assert.equal((await readdir(join(f.home, '.local/share/agentui/tools'))).filter(name => name.startsWith('.harness-')).length, 0);
  assert.equal(run(script, f.env).status, 0);
});

test('a failed replacement leaves the prior published path intact', async t => {
  const f = await fixture(t), specifications = await harnessSpecifications();
  const script = setupScript(process.versions.node, specifications.codex);
  assert.equal(run(script, f.env).status, 0);
  const path = join(f.home, '.local/share/agentui/tools/harnesses', `codex-${specifications.codex.version}`);
  const previous = await readlink(path);
  await writeFile(join(previous, 'node_modules/.bin/codex'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  assert.notEqual(run(script, { ...f.env, TEST_INSTALL_FAIL: '1' }).status, 0);
  assert.equal(await readlink(path), previous);
  assert.equal(run(script, f.env).status, 0);
  assert.notEqual(await readlink(path), previous);
});

test('a corrupt Node archive is refused before extraction', async t => {
  const f = await fixture(t), specifications = await harnessSpecifications();
  await rm(join(f.bin, 'node'));
  await writeFile(join(f.bin, 'node'), '#!/bin/sh\nprintf "v0.0.0\\n"\n', { mode: 0o755 });
  await writeFile(join(f.bin, 'curl'), '#!/bin/sh\nwhile [ "$1" != -o ]; do shift; done\nprintf corrupt > "$2"\n', { mode: 0o755 });
  const tarLog = join(f.directory, 'tar-ran');
  await writeFile(join(f.bin, 'tar'), `#!/bin/sh\ntouch ${shellQuote(tarLog)}\nexit 1\n`, { mode: 0o755 });
  const result = run(setupScript('24.22.3', specifications.pi), { ...f.env, PATH: `${f.bin}:/usr/bin:/bin` });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /checksum verification failed/u);
  await assert.rejects(readFile(tarLog), { code: 'ENOENT' });
  assert.doesNotMatch(result.stdout, /AGENTUI_INSTALLED/u);
});

test('wrapper setup help works without dependencies or application builds', async t => {
  const f = await fixture(t);
  await mkdir(join(f.directory, 'scripts'));
  for (const name of ['agentui-setup.mjs', 'agentui-runtime.mjs']) await copyFile(join(root, 'scripts', name), join(f.directory, 'scripts', name));
  await copyFile(join(root, 'agentui'), join(f.directory, 'agentui'));
  const result = spawnSync('/bin/sh', [join(f.directory, 'agentui'), 'setup', '--help'], { env: f.env, encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Usage: \.\/agentui setup/u);
  assert.equal(result.stderr, '');
});

test('wrapper installs before dependencies or build artifacts exist', async t => {
  const f = await fixture(t);
  for (const name of ['scripts/agentui-setup.mjs', 'scripts/agentui-runtime.mjs', 'packages/contracts/src/compatibility.ts', 'packages/host/package.json', '.node-version', 'agentui']) {
    await mkdir(dirname(join(f.directory, name)), { recursive: true });
    await copyFile(join(root, name), join(f.directory, name));
  }
  const result = spawnSync('/bin/sh', [join(f.directory, 'agentui'), 'setup', '--agent', 'codex'], { env: f.env, encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).event, 'installed');
  await assert.rejects(readdir(join(f.directory, 'node_modules')), { code: 'ENOENT' });
});

test('source formatting does not change installation pins before dependencies exist', async t => {
  const f = await fixture(t);
  for (const name of ['scripts/agentui-setup.mjs', 'scripts/agentui-runtime.mjs', 'packages/contracts/src/compatibility.ts', '.node-version', 'agentui']) {
    await mkdir(dirname(join(f.directory, name)), { recursive: true });
    await copyFile(join(root, name), join(f.directory, name));
  }
  const filename = join(f.directory, 'packages/contracts/src/compatibility.ts');
  const source = await readFile(filename, 'utf8');
  await writeFile(filename, source.replace("engine: 'codex'", 'engine: "codex"'));
  const result = spawnSync('/bin/sh', [join(f.directory, 'agentui'), 'setup', '--agent', 'codex'], { env: f.env, encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).version, CODEX_RUNTIME.version);
});

for (const architecture of ['x86_64', 'aarch64']) test(`Linux ${architecture} target metadata uses the same installer operation`, async t => {
  const f = await fixture(t), specifications = await harnessSpecifications();
  await writeFile(join(f.bin, 'uname'), `#!/bin/sh\nif [ "$1" = -s ]; then echo Linux; else echo ${architecture}; fi\n`, { mode: 0o755 });
  const result = run(setupScript(process.versions.node, specifications.codex), f.env);
  assert.equal(result.status, 0, result.stderr);
  const record = JSON.parse(result.stdout.split('\n').find(line => line.startsWith('AGENTUI_INSTALLED ')).slice('AGENTUI_INSTALLED '.length));
  assert.equal(record.os, 'Linux');
  assert.equal(record.arch, architecture);
});

test('SSH setup sends the installer through stdin and retains host-key verification', async t => {
  const f = await fixture(t), capture = join(f.directory, 'ssh.json');
  await writeFile(join(f.bin, 'ssh'), `#!${process.execPath}
import fs from 'node:fs';
let input='';process.stdin.setEncoding('utf8').on('data',part=>input+=part).on('end',()=>{fs.writeFileSync(${JSON.stringify(capture)},JSON.stringify({args:process.argv.slice(2),input}));console.log('AGENTUI_INSTALLED '+JSON.stringify({event:'installed',agent:'pi',version:'${PI_RUNTIME.version}',executable:'/private/pi',os:'Linux',arch:'x86_64',authentication:'not-checked'}));});
`, { mode: 0o755 });
  const result = spawnSync(process.execPath, [entry, '--agent', 'pi', '--ssh', 'user@host'], { env: f.env, encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 0, result.stderr);
  const captured = JSON.parse(await readFile(capture, 'utf8'));
  assert.deepEqual(captured.args.slice(-2), ['user@host', 'sh -s']);
  assert.ok(captured.args.includes('BatchMode=yes'));
  assert.equal(captured.args.some(value => /StrictHostKeyChecking=no|UserKnownHostsFile=/u.test(value)), false);
  assert.match(captured.input, /npm install/u);
  assert.doesNotMatch(captured.input, /login status|OPENCODE_GO_API_KEY|AGENTUI_ANTHROPIC_API_KEY/u);
  assert.equal(JSON.parse(result.stdout).target, 'user@host');
});

for (const output of ['{invalid SECRET_SENTINEL', JSON.stringify({ event: 'installed', agent: 'pi', version: PI_RUNTIME.version, executable: '/pi', os: 'Linux', arch: 'x64', authentication: 'not-checked', secret: 'SECRET_SENTINEL' })]) {
  test('invalid target installation output fails without echoing its contents', async t => {
    const f = await fixture(t);
    await writeFile(join(f.bin, 'ssh'), `#!/bin/sh\ncat >/dev/null\nprintf '%s\\n' ${shellQuote(`AGENTUI_INSTALLED ${output}`)}\n`, { mode: 0o755 });
    const result = spawnSync(process.execPath, [entry, '--agent', 'pi', '--ssh', 'host'], { env: f.env, encoding: 'utf8', timeout: 5000 });
    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, '');
    assert.doesNotMatch(result.stderr, /SECRET_SENTINEL/u);
  });
}

function waitForMarker(child, marker, signal, stderr) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      child.stderr.off('data', onData);
      child.off('exit', onExit);
      child.off('error', onError);
      signal.removeEventListener('abort', onAbort);
    };
    const onData = () => { if (stderr.value.includes(marker)) { cleanup(); resolve(); } };
    const onExit = () => { cleanup(); reject(new Error(`Setup exited before ${marker}`)); };
    const onError = error => { cleanup(); reject(error); };
    const onAbort = () => { cleanup(); reject(new Error(`Setup interrupted before ${marker}`)); };
    child.stderr.on('data', onData);
    child.once('exit', onExit);
    child.once('error', onError);
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
    else if (stderr.value.includes(marker)) onData();
    else if (stderr.error) onError(stderr.error);
    else if (child.exitCode !== null || child.signalCode !== null) onExit();
  });
}

async function beforeAbort(promise, signal) {
  let onAbort;
  const aborted = new Promise((_, reject) => {
    onAbort = () => reject(new Error('Setup did not close before the test deadline'));
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  });
  try { return await Promise.race([promise, aborted]); } finally { signal.removeEventListener('abort', onAbort); }
}

async function cancellationFixture(t, sshScript, executable = process.execPath) {
  let child;
  const f = await fixture(t, () => {
    if (!child) return;
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    child.stdout.destroy();
    child.stderr.destroy();
    child.unref();
  });
  await writeFile(join(f.bin, 'ssh'), sshScript, { mode: 0o755 });
  const owner = join(f.directory, 'setup.pid');
  child = spawn(executable, [entry, '--agent', 'pi', '--ssh', 'host'], { env: { ...f.env, TEST_SETUP_OWNER: owner }, stdio: ['ignore', 'pipe', 'pipe'] });
  if (child.pid) writeFileSync(owner, String(child.pid));
  let stdout = '';
  const stderr = { value: '' };
  child.stdout.on('data', data => { stdout += data; });
  child.stderr.on('data', data => { stderr.value += data; });
  const closed = new Promise(resolve => {
    child.once('error', error => { stderr.error = error; resolve({ error }); });
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  return { child, stderr, stdout: () => stdout, closed };
}

const runningSsh = `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
let parent;
const timer = setInterval(() => {
  if (parent === undefined) {
    try {
      parent = Number(fs.readFileSync(process.env.TEST_SETUP_OWNER, 'utf8'));
      process.stderr.write('SETUP_RUNNING\\n');
    } catch (error) {
      if (error.code === 'ENOENT' && !fs.existsSync(path.dirname(process.env.TEST_SETUP_OWNER))) process.exit(0);
      if (error.code !== 'ENOENT') throw error;
    }
  } else if (process.ppid !== parent) {
    clearInterval(timer);
    process.exit(0);
  }
}, 20);
setTimeout(() => process.exit(1), 10000).unref();
`;

test('cancellation stops setup without returning an installed result', { timeout: 10_000 }, async t => {
  const { child, stderr, stdout, closed } = await cancellationFixture(t, runningSsh);
  await waitForMarker(child, 'SETUP_RUNNING', t.signal, stderr);
  child.kill('SIGTERM');
  assert.deepEqual(await beforeAbort(closed, t.signal), { code: 1, signal: null });
  assert.equal(stdout(), '');
  assert.match(stderr.value, /did not complete/u);
});

test('cancellation setup reports an early exit before its startup marker', { timeout: 10_000 }, async t => {
  const ssh = `#!/bin/sh\nexit 1\n`;
  const { child, stderr, closed } = await cancellationFixture(t, ssh);
  await assert.rejects(waitForMarker(child, 'SETUP_RUNNING', t.signal, stderr), /Setup exited before SETUP_RUNNING/u);
  assert.deepEqual(await beforeAbort(closed, t.signal), { code: 1, signal: null });
});

test('cancellation setup reports a spawn error before waiting for startup', { timeout: 10_000 }, async t => {
  const missing = join(tmpdir(), `agentui-missing-node-${process.pid}`);
  const { child, stderr, closed } = await cancellationFixture(t, runningSsh, missing);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(stderr.error?.code, 'ENOENT');
  await assert.rejects(waitForMarker(child, 'SETUP_RUNNING', t.signal, stderr), { code: 'ENOENT' });
  assert.equal((await beforeAbort(closed, t.signal)).error.code, 'ENOENT');
});

test('fake SSH releases its inherited pipes if setup dies', { timeout: 10_000 }, async t => {
  const { child, stderr, closed } = await cancellationFixture(t, runningSsh);
  await waitForMarker(child, 'SETUP_RUNNING', t.signal, stderr);
  child.kill('SIGKILL');
  assert.deepEqual(await beforeAbort(closed, t.signal), { code: null, signal: 'SIGKILL' });
});

if (process.env.AGENTUI_CANCELLATION_PROBE) {
  test('cancellation deadline probe', async t => {
    const probe = process.env.AGENTUI_CANCELLATION_PROBE;
    const ssh = `#!${process.execPath}
const fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(join(probe, 'started'))}, '');
process.stderr.write('SETUP_RUNNING\\n');
const timer = setInterval(() => {
  if (!fs.existsSync(${JSON.stringify(probe)})) process.exit(0);
  if (fs.existsSync(${JSON.stringify(join(probe, 'release'))})) {
    clearInterval(timer);
    fs.writeFileSync(${JSON.stringify(join(probe, 'done'))}, '');
    process.exit(0);
  }
}, 20);
setTimeout(() => {
  if (fs.existsSync(${JSON.stringify(probe)})) fs.writeFileSync(${JSON.stringify(join(probe, 'fallback-expired'))}, '');
  process.exit(1);
}, 10000).unref();
`;
    const { child, stderr } = await cancellationFixture(t, ssh);
    await waitForMarker(child, 'SETUP_RUNNING', t.signal, stderr);
    while (true) {
      try { await readFile(join(probe, 'arm')); break; } catch (error) { if (error.code !== 'ENOENT') throw error; }
      t.signal.throwIfAborted();
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    await t.test('deadline', { timeout: 100 }, async subtest => {
      await waitForMarker(child, 'NEVER_WRITTEN', subtest.signal, stderr);
    });
  });
} else {
  test('a timed-out cancellation test releases its worker despite inherited stderr', { timeout: 15_000 }, async t => {
    const directory = await mkdtemp(join(tmpdir(), 'agentui-deadline-'));
    const output = openSync(join(directory, 'output'), 'w');
    const env = { ...process.env, AGENTUI_CANCELLATION_PROBE: directory };
    delete env.NODE_TEST_CONTEXT;
    const runner = spawn(process.execPath, ['--test', '--test-isolation=none', '--test-name-pattern=^cancellation deadline probe$', fileURLToPath(import.meta.url)], {
      env, stdio: ['ignore', output, output],
    });
    let runnerError;
    const exited = new Promise(resolve => {
      runner.once('error', error => { runnerError = error; resolve({ error }); });
      runner.once('exit', (code, signal) => resolve({ code, signal }));
    });
    t.after(async () => {
      await writeFile(join(directory, 'release'), '');
      if (runner.exitCode === null && runner.signalCode === null) runner.kill('SIGKILL');
      runner.unref();
      closeSync(output);
      await rm(directory, { recursive: true, force: true });
    });
    while (true) {
      try { await readFile(join(directory, 'started')); break; } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (runnerError) throw runnerError;
      if (runner.exitCode !== null || runner.signalCode !== null) throw new Error('Deadline runner exited before fixture startup');
      t.signal.throwIfAborted();
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    const timeout = AbortSignal.timeout(5000);
    await writeFile(join(directory, 'arm'), '');
    const result = await Promise.race([
      exited,
      new Promise((_, reject) => timeout.addEventListener('abort', () => reject(new Error('Timed-out runner did not exit')), { once: true })),
    ]);
    assert.deepEqual(result, { code: 1, signal: null });
    assert.equal(await readFile(join(directory, 'started'), 'utf8'), '');
    await assert.rejects(readFile(join(directory, 'done')), { code: 'ENOENT' });
    await assert.rejects(readFile(join(directory, 'fallback-expired')), { code: 'ENOENT' });
    assert.match(await readFile(join(directory, 'output'), 'utf8'), /test timed out/u);
    await writeFile(join(directory, 'release'), '');
    while (true) {
      try { await readFile(join(directory, 'done')); break; } catch (error) { if (error.code !== 'ENOENT') throw error; }
      t.signal.throwIfAborted();
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  });
}
