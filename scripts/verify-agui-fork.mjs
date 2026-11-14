import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmod, copyFile, cp, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveLockedFork } from './lib/agui-fork.mjs';
import { verifyArchives, verifyConsumerLock, verifyInstalled } from '../tests/dependencies/ag-ui/verify-consumer.mjs';

const args = process.argv.slice(2);
assert.ok(args.length === 0 || (args.length === 1 && args[0] === '--offline'), 'Usage: node scripts/verify-agui-fork.mjs [--offline]');
const offline = args.length === 1;
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const checks = join(root, 'tests/dependencies/ag-ui');
const [major, minor] = process.versions.node.split('.').map(Number);
assert(major > 22 || (major === 22 && minor >= 19), 'Node >=22.19 is required');
assert(process.platform !== 'win32', 'Controlled Codex supervision requires POSIX');
const fork = resolveLockedFork(root);
const expected = verifyArchives(fork);
verifyConsumerLock(join(checks, 'consumer'), fork, expected);
const tarEnv = { ...process.env, LC_ALL: 'C' };
delete tarEnv.TAR_OPTIONS;
const tar = execFileSync('tar', ['--version'], { env: tarEnv, encoding: 'utf8', timeout: 60_000, maxBuffer: 16 * 1024 * 1024 }).split('\n')[0];
if (offline) {
  console.log(JSON.stringify({ result: 'PASS', scope: 'retained archives and frozen consumer lock',
    sourceRevision: fork.metadata.sourceRevision, localAguiArchives: expected.size, installed: false, tar }));
} else {
  await qualifyInstalledConsumer(fork, expected);
}

async function qualifyInstalledConsumer(fork, expected) {
  const directory = await mkdtemp(join(tmpdir(), 'agentui-agui-fork-'));
  const consumer = join(directory, 'consumer');
  const env = { ...process.env, CODEX_TEST_MODE: '1', CODEX_FIXTURE_DIR: join(directory, 'fixture'), AGUI49_CODEX_FIXTURE: join(consumer, 'codex-exec.mjs') };
  const results = [];
  function run(command, args, cwd = consumer) {
    const result = spawnSync(command, args, { cwd, env, stdio: 'inherit', timeout: 180000 });
    results.push({ command: [command, ...args], exitCode: result.status, signal: result.signal });
    console.log(JSON.stringify(results.at(-1)));
    assert.ifError(result.error);
    assert.equal(result.status, 0, `${command} ${args.join(' ')} failed`);
  }
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
    run('npm', ['ci', '--ignore-scripts', '--include=optional', '--no-audit', '--no-fund']);
    assert.deepEqual(await readFile(join(consumer, 'package-lock.json')), await readFile(join(checks, 'consumer/package-lock.json')), 'frozen consumer lock changed');
    verifyConsumerLock(consumer, fork, expected);
    verifyInstalled(consumer, expected);
    run('node', ['all-imports.mjs']);
    run('node', ['codex-esm.mjs']);
    run('node', ['codex-commonjs.cjs']);
    run('node', ['--test', 'test/adapter.test.ts', 'test/example.test.ts']);
    run('npm', ['ls', '--all', '--json']);
    console.log(JSON.stringify({ result: 'PASS', scope: 'controlled package consumer; no native provider or Apple qualification', sourceRevision: fork.metadata.sourceRevision, node: process.version, platform: process.platform, arch: process.arch, tar, results }));
    await rm(directory, { recursive: true, force: true });
  } catch (error) {
    console.error(`Consumer evidence retained at ${directory}`);
    throw error;
  }
}
