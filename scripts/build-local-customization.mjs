import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { build } from 'vite';
import { readArtifactBytes } from '../apps/host/build/tsc/artifact.js';
import { prepareCustomizationSources } from './prepare-customization-sources.mjs';
import { customizationPlugin, desktopSelection } from './local-customization.mjs';
import { qualifyDesktopArtifact } from './desktop-customization-qualifier.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const { values } = parseArgs({ options: Object.fromEntries(['repository', 'commit', 'subdirectory', 'out'].map(name => [name, { type: 'string' }])) });
if (!values.repository || !values.commit || !values.out) {
  throw new Error('Usage: node scripts/build-local-customization.mjs --repository PATH_OR_URL --commit FULL_ID --out FRESH_DIRECTORY [--subdirectory PATH]');
}
const out = resolve(values.out);
let owned = false, scratch, prepared;
try {
  await mkdir(out, { mode: 0o700 });
  owned = true;
  scratch = await realpath(await mkdtemp(join(dirname(out), '.agentui-build-')));
  prepared = await prepareCustomizationSources({ reference: { repository: values.repository, commit: values.commit,
    ...(values.subdirectory ? { subdirectory: values.subdirectory } : {}) }, scratchParent: scratch });
  const plan = desktopSelection(prepared.root);
  const stage = join(scratch, 'browser');
  const result = await build({ root: join(root, 'apps/desktop'), configFile: join(root, 'apps/desktop/vite.config.mjs'), mode: 'browser',
    plugins: [customizationPlugin(plan)], build: { outDir: stage, emptyOutDir: true } });
  const builds = Array.isArray(result) ? result : [result];
  const outputs = builds.flatMap(item => item.output);
  const paths = new Set(outputs.map(item => item.fileName));
  for (const item of outputs) {
    if (item.type === 'chunk' && [...item.imports, ...item.dynamicImports].some(path => !paths.has(path))) throw new Error('Unsupported external desktop import');
  }
  const qualifier = outputs.find(item => item.type === 'chunk' && item.facadeModuleId === '\0agentui-desktop-qualifier');
  if (!qualifier) throw new Error('Missing desktop qualification entry');
  await writeFile(join(stage, 'customization-identity.json'), JSON.stringify(plan.catalog) + '\n');
  execFileSync(process.execPath, [join(root, 'scripts/artifact-manifest.mjs'), 'browser-development', '--directory', stage], { cwd: root, stdio: 'inherit' });
  const verified = readArtifactBytes(stage, 'browser-development');
  const catalog = JSON.parse(verified.files.get('customization-identity.json').toString());
  await qualifyDesktopArtifact({ files: verified.files, entry: qualifier.fileName, namespaces: catalog.entries.map(entry => entry.manifest.namespace) });
  const final = readArtifactBytes(stage, 'browser-development');
  if (verified.manifest.artifactId !== final.manifest.artifactId || verified.files.size !== final.files.size ||
    [...verified.files].some(([path, bytes]) => !final.files.get(path)?.equals(bytes))) throw new Error('Desktop artifact changed during qualification');
  await rename(stage, out);
  owned = false;
  process.stdout.write(`${JSON.stringify({ directory: out, artifactId: verified.manifest.artifactId, root: prepared.root.identity })}\n`);
} finally {
  try { await prepared?.dispose(); }
  finally {
    try { if (scratch) await rm(scratch, { recursive: true, force: true }); }
    finally { if (owned) await rm(out, { recursive: true, force: true }); }
  }
}
