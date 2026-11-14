import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, copyFile, cp, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const checks = join(root, 'tests/dependencies/ag-ui');
const vendor = join(root, 'vendor/ag-ui/ed2c1d5b63299d3f08676a1418cc2640bbe55fd1');
const [major, minor] = process.versions.node.split('.').map(Number);
assert(major > 22 || (major === 22 && minor >= 19), 'Node >=22.19 is required');
assert(process.platform !== 'win32', 'Controlled Codex supervision requires POSIX');
const provenance = JSON.parse(await readFile(join(vendor, 'provenance.json'), 'utf8'));
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
  run('python3', [join(checks, 'verify-consumer.py')], root);
  await cp(join(checks, 'consumer'), consumer, { recursive: true });
  await mkdir(join(directory, 'artifacts'));
  for (const artifact of provenance.artifacts) {
    await copyFile(join(vendor, artifact.artifact), join(directory, 'artifacts', artifact.artifact));
  }
  await cp(join(vendor, 'qualification-fixtures/pi'), join(consumer, 'test'), { recursive: true });
  await copyFile(join(vendor, 'qualification-fixtures/codex/codex-exec.mjs'), env.AGUI49_CODEX_FIXTURE);
  await chmod(env.AGUI49_CODEX_FIXTURE, 0o755);
  for (const name of ['all-imports.mjs', 'codex-esm.mjs', 'codex-commonjs.cjs']) {
    await copyFile(join(checks, name), join(consumer, name));
  }
  run('npm', ['ci', '--ignore-scripts', '--include=optional', '--no-audit', '--no-fund']);
  assert.equal(await readFile(join(consumer, 'package-lock.json'), 'utf8'), await readFile(join(checks, 'consumer/package-lock.json'), 'utf8'), 'frozen consumer lock changed');
  run('python3', [join(checks, 'verify-consumer.py'), consumer]);
  run('node', ['all-imports.mjs']);
  run('node', ['codex-esm.mjs']);
  run('node', ['codex-commonjs.cjs']);
  run('node', ['--test', 'test/adapter.test.ts', 'test/example.test.ts']);
  run('npm', ['ls', '--all', '--json']);
  console.log(JSON.stringify({ result: 'PASS', scope: 'controlled package consumer; no native provider or Apple qualification', sourceRevision: provenance.sourceRevision, node: process.version, platform: process.platform, arch: process.arch, results }));
  await rm(directory, { recursive: true, force: true });
} catch (error) {
  console.error(`Consumer evidence retained at ${directory}`);
  throw error;
}
