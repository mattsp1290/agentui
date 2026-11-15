import { createHash } from 'node:crypto';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { count, hex, nonempty, record } from '@agentui/contracts/decode';
import { parseExtensionManifest, type ExtensionManifest } from '@agentui/sdk';
import { commitId, containedPath, identity } from './contract.js';
import type { SourceFile } from './repository.js';

export interface ServerArtifactPackage {
  readonly identity: string;
  readonly commit: string;
  readonly subdirectory: string;
  readonly inputs: { readonly identity: string; readonly files: readonly SourceFile[] };
  readonly npm: { readonly kind: 'absent' } | {
    readonly kind: 'locked'; readonly identity: string; readonly packageManager: 'npm@11.19.1';
    readonly directory: string; readonly packageJson: SourceFile; readonly lockfile: SourceFile;
    readonly workspaces: readonly SourceFile[]; readonly localInputs: readonly SourceFile[];
  };
  readonly local: { readonly manifest: ExtensionManifest; readonly sources: readonly { readonly module: string; readonly source: string }[] } | null;
  readonly shared: string | null;
  readonly extensions: readonly string[];
}
export interface ServerCustomizationArtifact {
  readonly schemaVersion: 1;
  readonly kind: 'server-customization';
  readonly root: string;
  readonly packages: readonly ServerArtifactPackage[];
  readonly sdkVersion: string;
  readonly builder: { readonly identity: string; readonly esbuildVersion: string };
  readonly runtime: { readonly engine: 'node'; readonly version: string; readonly modules: string; readonly abiIdentity: string };
  readonly catalog: 'entries.mjs';
  readonly entries: readonly { readonly packageIdentity: string; readonly module: string; readonly index: number }[];
  readonly assets: readonly { readonly path: string; readonly sha256: string; readonly size: number }[];
  readonly artifactId: string;
}
export interface ServerArtifactExpectation {
  readonly artifactId: string;
  readonly sdkVersion: string;
  readonly nodeVersion: string;
  readonly nodeModules: string;
  readonly abiIdentity: string;
}
const invalid = () => new Error('Invalid server customization artifact.');
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
function array<T>(value: unknown, parse: (item: unknown) => T, max = 16_384): T[] {
  if (!Array.isArray(value) || value.length > max) throw invalid();
  return value.map(parse);
}
function directory(value: unknown): string { return value === '' ? '' : containedPath(value); }
function sorted<T>(values: readonly T[], key: (value: T) => string): readonly T[] {
  if (values.some((value, index) => index > 0 && key(values[index - 1]!) >= key(value))) throw invalid();
  return values;
}
function file(value: unknown): SourceFile {
  const input = record(value, ['path', 'sha256', 'executable']);
  if (typeof input.executable !== 'boolean') throw invalid();
  return { path: containedPath(input.path), sha256: hex(input.sha256, 64), executable: input.executable };
}
const files = (value: unknown) => sorted(array(value, file), value => value.path);
function parsePackage(value: unknown): ServerArtifactPackage {
  const input = record(value, ['identity', 'commit', 'subdirectory', 'inputs', 'npm', 'local', 'shared', 'extensions']);
  const rawInputs = record(input.inputs, ['identity', 'files']);
  const inputs = { identity: hex(rawInputs.identity, 64), files: files(rawInputs.files) };
  const subdirectory = directory(input.subdirectory);
  const packageIdentity = hex(input.identity, 64);
  if (identity(['agentui-tree-v1', inputs.files]) !== inputs.identity || identity(['agentui-package-v1', inputs.identity, subdirectory]) !== packageIdentity) throw invalid();
  let npm: ServerArtifactPackage['npm'];
  const rawNpm = record(input.npm);
  if (rawNpm.kind === 'absent') { record(rawNpm, ['kind']); npm = { kind: 'absent' }; }
  else {
    record(rawNpm, ['kind', 'identity', 'packageManager', 'directory', 'packageJson', 'lockfile', 'workspaces', 'localInputs']);
    if (rawNpm.kind !== 'locked' || rawNpm.packageManager !== 'npm@11.19.1') throw invalid();
    npm = { kind: 'locked', identity: hex(rawNpm.identity, 64), packageManager: 'npm@11.19.1', directory: directory(rawNpm.directory),
      packageJson: file(rawNpm.packageJson), lockfile: file(rawNpm.lockfile), workspaces: files(rawNpm.workspaces), localInputs: files(rawNpm.localInputs) };
    const selected = inputs.files.find(value => value.path === (subdirectory ? `${subdirectory}/package.json` : 'package.json'));
    if (!selected || identity(['agentui-npm-v1', inputs.identity, npm.directory, selected, npm.packageJson, npm.lockfile, npm.workspaces, npm.localInputs]) !== npm.identity) throw invalid();
    for (const captured of [npm.packageJson, npm.lockfile, ...npm.workspaces, ...npm.localInputs]) {
      if (!inputs.files.some(value => value.path === captured.path && value.sha256 === captured.sha256 && value.executable === captured.executable)) throw invalid();
    }
  }
  let local: ServerArtifactPackage['local'] = null;
  if (input.local !== null) {
    const rawLocal = record(input.local, ['manifest', 'sources']);
    const manifest = parseExtensionManifest(rawLocal.manifest);
    const sources = sorted(array(rawLocal.sources, value => {
      const source = record(value, ['module', 'source']);
      return { module: `./${containedPath(source.module, true)}`, source: `./${containedPath(source.source, true)}` };
    }), value => value.module);
    if (sources.length !== new Set(manifest.entries.map(entry => entry.module)).size || sources.some(source => !manifest.entries.some(entry => entry.module === source.module) ||
      !inputs.files.some(file => file.path === [subdirectory, source.source.slice(2)].filter(Boolean).join('/')))) throw invalid();
    local = { manifest, sources };
  }
  const shared = input.shared === null ? null : `./${containedPath(input.shared, true)}`;
  if (shared && !inputs.files.some(file => file.path === [subdirectory, shared.slice(2)].filter(Boolean).join('/'))) throw invalid();
  return { identity: packageIdentity, commit: commitId(input.commit), subdirectory, inputs, npm, local, shared, extensions: array(input.extensions, value => hex(value, 64), 256) };
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, child]) => [key, canonical(child)]));
  return value;
}
export function serverCustomizationArtifactId(value: Omit<ServerCustomizationArtifact, 'artifactId'>): string {
  return identity(['agentui-server-artifact-v1', canonical(value)]);
}
export function parseServerCustomizationArtifact(value: unknown): ServerCustomizationArtifact {
  try {
    const input = record(value, ['schemaVersion', 'kind', 'root', 'packages', 'sdkVersion', 'builder', 'runtime', 'catalog', 'entries', 'assets', 'artifactId']);
    if (input.schemaVersion !== 1 || input.kind !== 'server-customization' || input.catalog !== 'entries.mjs') throw invalid();
    const builder = record(input.builder, ['identity', 'esbuildVersion']);
    const runtime = record(input.runtime, ['engine', 'version', 'modules', 'abiIdentity']);
    if (runtime.engine !== 'node' || typeof runtime.version !== 'string' || !/^\d+\.\d+\.\d+$/u.test(runtime.version) || typeof runtime.modules !== 'string' || !/^\d+$/u.test(runtime.modules)) throw invalid();
    const packages = array(input.packages, parsePackage, 64);
    const root = hex(input.root, 64);
    const lookup = new Map(packages.map(pkg => [pkg.identity, pkg]));
    if (lookup.size !== packages.length || packages[0]?.identity !== root) throw invalid();
    const ordered: string[] = [], active = new Set<string>(), seen = new Set<string>(), namespaces = new Set<string>();
    const visit = (id: string) => {
      if (active.has(id)) throw invalid();
      if (seen.has(id)) return;
      const pkg = lookup.get(id);
      if (!pkg) throw invalid();
      seen.add(id); active.add(id); ordered.push(id);
      if (pkg.local) { if (namespaces.has(pkg.local.manifest.namespace)) throw invalid(); namespaces.add(pkg.local.manifest.namespace); }
      for (const child of pkg.extensions) visit(child);
      active.delete(id);
    };
    visit(root);
    if (ordered.length !== packages.length || ordered.some((id, index) => packages[index]?.identity !== id)) throw invalid();
    const sdkVersion = nonempty(input.sdkVersion);
    if (packages.some(pkg => pkg.local && pkg.local.manifest.sdkVersion !== sdkVersion)) throw invalid();
    const entries = array(input.entries, value => {
      const entry = record(value, ['packageIdentity', 'module', 'index']);
      return { packageIdentity: hex(entry.packageIdentity, 64), module: `./${containedPath(entry.module, true)}`, index: count(entry.index) };
    }, 64);
    const expected = packages.flatMap(pkg => pkg.local?.manifest.entries.filter(entry => entry.kind === 'server').map(entry => ({ packageIdentity: pkg.identity, module: entry.module })) ?? []);
    if (!entries.length || entries.length !== expected.length || entries.some((entry, index) => entry.index !== index || entry.packageIdentity !== expected[index]?.packageIdentity || entry.module !== expected[index]?.module)) throw invalid();
    const assets = sorted(array(input.assets, value => {
      const asset = record(value, ['path', 'sha256', 'size']);
      const path = containedPath(asset.path);
      if (path === 'customization.json') throw invalid();
      return { path, sha256: hex(asset.sha256, 64), size: count(asset.size) };
    }), value => value.path);
    if (!assets.some(asset => asset.path === 'entries.mjs')) throw invalid();
    const body: Omit<ServerCustomizationArtifact, 'artifactId'> = { schemaVersion: 1, kind: 'server-customization', root, packages, sdkVersion,
      builder: { identity: hex(builder.identity, 64), esbuildVersion: nonempty(builder.esbuildVersion) },
      runtime: { engine: 'node', version: runtime.version, modules: runtime.modules, abiIdentity: hex(runtime.abiIdentity, 64) }, catalog: 'entries.mjs', entries, assets };
    const artifactId = hex(input.artifactId, 64);
    if (serverCustomizationArtifactId(body) !== artifactId) throw invalid();
    return freeze({ ...body, artifactId });
  } catch { throw invalid(); }
}
export async function readServerCustomizationArtifact(input: {
  readonly directory: string; readonly expected: ServerArtifactExpectation;
}): Promise<{ readonly manifest: ServerCustomizationArtifact; readAsset(path: string): Buffer }> {
  try {
    const directory = resolve(input.directory);
    if (!(await lstat(directory)).isDirectory()) throw invalid();
    const manifestPath = join(directory, 'customization.json');
    const metadata = await lstat(manifestPath);
    if (!metadata.isFile() || metadata.size > 16 * 1024 * 1024) throw invalid();
    const manifest = parseServerCustomizationArtifact(JSON.parse(await readFile(manifestPath, 'utf8')));
    const expected = input.expected;
    if (manifest.artifactId !== expected.artifactId || manifest.sdkVersion !== expected.sdkVersion || manifest.runtime.version !== expected.nodeVersion ||
      manifest.runtime.modules !== expected.nodeModules || manifest.runtime.abiIdentity !== expected.abiIdentity) throw invalid();
    const assets = new Map(manifest.assets.map(asset => [asset.path, asset]));
    const retained = new Map<string, Buffer>();
    let total = 0;
    const walk = async (parent: string): Promise<void> => {
      for (const name of await readdir(join(directory, parent))) {
        const path = parent ? `${parent}/${name}` : name;
        const metadata = await lstat(join(directory, path));
        if (metadata.isDirectory()) {
          if (![...assets.keys()].some(asset => asset.startsWith(`${path}/`))) throw invalid();
          await walk(path);
        } else {
          if (!metadata.isFile()) throw invalid();
          if (path === 'customization.json') continue;
          const asset = assets.get(path);
          total += metadata.size;
          if (!asset || metadata.size !== asset.size || total > 64 * 1024 * 1024) throw invalid();
          const bytes = await readFile(join(directory, path));
          if (bytes.length !== asset.size || digest(bytes) !== asset.sha256) throw invalid();
          retained.set(path, bytes);
        }
      }
    };
    await walk('');
    if (retained.size !== assets.size) throw invalid();
    return Object.freeze({ manifest, readAsset(path: string) {
      const bytes = retained.get(path);
      if (!bytes) throw invalid();
      return Buffer.from(bytes);
    } });
  } catch { throw invalid(); }
}
