import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');

export async function serverCustomizationAbi() {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const sdk = import.meta.resolve('@agentui/sdk');
  const result = await build({ absWorkingDir: root, entryPoints: [fileURLToPath(sdk)], bundle: true, write: false, metafile: true,
    platform: 'node', format: 'esm', treeShaking: false, logLevel: 'silent' });
  const graph = [];
  const files = [];
  for (const path of Object.keys(result.metafile.inputs)) {
    const absolute = resolve(root, path);
    let owner = dirname(absolute), pkg;
    while (!pkg) {
      try { pkg = JSON.parse(await readFile(join(owner, 'package.json'), 'utf8')); }
      catch (error) {
        const parent = dirname(owner);
        if (error.code !== 'ENOENT' || parent === owner) throw new Error('Invalid host SDK ABI.');
        owner = parent;
      }
    }
    files.push(pathToFileURL(absolute).href);
    graph.push({ package: pkg.name, version: pkg.version, path: relative(owner, absolute).split('\\').join('/'), sha256: hash(await readFile(absolute)) });
  }
  graph.sort((a, b) => JSON.stringify(a) < JSON.stringify(b) ? -1 : JSON.stringify(a) > JSON.stringify(b) ? 1 : 0);
  const imports = Object.freeze({ '@agentui/sdk': sdk });
  return Object.freeze({ imports, files: Object.freeze(files), identity: hash(JSON.stringify(['agentui-server-abi-v1', Object.keys(imports), graph])) });
}
