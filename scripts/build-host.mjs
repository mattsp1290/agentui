import { build } from 'esbuild';
import { writeFileSync } from 'node:fs';
import { isBuiltin } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const result = await build({
  absWorkingDir: root,
  entryPoints: ['apps/host/src/main.ts'],
  outfile: 'apps/host/dist/main.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  sourcemap: true,
  metafile: true,
  write: false,
  logLevel: 'silent',
});
if (result.warnings.length > 0) throw new Error(`Host bundle warnings: ${result.warnings.map(warning => warning.text).join('; ')}`);
for (const output of Object.values(result.metafile.outputs)) {
  for (const imported of output.imports) {
    if (!imported.external || !isBuiltin(imported.path)) throw new Error(`Host bundle has an external runtime dependency: ${imported.path}`);
  }
}
for (const file of result.outputFiles) writeFileSync(file.path, file.contents);
writeFileSync(join(root, 'apps/host/dist/runtime-graph.json'), `${JSON.stringify(result.metafile, null, 2)}\n`);
