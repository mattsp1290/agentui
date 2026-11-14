import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { canonicalJson } from '@agentui/contracts';

const targets = {
  host: { directory: 'apps/host/dist', nativeRuntime: { engine: 'node', version: process.versions.node, format: 'esm' } },
  'browser-development': { directory: 'apps/desktop/web-dist-browser', nativeRuntime: { engine: 'browser', version: 'development', format: 'web-assets' } },
};
const platform = process.argv[2];
if (process.argv.length !== 3 || !Object.hasOwn(targets, platform)) {
  throw new Error('Usage: node scripts/artifact-manifest.mjs <host|browser-development>');
}
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trimEnd();
const root = git('rev-parse', '--show-toplevel');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const target = targets[platform];
const directory = resolve(root, target.directory);

function assetsAt(path) {
  return readdirSync(path, { withFileTypes: true }).flatMap(entry => {
    const absolute = join(path, entry.name);
    const name = relative(directory, absolute).split('\\').join('/');
    if (name === 'artifact.json') return [];
    if (entry.isDirectory()) return assetsAt(absolute);
    if (!entry.isFile()) throw new Error(`Artifact contains a non-regular file: ${name}`);
    return [{ path: name, sha256: digest(readFileSync(absolute)) }];
  }).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}

function isProductSource(path) {
  const parts = path.split('/');
  if (parts.some(part => ['node_modules', 'dist', 'web-dist', 'web-dist-browser', 'build', '.audit', 'target', 'gen', '.git'].includes(part))) return false;
  if (parts.some(part => /^\.env|\.pem$|\.key$|\.p12$/i.test(part))) return false;
  return ['apps', 'packages', 'scripts', 'tests', 'examples'].includes(parts[0]) ||
    (parts.length === 1 && /^(?:package(?:-lock)?\.json|tsconfig[^/]*\.json|[^/]*config\.[cm]?[jt]s|\.npmrc)$/.test(path));
}

const changed = new Set([
  ...git('-C', root, 'diff', 'HEAD', '--name-only', '-z').split('\0'),
  ...git('-C', root, 'ls-files', '--others', '--exclude-standard', '-z').split('\0'),
].filter(path => path && isProductSource(path)));
const dirtyFiles = [...changed].sort().map(path => {
  const absolute = join(root, path);
  try {
    if (!lstatSync(absolute).isFile()) throw new Error(`Product source is not a regular file: ${path}`);
    return { path, sha256: digest(readFileSync(absolute)) };
  } catch (error) {
    if (error.code === 'ENOENT') return { path, deleted: true };
    throw error;
  }
});
const assets = assetsAt(directory);
if (assets.length === 0) throw new Error(`No built assets in ${directory}`);
const payload = {
  schemaVersion: 1,
  platform,
  sourceRevision: git('-C', root, 'rev-parse', 'HEAD'),
  sourceDirty: dirtyFiles.length === 0 ? { kind: 'clean' } : { kind: 'dirty', fingerprint: digest(JSON.stringify(dirtyFiles)) },
  wireVersion: 1,
  extensionSdkVersion: '0.0.0',
  nativeRuntime: platform === 'host' ? { engine: 'agentui-recorded', version: 'recorded-v1', format: 'agentui-recorded-v1' } : target.nativeRuntime,
  artifactRuntime: target.nativeRuntime,
  lockSha256: digest(readFileSync(join(root, 'package-lock.json'))),
  assets,
};
const manifest = { ...payload, artifactId: digest(canonicalJson(payload)) };
writeFileSync(join(directory, 'artifact.json'), `${JSON.stringify(manifest, null, 2)}\n`);
process.stdout.write(`${target.directory}/artifact.json ${manifest.artifactId}\n`);
