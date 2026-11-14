import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { verifyFork, verifyConsumerLock, verifyInstalled, tarVersion, fullConsumerScope } from './lib/agui-fork.mjs';

const args = process.argv.slice(2);
assert.ok(args.length === 0 || (args.length === 1 && args[0] === '--offline'), 'Usage: node scripts/verify-agui-fork.mjs [--offline]');
const offline = args[0] === '--offline';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const checks = join(root, 'tests/dependencies/ag-ui');
const consumerScripts = ['all-imports.mjs', 'codex-esm.mjs', 'codex-commonjs.cjs'];
const sha256 = (body) => createHash('sha256').update(body).digest('hex');
const [major, minor] = process.versions.node.split('.').map(Number);
assert(major > 22 || (major === 22 && minor >= 19), 'Node >=22.19 is required');
assert(process.platform !== 'win32', 'Controlled Codex supervision requires POSIX');
const runtime = { node: process.version, execPath: process.execPath, platform: process.platform, arch: process.arch,
  inheritedRuntimeConfig: Object.keys(process.env).filter((key) => /^(NODE_OPTIONS$|npm_config_)/iu.test(key)).sort(),
  nodeOptionsSha256: process.env.NODE_OPTIONS === undefined ? null : sha256(process.env.NODE_OPTIONS) };
const sourceBytes = new Map(await Promise.all([
  'scripts/lib/agui-fork.mjs', 'scripts/verify-agui-fork.mjs',
  ...consumerScripts.map((name) => `tests/dependencies/ag-ui/${name}`),
].map(async (file) => [file, await readFile(join(root, file))])));
const sourceSha256 = Object.fromEntries([...sourceBytes].map(([file, body]) => [file, sha256(body)]));
const tar = tarVersion();
const fork = verifyFork(root);
const provenance = { path: fork.provenancePath, sha256: fork.provenanceSha256 };
const qualificationSha256 = fork.qualificationSha256;
verifyConsumerLock(join(checks, 'consumer'), fork);
if (offline) {
  console.log(JSON.stringify({ result: 'PASS', scope: 'retained archives, evidence, source lock, fixtures and frozen consumer lock',
    sourceRevision: fork.metadata.sourceRevision, provenance, qualificationSha256, localAguiArchives: fork.packages.size, installed: false, ...runtime, sourceSha256, tar }));
} else {
  await qualifyInstalledConsumer(fork);
}

async function copyExactly(source, target, names, label) {
  assert.deepEqual((await readdir(source)).sort(), [...names].sort(), `${label}: unexpected or missing inputs in ${source}`);
  await mkdir(target, { recursive: true });
  for (const name of names) await copyFile(join(source, name), join(target, name));
}

async function qualifyInstalledConsumer(fork) {
  const directory = await mkdtemp(join(tmpdir(), 'agentui-agui-fork-'));
  const consumer = join(directory, 'consumer');
  const env = { ...process.env, PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ''}`, CODEX_TEST_MODE: '1', CODEX_FIXTURE_DIR: join(directory, 'fixture'), AGUI49_CODEX_FIXTURE: join(consumer, 'codex-exec.mjs') };
  const results = [];
  const processOptions = { cwd: consumer, env, timeout: 180000, maxBuffer: 16 * 1024 * 1024 };
  function run(command, commandArgs, { capture = false } = {}) {
    const result = spawnSync(command, commandArgs, { ...processOptions, encoding: 'utf8', stdio: capture ? 'pipe' : 'inherit' });
    results.push({ command: [command, ...commandArgs], exitCode: result.status, signal: result.signal });
    if (capture) {
      process.stdout.write(result.stdout ?? '');
      process.stderr.write(result.stderr ?? '');
    }
    console.log(JSON.stringify(results.at(-1)));
    assert.ifError(result.error);
    assert.equal(result.status, 0, `${command} ${commandArgs.join(' ')} failed`);
    return result.stdout;
  }
  let npm;
  try {
    await copyExactly(join(checks, 'consumer'), consumer, ['package.json', 'package-lock.json'], 'frozen consumer');
    await mkdir(join(directory, 'artifacts'));
    for (const artifact of fork.metadata.artifacts) {
      await copyFile(join(fork.folder, artifact.artifact), join(directory, 'artifacts', artifact.artifact));
    }
    const piPrefix = 'qualification-fixtures/pi/';
    const piFixtures = fork.fixturePaths.filter((file) => file.startsWith(piPrefix)).map((file) => file.slice(piPrefix.length));
    await copyExactly(join(fork.folder, 'qualification-fixtures/pi'), join(consumer, 'test'), piFixtures, 'Pi fixtures');
    await copyFile(join(fork.folder, fork.codexFixture), env.AGUI49_CODEX_FIXTURE);
    await chmod(env.AGUI49_CODEX_FIXTURE, 0o755);
    for (const name of consumerScripts) {
      await writeFile(join(consumer, name), sourceBytes.get(`tests/dependencies/ag-ui/${name}`));
    }
    npm = run('npm', ['--version'], { capture: true }).trim();
    run('npm', ['ci', '--ignore-scripts', '--include=optional', '--no-audit', '--no-fund']);
    verifyConsumerLock(consumer, fork);
    verifyInstalled(consumer, fork);
    for (const name of consumerScripts) run(process.execPath, [name]);
    run(process.execPath, ['--test', 'test/adapter.test.ts', 'test/example.test.ts']);
    run('npm', ['ls', '--all', '--json']);
  } catch (error) {
    console.error(`Consumer evidence retained at ${directory}`);
    throw error;
  }
  await rm(directory, { recursive: true, force: true });
  console.log(JSON.stringify({ result: 'PASS', scope: fullConsumerScope,
    sourceRevision: fork.metadata.sourceRevision, provenance, qualificationSha256, ...runtime, npm, temporaryDirectory: tmpdir(), sourceSha256, tar, results }));
}
