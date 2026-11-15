import { execFile } from 'node:child_process';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { CustomizationError, serverCatalog } from '@agentui/host/customization';

import { serverCatalogLinkage } from './server-catalog-loader.mjs';

export const qualificationChild = new URL('./qualify-server-catalog.child.mjs', import.meta.url);
const execute = promisify(execFile);
export async function qualifyServerCatalog({ directory, manifest, abi }) {
  try {
    const linkage = serverCatalogLinkage({ directory, manifest, abi });
    const { manifests } = serverCatalog(manifest.packages, manifest.sdkVersion);
    const pending = execute(process.execPath, [fileURLToPath(qualificationChild)], {
      cwd: directory, env: { PATH: dirname(process.execPath), LANG: 'C', LC_ALL: 'C' },
      timeout: 5000, maxBuffer: 16_384, killSignal: 'SIGKILL', encoding: 'utf8',
    });
    pending.child.stdin.end(JSON.stringify({ ...linkage, manifests }));
    const { stdout } = await pending;
    if (!stdout.endsWith('agentui-catalog-qualified')) throw new Error();
  } catch { throw CustomizationError.fixed('entry-validation'); }
}
