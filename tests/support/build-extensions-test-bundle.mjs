// Builds the extension test bundle: the browser application with every working-tree extension, for browser tests only.
// The product bundles (`web-dist`, `web-dist-browser`) contain no extensions.
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { desktopConfig } from '../../apps/desktop/vite.config.mjs';
import { workingTreePlan } from './working-tree-plan.mjs';

export const extensionTestAssets = fileURLToPath(new URL('../../apps/desktop/web-dist-extensions-test', import.meta.url));
const root = fileURLToPath(new URL('../../', import.meta.url));

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const config = desktopConfig('browser', workingTreePlan());
  await build({ ...config, configFile: false, mode: 'browser', root: join(root, 'apps/desktop'), logLevel: 'warn',
    build: { ...config.build, outDir: extensionTestAssets, emptyOutDir: true } });
  execFileSync(process.execPath, [join(root, 'scripts/artifact-manifest.mjs'), 'browser-development', '--directory', extensionTestAssets], { cwd: root, stdio: 'inherit' });
}
