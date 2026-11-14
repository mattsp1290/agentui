import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = new URL('../../../../', import.meta.url);
const compiler = fileURLToPath(new URL('node_modules/typescript/bin/tsc', root));

export async function assertCompileCases({ config = 'tsconfig.base.json', prefix, cases }) {
  const base = new URL(config, root);
  const audit = new URL('.audit/', base);
  await mkdir(audit, { recursive: true });
  const temporary = await mkdtemp(fileURLToPath(new URL('type-cases-', audit)));
  try {
    await writeFile(`${temporary}/tsconfig.json`, JSON.stringify({
      extends: fileURLToPath(base),
      compilerOptions: { noEmit: true, rootDir: temporary },
      files: [`${temporary}/probe.ts`], include: [],
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
