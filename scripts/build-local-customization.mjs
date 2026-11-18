import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { build } from 'vite';
import { readArtifactBytes } from '../apps/host/build/tsc/artifact.js';
import { prepareCustomizationSources } from './prepare-customization-sources.mjs';
import { desktopPlan } from './local-customization.mjs';
import { qualifyDesktopArtifact } from './desktop-customization-qualifier.mjs';
import { desktopConfig } from '../apps/desktop/vite.config.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));

export class DesktopQualificationFailed extends Error {}

/**
 * Builds and qualifies the desktop application for an already prepared source graph, then renames it into `out`, which
 * must not exist. `scratchParent` holds the staging directory (default: beside `out`).
 */
export async function buildDesktopFromPrepared({ prepared, out, scratchParent, reserved = false }) {
  out = resolve(out);
  let owned = reserved, scratch;
  try {
    if (!reserved) await mkdir(out, { mode: 0o700 });
    owned = true;
    const parent = scratchParent ?? dirname(out);
    await mkdir(parent, { recursive: true, mode: 0o700 });
    scratch = await realpath(await mkdtemp(join(parent, '.agentui-build-')));
    const plan = desktopPlan(prepared.root);
    const stage = join(scratch, 'browser');
    // The desktop Vite configuration builds this plan alone and qualification checks its namespaces.
    const config = desktopConfig('browser', plan);
    const result = await build({ ...config, configFile: false, mode: 'browser', root: join(root, 'apps/desktop'), logLevel: 'warn',
      build: { ...config.build, outDir: stage, emptyOutDir: true } });
    const builds = Array.isArray(result) ? result : [result];
    const outputs = builds.flatMap(item => item.output);
    const paths = new Set(outputs.map(item => item.fileName));
    for (const item of outputs) {
      if (item.type === 'chunk' && [...item.imports, ...item.dynamicImports].some(path => !paths.has(path))) throw new Error('Unsupported external desktop import');
    }
    await writeFile(join(stage, 'customization-identity.json'), JSON.stringify(plan.identity) + '\n');
    execFileSync(process.execPath, [join(root, 'scripts/artifact-manifest.mjs'), 'browser-development', '--directory', stage], { cwd: root, stdio: ['ignore', 'ignore', 'inherit'] });
    const verified = readArtifactBytes(stage, 'browser-development');
    try { await qualifyDesktopArtifact({ files: verified.files, namespaces: plan.entries.map(entry => entry.manifest.namespace) }); }
    catch (error) { throw Object.assign(new DesktopQualificationFailed(error.message), { cause: error }); }
    const final = readArtifactBytes(stage, 'browser-development');
    if (verified.manifest.artifactId !== final.manifest.artifactId) throw new Error('Desktop artifact changed during qualification');
    await rename(stage, out);
    owned = false;
    return { directory: out, artifactId: verified.manifest.artifactId, root: prepared.root.identity, namespaces: plan.entries.map(entry => entry.manifest.namespace) };
  } finally {
    try { if (scratch) await rm(scratch, { recursive: true, force: true }); }
    finally { if (owned) await rm(out, { recursive: true, force: true }); }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: Object.fromEntries(['repository', 'commit', 'subdirectory', 'out'].map(name => [name, { type: 'string' }])) });
  if (!values.repository || !values.commit || !values.out) {
    throw new Error('Usage: node scripts/build-local-customization.mjs --repository PATH_OR_URL --commit FULL_ID --out FRESH_DIRECTORY [--subdirectory PATH]');
  }
  const out = resolve(values.out);
  // Claim the output before any preparation work; an existing directory fails here and stays untouched.
  await mkdir(out, { mode: 0o700 });
  let scratch, prepared, handed = false;
  try {
    scratch = await realpath(await mkdtemp(join(dirname(out), '.agentui-build-')));
    prepared = await prepareCustomizationSources({ reference: { repository: values.repository, commit: values.commit,
      ...(values.subdirectory ? { subdirectory: values.subdirectory } : {}) }, scratchParent: scratch });
    handed = true;
    const built = await buildDesktopFromPrepared({ prepared, out, scratchParent: scratch, reserved: true });
    process.stdout.write(`${JSON.stringify({ directory: built.directory, artifactId: built.artifactId, root: built.root })}\n`);
  } finally {
    try { await prepared?.dispose(); }
    finally {
      if (scratch) await rm(scratch, { recursive: true, force: true });
      if (!handed) await rm(out, { recursive: true, force: true });
    }
  }
}
