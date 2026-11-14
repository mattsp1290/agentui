import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = new URL('../../../../', import.meta.url);
const compiler = fileURLToPath(new URL('node_modules/typescript/bin/tsc', root));

export async function assertCompileCases({ prefix, cases, compilerOptions = {} }) {
  await mkdir(new URL('.audit/', root), { recursive: true });
  const temporary = await mkdtemp(fileURLToPath(new URL('.audit/type-cases-', root)));
  try {
    await writeFile(`${temporary}/tsconfig.json`, JSON.stringify({
      extends: fileURLToPath(new URL('tsconfig.base.json', root)),
      compilerOptions: { noEmit: true, ...compilerOptions }, files: ['probe.ts'],
    }));
    for (const [source, diagnostic] of cases) {
      await writeFile(`${temporary}/probe.ts`, prefix + source);
      const result = spawnSync(process.execPath, [compiler, '-p', `${temporary}/tsconfig.json`, '--pretty', 'false'], { encoding: 'utf8' });
      const context = `${source || '<control>'}\n${result.stdout}${result.stderr}`;
      if (diagnostic === null) assert.equal(result.status, 0, context);
      else {
        assert.notEqual(result.status, 0, context);
        assert.match(result.stdout, diagnostic, context);
      }
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
