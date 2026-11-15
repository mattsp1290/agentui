import { execFile } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { CustomizationError } from '@agentui/host/customization';

const execute = promisify(execFile);
export async function qualifyServerCatalog({ directory, manifest, manifests, abi }) {
  const catalog = pathToFileURL(join(directory, manifest.catalog)).href;
  const allowed = [...abi.files, ...manifest.assets.map(asset => pathToFileURL(join(directory, asset.path)).href)];
  try {
    const pending = execute(process.execPath, [fileURLToPath(new URL('./qualify-server-catalog.child.mjs', import.meta.url))], {
      cwd: directory, env: { PATH: dirname(process.execPath), LANG: 'C', LC_ALL: 'C' },
      timeout: 5000, maxBuffer: 16_384, killSignal: 'SIGKILL', encoding: 'utf8',
    });
    pending.child.stdin.end(JSON.stringify({ catalog, imports: abi.imports, allowed, manifests }));
    const { stdout } = await pending;
    if (!stdout.endsWith('agentui-catalog-qualified')) throw new Error();
  } catch { throw CustomizationError.server('entry-validation'); }
}
