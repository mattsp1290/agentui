import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = new URL('../../../', import.meta.url);
const compiler = fileURLToPath(new URL('node_modules/typescript/bin/tsc', root));

test('controlled qualification declarations resolve through the development alias', async () => {
  const audit = new URL('packages/adapter-tests/.audit/', root);
  await mkdir(audit, { recursive: true });
  const temporary = await mkdtemp(fileURLToPath(new URL('qualification-consumer-', audit)));
  try {
    await writeFile(`${temporary}/tsconfig.json`, JSON.stringify({
      extends: fileURLToPath(new URL('tsconfig.base.json', root)),
      compilerOptions: { noEmit: true, rootDir: temporary, types: ['node'] },
      files: [`${temporary}/probe.ts`], include: [],
    }));
    const prefix = `import { contracts, createFakeFixture } from '@agentui/switchboard-qualification/testkit';
import type { QualificationFactory, QualificationFixture, QualificationContract, QualificationConnection, RecoverableSnapshot } from '@agentui/switchboard-qualification/testkit';
export const factory: QualificationFactory = createFakeFixture;
export const asyncFactory: QualificationFactory = async () => createFakeFixture();
export const fixture: QualificationFixture = createFakeFixture();
export const contract: QualificationContract = contracts.uncertainty;
export const connection: QualificationConnection = fixture.connect(() => {});
export function recover(saved: RecoverableSnapshot) { return connection.recover(saved); }
export async function run(signal: AbortSignal) {
  await Promise.all(Object.values(contracts).map((check) => check(factory, signal)));
}
`;
    const cases = [
      ['', null],
      ['export const missing = contracts.missing;', /Property 'missing' does not exist/u],
      ['export const invalidSnapshot: RecoverableSnapshot = {};', /missing the following properties/u],
      ['export const invalid: QualificationFactory = () => ({});', /not assignable|missing the following properties/u],
      ["export { createFakeFixture as privateFake } from '@agentui/switchboard-qualification';", /has no exported member/u],
      ["export { createFakeFixture as privateFake } from '@agentui/switchboard-qualification/src/testkit/index.ts';", /Cannot find module/u],
      ["export { createFakeFixture as privateFake } from '@agentui/switchboard-qualification/dist/testkit/fake.js';", /Cannot find module/u],
    ];
    for (const [source, diagnostic] of cases) {
      await writeFile(`${temporary}/probe.ts`, prefix + source);
      const result = spawnSync(process.execPath, [compiler, '-p', `${temporary}/tsconfig.json`, '--pretty', 'false'], { encoding: 'utf8' });
      assert.ifError(result.error);
      const output = `${source || '<public alias control>'}\n${result.stdout}${result.stderr}`;
      if (diagnostic === null) assert.equal(result.status, 0, output);
      else {
        assert.notEqual(result.status, 0, output);
        assert.match(result.stdout, diagnostic, output);
      }
    }
    // The production testkit exports contracts. A pin from before that export reports the module missing.
    const production = "import { contracts as productionContracts } from '@mattsp1290/switchboard/testkit';\nexport const productionUncertainty: QualificationContract = productionContracts.uncertainty;\n";
    await writeFile(`${temporary}/probe.ts`, prefix + production);
    const productionResult = spawnSync(process.execPath, [compiler, '-p', `${temporary}/tsconfig.json`, '--pretty', 'false'], { encoding: 'utf8' });
    assert.ifError(productionResult.error);
    const productionOutput = `${productionResult.stdout}${productionResult.stderr}`;
    if (productionResult.status !== 0) assert.match(productionOutput, /Cannot find module|has no exported member/u, productionOutput);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
