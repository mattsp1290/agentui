import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { build } from 'vite';
import { readCustomizationSnapshot } from '@agentui/host/customization';
import { readArtifactBytes } from '../apps/host/build/tsc/artifact.js';
import { customizationPlugin, desktopSelection } from './local-customization.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const { values } = parseArgs({ options: Object.fromEntries(['repository', 'commit', 'out'].map(name => [name, { type: 'string' }])) });
if (!values.repository || !values.commit || !values.out || values.repository.includes(':')) {
  throw new Error('Usage: node scripts/build-local-customization.mjs --repository LOCAL_PATH --commit FULL_ID --out FRESH_DIRECTORY');
}
const out = resolve(values.out);
let owned = false, scratch, snapshot;
try {
  await mkdir(out, { mode: 0o700 });
  owned = true;
  scratch = await realpath(await mkdtemp(join(dirname(out), '.agentui-build-')));
  snapshot = await readCustomizationSnapshot({ repository: resolve(values.repository), commit: values.commit, scratchParent: scratch });
  const selected = await desktopSelection(snapshot);
  const stage = join(scratch, 'browser');
  await build({ root: join(root, 'apps/desktop'), configFile: join(root, 'apps/desktop/vite.config.mjs'), mode: 'browser',
    plugins: [customizationPlugin(snapshot, selected)], build: { outDir: stage, emptyOutDir: true } });
  await writeFile(join(stage, 'customization-identity.json'), JSON.stringify({ commit: snapshot.commit,
    namespace: selected?.manifest.namespace ?? null, module: selected?.module ?? null }) + '\n');
  execFileSync(process.execPath, [join(root, 'scripts/artifact-manifest.mjs'), 'browser-development', '--directory', stage], { cwd: root, stdio: 'inherit' });
  const { manifest } = readArtifactBytes(stage, 'browser-development');
  await rename(stage, out);
  owned = false;
  process.stdout.write(`${JSON.stringify({ directory: out, artifactId: manifest.artifactId, commit: snapshot.commit })}\n`);
} finally {
  await snapshot?.dispose();
  if (scratch) await rm(scratch, { recursive: true, force: true });
  if (owned) await rm(out, { recursive: true, force: true });
}
