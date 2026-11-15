import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'esbuild';
import { assertCompileCases } from '../../../support/compile.mjs';

const root = process.cwd();
function run(command, args, cwd) { const result = spawnSync(command, args, { cwd, encoding: 'utf8', timeout: 120000 }); assert.equal(result.status, 0, result.stdout + result.stderr); return result.stdout; }
test('packed tools consumer resolves its dependency and types without DOM', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agentui-tools-consumer-'));
  try {
    const packs = JSON.parse(run('npm', ['pack', './packages/sdk', './packages/contracts', './packages/protocol', './node_modules/@cfworker/json-schema', './node_modules/@ag-ui/core', '--json', '--ignore-scripts', '--pack-destination', dir], root));
    for (const pack of packs) { const dest = join(dir, 'node_modules', pack.name); await mkdir(dest, { recursive: true }); run('tar', ['-xzf', join(dir, pack.filename), '-C', dest, '--strip-components=1'], dir); }
    await writeFile(join(dir, 'package.json'), '{"type":"module"}');
    await writeFile(join(dir, 'tsconfig.json'), JSON.stringify({ extends: join(root, 'tsconfig.base.json') }));
    await assertCompileCases({ config: join(dir, 'tsconfig.json'), prefix: "import { createFrontendToolGeneration, type FrontendToolContribution } from '@agentui/sdk/tools';\n", cases: [
      ["const t: FrontendToolContribution<string> = { definition: { name: 'x', description: 'x' }, decodeInput() { return 'x'; }, async execute(x) { return x; } }; void createFrontendToolGeneration; void t;", null],
      ["const t: FrontendToolContribution<string> = { definition: { name: 'x', description: 'x' }, decodeInput() { return 1; }, async execute(x) { return x; } }; void t;", /not assignable/u],
      ['void document;', /Cannot find name 'document'/u],
    ] });
    run(process.execPath, ['--input-type=module', '-e', "import { createFrontendToolGeneration } from '@agentui/sdk/tools'; if (typeof createFrontendToolGeneration !== 'function') throw Error();"], dir);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('root and react bundles exclude the validator', async () => {
  for (const entry of ['@agentui/sdk', '@agentui/sdk/react']) {
    const result = await build({ stdin: { contents: `import * as sdk from '${entry}'; console.log(sdk);`, resolveDir: root }, bundle: true, platform: 'node', format: 'esm', write: false, metafile: true, external: ['react'] });
    assert.equal(Object.keys(result.metafile.inputs).some(path => path.includes('@cfworker/json-schema')), false);
  }
});
