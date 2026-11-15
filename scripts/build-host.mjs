import { build } from 'esbuild';
import { mkdirSync, writeFileSync } from 'node:fs';
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
  banner: { js: "import { createRequire as hostCreateRequire } from 'node:module'; const require = hostCreateRequire(import.meta.url);" },
  plugins: [{
    name: 'optional-websocket-acceleration',
    setup(plugin) {
      plugin.onResolve({ filter: /^(bufferutil|utf-8-validate)$/ }, args => {
        if (!/[/\\]ws[/\\]lib[/\\]/.test(args.importer)) return undefined;
        return { path: args.path, namespace: 'optional-websocket-acceleration' };
      });
      plugin.onLoad({ filter: /.*/, namespace: 'optional-websocket-acceleration' }, () => ({
        contents: "throw new Error('Optional native WebSocket acceleration is unavailable');", loader: 'js',
      }));
    },
  }],
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
for (const file of result.outputFiles) {
  mkdirSync(dirname(file.path), { recursive: true });
  writeFileSync(file.path, file.contents);
}
writeFileSync(join(root, 'apps/host/dist/runtime-graph.json'), `${JSON.stringify(result.metafile, null, 2)}\n`);
