import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { builtinModules } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { build } from 'esbuild';

export const isNodeBuiltin = specifier => builtinModules.includes(specifier) || specifier.startsWith('node:') && builtinModules.includes(specifier.slice(5));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const execute = promisify(execFile);

export async function serverCustomizationAbi() {
  const sdk = import.meta.resolve('@agentui/sdk');
  const result = await build({ entryPoints: [fileURLToPath(sdk)], bundle: true, write: false, metafile: true,
    platform: 'node', format: 'esm', treeShaking: false, logLevel: 'silent' });
  const graph = [];
  const files = [];
  for (const path of Object.keys(result.metafile.inputs)) {
    const absolute = resolve(path);
    let owner = dirname(absolute), pkg;
    while (!pkg) {
      try { pkg = JSON.parse(await readFile(join(owner, 'package.json'), 'utf8')); }
      catch { const parent = dirname(owner); if (parent === owner) throw new Error('Invalid host SDK ABI.'); owner = parent; }
    }
    files.push(pathToFileURL(absolute).href);
    graph.push({ package: pkg.name, version: pkg.version, path: relative(owner, absolute).split('\\').join('/'), sha256: hash(await readFile(absolute)) });
  }
  graph.sort((a, b) => JSON.stringify(a) < JSON.stringify(b) ? -1 : JSON.stringify(a) > JSON.stringify(b) ? 1 : 0);
  const imports = Object.freeze({ '@agentui/sdk': sdk });
  return Object.freeze({ imports, files: Object.freeze(files), identity: hash(JSON.stringify(['agentui-server-abi-v1', Object.keys(imports), graph])) });
}

export async function qualifyServerCatalog({ directory, manifest, abi }) {
  const catalog = pathToFileURL(join(directory, manifest.catalog)).href;
  const allowed = [...abi.files, ...manifest.assets.map(asset => pathToFileURL(join(directory, asset.path)).href)];
  const program = `
    import { registerHooks, isBuiltin } from 'node:module';
    const imports = ${JSON.stringify(abi.imports)};
    const allowed = new Set(${JSON.stringify(allowed)});
    registerHooks({ resolve(specifier, context, next) {
      if (Object.hasOwn(imports, specifier)) return { url: imports[specifier], shortCircuit: true };
      if (isBuiltin(specifier)) return next(specifier, context);
      const resolved = next(specifier, context);
      if (!allowed.has(resolved.url)) throw new Error('Unsupported catalog import');
      return resolved;
    } });
    try {
      const { checkExtensionEntrypoint } = await import('@agentui/sdk');
      const catalog = await import(${JSON.stringify(catalog)});
      const manifests = ${JSON.stringify(manifest.entries.map(entry => manifest.packages.find(pkg => pkg.identity === entry.packageIdentity).local.manifest))};
      if (!Array.isArray(catalog.entries) || catalog.entries.length !== manifests.length) process.exit(1);
      for (let index = 0; index < manifests.length; index++) {
        if (checkExtensionEntrypoint(manifests[index], 'server', catalog.entries[index]).kind !== 'compatible') process.exit(1);
      }
      process.stdout.write('agentui-catalog-qualified');
      process.exit(0);
    } catch { process.exit(1); }
  `;
  try {
    const { stdout } = await execute(process.execPath, ['--input-type=module', '-e', program], {
      cwd: directory, env: { PATH: dirname(process.execPath), LANG: 'C', LC_ALL: 'C' },
      timeout: 5000, maxBuffer: 16_384, killSignal: 'SIGKILL', encoding: 'utf8',
    });
    if (!stdout.endsWith('agentui-catalog-qualified')) throw new Error();
  } catch { throw Object.assign(new Error('Server customization entry validation failed.'), { code: 'entry-validation' }); }
}
