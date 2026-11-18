// Builds one customization for the worker: resolves the graph, prepares it once, and runs the desktop and server
// builds from that one preparation. Progress and the outcome are JSON lines on standard output with fixed values only:
// `{"phase":…}`, then `{"result":{…}}` or `{"failure":…}`. Diagnostics go to standard error, which stays on this machine.
import { mkdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { EXTENSION_SDK_VERSION } from '@agentui/sdk';
import { CustomizationError, resolveCustomizationSources } from '@agentui/host/customization';
import { prepareCustomizationSources } from './prepare-customization-sources.mjs';
import { buildDesktopFromPrepared, DesktopQualificationFailed } from './build-local-customization.mjs';
import { buildServerCustomization } from './server-customization.mjs';

const RESOLUTION = new Set(['invalid-input', 'invalid-package', 'path', 'unsupported-tree-entry', 'unknown-commit', 'access', 'retrieval-failed']);
/** One fixed failure value per builder error, by phase. */
function buildFailure(phase, error) {
  const code = error instanceof CustomizationError ? error.code : null;
  if (code === 'toolchain-mismatch' || code === 'npm-mismatch') return 'toolchain-missing';
  if (phase === 'resolving') return 'resolve-failed';
  if (phase === 'preparing') return code !== null && RESOLUTION.has(code) ? 'resolve-failed' : 'prepare-failed';
  if (phase === 'building-desktop') return error instanceof DesktopQualificationFailed ? 'qualification-failed' : 'desktop-build-failed';
  return 'server-build-failed';
}
function walk(root) {
  const seen = new Set(), nodes = [];
  const visit = node => { if (seen.has(node)) return; seen.add(node); nodes.push(node); node.extensions.forEach(visit); };
  visit(root);
  return nodes;
}

const emit = value => process.stdout.write(`${JSON.stringify(value)}\n`);
const options = Object.fromEntries(['repository', 'commit', 'subdirectory', 'out', 'scratch', 'npm-cache', 'install-timeout-seconds',
  'prepare-timeout-seconds', 'resolve-timeout-seconds'].map(name => [name, { type: 'string' }]));
const { values } = parseArgs({ options });
if (!values.repository || !values.commit || !values.out || !values.scratch) {
  throw new Error('Usage: node scripts/build-customization.mjs --repository PATH --commit FULL_ID --out DIRECTORY --scratch DIRECTORY [--subdirectory PATH] [--npm-cache DIRECTORY] [--install-timeout-seconds N] [--prepare-timeout-seconds N] [--resolve-timeout-seconds N]');
}
const seconds = name => values[name] === undefined ? undefined : Number(values[name]) * 1000;
const reference = { repository: values.repository, commit: values.commit, ...(values.subdirectory ? { subdirectory: values.subdirectory } : {}) };
const scratch = resolve(values.scratch);
let phase = 'resolving', prepared;
try {
  emit({ phase });
  await mkdir(scratch, { recursive: true, mode: 0o700 });
  const resolved = await resolveCustomizationSources({ reference, scratchParent: scratch, ...(seconds('resolve-timeout-seconds') ? { timeoutMs: seconds('resolve-timeout-seconds') } : {}) });
  let manifests;
  try { manifests = walk(resolved.root).flatMap(node => node.customization?.local ? [node.customization.local.manifest] : []); }
  finally { await resolved.dispose(); }
  if (manifests.some(manifest => manifest.sdkVersion !== EXTENSION_SDK_VERSION)) throw Object.assign(new Error('Extension SDK version mismatch'), { failure: 'sdk-mismatch' });
  const desktop = manifests.some(manifest => manifest.entries.some(entry => entry.kind === 'desktop'));
  const server = manifests.some(manifest => manifest.entries.some(entry => entry.kind === 'server'));
  phase = 'preparing';
  emit({ phase });
  prepared = await prepareCustomizationSources({ reference, scratchParent: scratch, npmCache: values['npm-cache'],
    installTimeoutMs: seconds('install-timeout-seconds'), prepareTimeoutMs: seconds('prepare-timeout-seconds'), resolveTimeoutMs: seconds('resolve-timeout-seconds') });
  let desktopArtifactId = null, serverArtifactId = null;
  if (desktop) {
    phase = 'building-desktop';
    emit({ phase });
    desktopArtifactId = (await buildDesktopFromPrepared({ prepared, out: join(values.out, 'desktop'), scratchParent: scratch })).artifactId;
  }
  if (server) {
    phase = 'building-server';
    emit({ phase });
    serverArtifactId = (await buildServerCustomization({ reference, out: join(values.out, 'server'), prepared })).manifest.artifactId;
  }
  emit({ result: { desktopArtifactId, serverArtifactId, namespaces: [...new Set(manifests.map(manifest => manifest.namespace))].sort() } });
} catch (error) {
  process.stderr.write(`${error?.stack ?? error}\n`);
  emit({ failure: error?.failure ?? buildFailure(phase, error) });
  process.exitCode = 1;
} finally {
  await prepared?.dispose().catch(() => {});
  await rm(scratch, { recursive: true, force: true }).catch(() => {});
}
