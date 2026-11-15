import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'agentui-runtime-contract-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, 'scripts'));
  for (const name of ['agentui-launch.mjs', 'agentui-runtime.mjs', 'agentui-launch-session.mjs']) {
    await copyFile(new URL(`../../scripts/${name}`, import.meta.url), join(directory, 'scripts', name));
  }
  await writeFile(join(directory, 'package.json'), '{"type":"module"}\n');
  await writeFile(join(directory, '.node-version'), `${process.versions.node}\n`);
  return { directory, entry: join(directory, 'scripts', 'agentui-launch.mjs') };
}

test('launcher help works before dependencies or build artifacts exist', async t => {
  const { entry } = await fixture(t);
  const result = spawnSync(process.execPath, [entry, '--help'], { encoding: 'utf8', timeout: 5000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Usage: \.\/agentui/);
  assert.equal(result.stderr, '');
});

test('server setup follows the emitted Codex runtime contract', async t => {
  const { directory, entry } = await fixture(t);
  const contracts = join(directory, 'node_modules', '@agentui', 'contracts');
  await mkdir(contracts, { recursive: true });
  await writeFile(join(contracts, 'package.json'), JSON.stringify({
    type: 'module', exports: { './compatibility': { import: './compatibility.mjs' } },
  }));
  for (const [path, artifact] of [
    ['apps/host/dist', { platform: 'host', artifactId: 'a'.repeat(64), artifactRuntime: { engine: 'node', version: process.versions.node } }],
    ['apps/desktop/web-dist-browser', { platform: 'browser-development', artifactId: 'b'.repeat(64) }],
  ]) {
    await mkdir(join(directory, path), { recursive: true });
    await writeFile(join(directory, path, 'artifact.json'), JSON.stringify(artifact));
  }
  const bin = join(directory, 'bin'), capture = join(directory, 'setup.sh');
  await mkdir(bin);
  await writeFile(join(bin, 'ssh'), `#!${process.execPath}
import {writeFileSync} from 'node:fs';
let script='';
process.stdin.setEncoding('utf8').on('data',part=>{script+=part;}).on('end',()=>{
  writeFileSync(${JSON.stringify(capture)},script);
  process.exitCode=23;
});
`, { mode: 0o755 });
  for (const version of ['9.9.9-review-probe', '9.9.10-review-probe']) {
    await writeFile(join(contracts, 'compatibility.mjs'), `export const CODEX_RUNTIME = {version:${JSON.stringify(version)}};\n`);
    const result = spawnSync(process.execPath, [entry, '--skip-build', '--no-open', '--agent', 'codex', '--ssh', 'fixture'], {
      encoding: 'utf8', timeout: 5000, env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    });
    assert.ifError(result.error);
    assert.equal(result.status, 23, result.stderr);
    const script = await readFile(capture, 'utf8');
    assert.equal(script.match(/@openai\/codex@([^']+)/)?.[1], version, 'installer must follow the emitted host requirement');
    assert.ok(script.includes(`codex-${version}`), 'private executable directory must follow the host requirement');
    assert.ok(script.includes(`codex-cli ${version}`), 'executable check must follow the host requirement');
  }
});
