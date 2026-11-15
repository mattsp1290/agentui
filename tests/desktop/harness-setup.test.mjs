import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
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

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'agentui-harness-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
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

test('cancellation stops setup without returning an installed result', { timeout: 10_000 }, async t => {
  const f = await fixture(t);
  await writeFile(join(f.bin, 'ssh'), `#!/bin/sh\nexec ${shellQuote(process.execPath)} -e 'process.stderr.write("SETUP_RUNNING\\n");setInterval(()=>{},1000);'\n`, { mode: 0o755 });
  const child = spawn(process.execPath, [entry, '--agent', 'pi', '--ssh', 'host'], { env: f.env, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  let stdout = '', stderr = '';
  child.stdout.on('data', data => { stdout += data; });
  const started = new Promise(resolve => child.stderr.on('data', data => { stderr += data; if (stderr.includes('SETUP_RUNNING')) resolve(); }));
  const exited = new Promise(resolve => child.once('close', resolve));
  await started;
  child.kill('SIGTERM');
  assert.equal(await exited, 1);
  assert.equal(stdout, '');
  assert.match(stderr, /did not complete/u);
});
