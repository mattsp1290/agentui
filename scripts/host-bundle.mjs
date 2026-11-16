import { build } from 'esbuild';
import { isBuiltin } from 'node:module';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

export async function buildHostBundle({ abi, entryPoint = 'apps/host/src/main.ts', outdir = 'apps/host/dist' }) {
  const result = await build({
    absWorkingDir: root,
    entryPoints: { main: entryPoint, sdk: 'packages/sdk/dist/index.js' },
    outdir,
    splitting: true,
    chunkNames: 'chunks/[name]-[hash]',
    define: { AGENTUI_SERVER_CUSTOMIZATION_ABI: JSON.stringify(abi.identity) },
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
      if (imported.external ? !isBuiltin(imported.path) : !Object.hasOwn(result.metafile.outputs, imported.path)) throw new Error(`Host bundle has an external runtime dependency: ${imported.path}`);
    }
  }
  const outputs = Object.values(result.metafile.outputs);
  const sdkOwners = Object.entries(result.metafile.outputs).filter(([, output]) => Object.hasOwn(output.inputs, 'packages/sdk/dist/extensions.js'));
  if (sdkOwners.length !== 1) throw new Error('Host bundle must have one shared SDK runtime module graph');
  const shared = sdkOwners[0][0];
  for (const entry of [entryPoint, 'packages/sdk/dist/index.js']) {
    const output = outputs.find(value => value.entryPoint === entry);
    if (!output?.imports.some(value => value.path === shared)) throw new Error(`Host bundle entry must import the shared SDK runtime: ${entry}`);
  }
  return result;
}
