import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, copyFile, cp, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveLockedFork, verifyArchives, verifyConsumerLock, verifyInstalled, tarVersion } from './lib/agui-fork.mjs';

const args = process.argv.slice(2);
assert.ok(args.length === 0 || (args.length === 1 && args[0] === '--offline'), 'Usage: node scripts/verify-agui-fork.mjs [--offline]');
const offline = args[0] === '--offline';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const checks = join(root, 'tests/dependencies/ag-ui');
const runtime = { node: process.version, execPath: process.execPath, platform: process.platform, arch: process.arch,
  inheritedRuntimeConfig: Object.keys(process.env).filter((key) => /^(NODE_OPTIONS$|npm_config_)/iu.test(key)).sort() };
const sourceSha256 = Object.fromEntries(await Promise.all([
  'scripts/lib/agui-fork.mjs', 'scripts/verify-agui-fork.mjs', 'tests/dependencies/ag-ui/all-imports.mjs',
  'tests/dependencies/ag-ui/codex-esm.mjs', 'tests/dependencies/ag-ui/codex-commonjs.cjs',
].map(async (file) => [file, createHash('sha256').update(await readFile(join(root, file))).digest('hex')])));
const [major, minor] = process.versions.node.split('.').map(Number);
assert(major > 22 || (major === 22 && minor >= 19), 'Node >=22.19 is required');
assert(process.platform !== 'win32', 'Controlled Codex supervision requires POSIX');
const fork = resolveLockedFork(root);
const tar = tarVersion();
const expected = verifyArchives(fork);
verifyConsumerLock(join(checks, 'consumer'), fork, expected);
if (offline) {
  console.log(JSON.stringify({ result: 'PASS', scope: 'retained archives and frozen consumer lock',
    sourceRevision: fork.metadata.sourceRevision, localAguiArchives: expected.size, installed: false, ...runtime, sourceSha256, tar }));
} else {
  await qualifyInstalledConsumer(fork, expected);
}

async function qualifyInstalledConsumer(fork, expected) {
  const directory = await mkdtemp(join(tmpdir(), 'agentui-agui-fork-'));
  const consumer = join(directory, 'consumer');
  const env = { ...process.env, PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ''}`, CODEX_TEST_MODE: '1', CODEX_FIXTURE_DIR: join(directory, 'fixture'), AGUI49_CODEX_FIXTURE: join(consumer, 'codex-exec.mjs') };
  const results = [];
  const processOptions = { cwd: consumer, env, timeout: 180000, maxBuffer: 16 * 1024 * 1024 };
  function run(command, commandArgs) {
    const result = spawnSync(command, commandArgs, { ...processOptions, stdio: 'inherit' });
    results.push({ command: [command, ...commandArgs], exitCode: result.status, signal: result.signal });
    console.log(JSON.stringify(results.at(-1)));
    assert.ifError(result.error);
    assert.equal(result.status, 0, `${command} ${commandArgs.join(' ')} failed`);
  }
  let npm;
  try {
    await cp(join(checks, 'consumer'), consumer, { recursive: true });
    await mkdir(join(directory, 'artifacts'));
    for (const artifact of fork.metadata.artifacts) {
      await copyFile(join(fork.folder, artifact.artifact), join(directory, 'artifacts', artifact.artifact));
    }
    await cp(join(fork.folder, 'qualification-fixtures/pi'), join(consumer, 'test'), { recursive: true });
    await copyFile(join(fork.folder, 'qualification-fixtures/codex/codex-exec.mjs'), env.AGUI49_CODEX_FIXTURE);
    await chmod(env.AGUI49_CODEX_FIXTURE, 0o755);
    for (const name of ['all-imports.mjs', 'codex-esm.mjs', 'codex-commonjs.cjs']) {
      await copyFile(join(checks, name), join(consumer, name));
    }
    const npmVersion = spawnSync('npm', ['--version'], { ...processOptions, encoding: 'utf8' });
    results.push({ command: ['npm', '--version'], exitCode: npmVersion.status, signal: npmVersion.signal });
    console.log(JSON.stringify(results.at(-1)));
    process.stdout.write(npmVersion.stdout ?? '');
    process.stderr.write(npmVersion.stderr ?? '');
    assert.ifError(npmVersion.error);
    assert.equal(npmVersion.status, 0, 'npm --version failed');
    npm = npmVersion.stdout.trim();
    run('npm', ['ci', '--ignore-scripts', '--include=optional', '--no-audit', '--no-fund']);
    assert.deepEqual(await readFile(join(consumer, 'package-lock.json')), await readFile(join(checks, 'consumer/package-lock.json')), 'frozen consumer lock changed');
    verifyConsumerLock(consumer, fork, expected);
    verifyInstalled(consumer, expected);
    run(process.execPath, ['all-imports.mjs']);
    run(process.execPath, ['codex-esm.mjs']);
    run(process.execPath, ['codex-commonjs.cjs']);
    run(process.execPath, ['--test', 'test/adapter.test.ts', 'test/example.test.ts']);
    run('npm', ['ls', '--all', '--json']);
  } catch (error) {
    console.error(`Consumer evidence retained at ${directory}`);
    throw error;
  }
  await rm(directory, { recursive: true, force: true });
  console.log(JSON.stringify({ result: 'PASS', scope: 'controlled package consumer; no native provider or Apple qualification',
    sourceRevision: fork.metadata.sourceRevision, ...runtime, npm, temporaryDirectory: tmpdir(), sourceSha256, tar, results }));
}
