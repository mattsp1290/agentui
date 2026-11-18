import { createHash } from 'node:crypto';
import { isAbsolute, posix, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { record } from '@agentui/contracts/decode';
import { parseExtensionManifest, type ExtensionManifest } from '@agentui/sdk';
import { parseInstallationGrants, type InstallationGrant } from './installations.js';

const supportedNodeMinimum = [24, 22, 3] as const;
const supportedNodeRange = `>=${supportedNodeMinimum.join('.')} <${supportedNodeMinimum[0] + 1}`;
export const supportedNpmVersion = '11.19.1';
export const supportedPackageManager = `npm@${supportedNpmVersion}` as const;
export const serverCatalogFile = 'entries.mjs';
const diagnostics = {
  'output-exists': 'Server customization output must be a fresh directory.',
  'invalid-graph': 'Server customization requires unique namespaces and compatible server entries.',
  'build-failed': 'Could not compile server customization sources.',
  'artifact-changed': 'Server customization output changed during validation.',
  'publication-failed': 'Could not publish server customization artifact.',
  'toolchain-mismatch': `Customization requires Node ${supportedNodeRange}.`,
  'npm-mismatch': `Customization preparation requires npm ${supportedNpmVersion}.`,
  'entry-validation': 'Server customization entry validation failed.',
  'invalid-artifact': 'Invalid server customization artifact.',
  'install-failed': 'Could not install committed customization dependencies.',
  'input-mutation': 'Committed customization inputs changed during preparation.',
  'resource-limit': 'Customization preparation resource limit exceeded.',
  'preparation-failed': 'Could not prepare committed customization sources.',
};
export type CustomizationErrorCode = 'invalid-input' | 'invalid-package' | 'invalid-settings' | 'path' |
  'unsupported-tree-entry' | 'unknown-commit' | 'access' | 'retrieval-failed' | keyof typeof diagnostics;

export class CustomizationError extends Error {
  static fixed(code: keyof typeof diagnostics): CustomizationError {
    return new CustomizationError(code, diagnostics[code]);
  }

  constructor(readonly code: CustomizationErrorCode, message: string) {
    super(message);
    this.name = 'CustomizationError';
  }
}
export function assertSupportedNode(version: string = process.versions.node): void {
  const [major, minor, patch] = version.split('.').map(Number);
  const [minimumMajor, minimumMinor, minimumPatch] = supportedNodeMinimum;
  if (!/^\d+\.\d+\.\d+$/u.test(version) || major !== minimumMajor || minor! < minimumMinor || minor === minimumMinor && patch! < minimumPatch) {
    throw CustomizationError.fixed('toolchain-mismatch');
  }
}

export interface GitExtensionReference {
  readonly repository: string;
  readonly commit: string;
  readonly subdirectory?: string;
}
/**
 * A reference in committed metadata. The remote form pins a repository and commit. The same-repository form names only a
 * subdirectory from the root of the repository that holds the referencing package, because a committed file cannot name
 * its own commit. A disabled reference stays listed but is never fetched or parsed.
 */
export type CommittedExtensionReference =
  | (GitExtensionReference & { readonly enabled: boolean })
  | { readonly subdirectory: string; readonly enabled: boolean };
export function isSiblingReference(reference: CommittedExtensionReference): reference is { readonly subdirectory: string; readonly enabled: boolean } {
  return !('repository' in reference);
}
/** The key the UI and the worker use for a reference: the subdirectory, or `<repository>#<subdirectory or .>`. */
export function committedReferenceKey(reference: CommittedExtensionReference): string {
  return isSiblingReference(reference) ? reference.subdirectory : `${reference.repository}#${reference.subdirectory ?? '.'}`;
}
export interface CustomizationSource {
  readonly local?: {
    readonly manifest: ExtensionManifest;
    readonly sources: ReadonlyMap<string, string>;
  };
  readonly shared?: string;
  readonly extensions: readonly CommittedExtensionReference[];
  /** Installation grants. Only a root package may declare them; they never hold a secret. */
  readonly installations?: readonly InstallationGrant[];
}

export function commitId(value: unknown): string {
  if (typeof value !== 'string' || !/^(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64})$/u.test(value)) {
    throw new CustomizationError('invalid-input', 'Expected a full immutable Git commit ID.');
  }
  return value.toLowerCase();
}

function hasControl(value: string): boolean {
  return [...value].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
}

export function repositoryLocation(value: unknown): string {
  const invalid = () => new CustomizationError('invalid-input', 'Expected a local path or file, SSH, or HTTPS repository without embedded credentials.');
  if (typeof value !== 'string' || !value.trim() || value.startsWith('-') || value.includes('\\') || hasControl(value)) throw invalid();
  if (value.includes('://')) {
    if (/\s/u.test(value)) throw invalid();
    let url: URL;
    try { url = new URL(value); } catch { throw invalid(); }
    if (!['file:', 'ssh:', 'https:'].includes(url.protocol) || url.password || url.search || url.hash ||
      (url.protocol !== 'ssh:' && url.username) ||
      (url.protocol === 'file:' && url.hostname && url.hostname !== 'localhost')) throw invalid();
  } else if (value.includes(':') && !value.startsWith('/')) {
    if (!/^(?:[\w.-]+@)?[\w.-]+:[^\s:]+$/u.test(value)) throw invalid();
    if (/^(?:ext|file|https?|git|ssh):/u.test(value)) throw invalid();
  }
  return value;
}

export function repositoryAddress(value: unknown, cwd: string): { readonly address: string | undefined; readonly transport: string } {
  const repository = repositoryLocation(value);
  let address: string;
  try {
    address = repository.startsWith('file://') ? resolve(fileURLToPath(repository)) : isAbsolute(repository) || !repository.includes(':') ? resolve(cwd, repository) : repository;
  } catch {
    // Git can retrieve file URLs that cannot form a canonical graph cache address.
    return { address: undefined, transport: repository };
  }
  return { address, transport: isAbsolute(address) ? pathToFileURL(address).href : repository };
}
function unsafeSegment(part: string): boolean { return part.toLowerCase() === '.git' || hasControl(part) || /[\\:]/u.test(part); }
export function npmLocalPath(base: string, value: string): string {
  if (!value || value.startsWith('/') || value.split('/').some(part => part === '~' || unsafeSegment(part))) {
    throw new CustomizationError('path', 'Npm inputs must remain inside the committed repository.');
  }
  const path = posix.normalize(posix.join(base, value));
  if (path === '..' || path.startsWith('../')) throw new CustomizationError('path', 'Npm inputs must remain inside the committed repository.');
  return path === '.' ? '' : containedPath(path);
}
export function parentDirectory(path: string): string { const parent = posix.dirname(path); return parent === '.' ? '' : parent; }
export function byPath(a: { readonly path: string }, b: { readonly path: string }): number { return a.path < b.path ? -1 : a.path > b.path ? 1 : 0; }
export function identity(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }

export function containedPath(value: unknown, source = false): string {
  if (typeof value !== 'string' || !value || (source && !value.startsWith('./'))) {
    throw new CustomizationError('path', 'Expected a contained repository path.');
  }
  const path = value.startsWith('./') ? value.slice(2) : value;
  if (path.split('/').some(part => !part || part === '.' || part === '..' || unsafeSegment(part))) {
    throw new CustomizationError('path', 'Repository paths must be relative and cannot traverse directories or contain .git.');
  }
  return path;
}

function fields(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  const object = record(value);
  if (Object.keys(object).some(key => !allowed.includes(key))) throw new Error('Unexpected customization field');
  return object;
}

export function parseGitExtensionReference(value: unknown): GitExtensionReference {
  try {
    const reference = fields(value, ['repository', 'commit', 'subdirectory']);
    return { repository: repositoryLocation(reference.repository), commit: commitId(reference.commit),
      ...(reference.subdirectory === undefined ? {} : { subdirectory: containedPath(reference.subdirectory) }) };
  } catch {
    throw new CustomizationError('invalid-package', 'Invalid committed external customization reference.');
  }
}

/** Parses a reference in committed metadata. Refresh requests and the resolver root keep using `parseGitExtensionReference`. */
export function parseCommittedExtensionReference(value: unknown): CommittedExtensionReference {
  try {
    const input = record(value);
    if (input.enabled !== undefined && typeof input.enabled !== 'boolean') throw new Error('Invalid enabled flag');
    const enabled = input.enabled ?? true;
    if (input.repository === undefined && input.commit === undefined) {
      const reference = fields(value, ['subdirectory', 'enabled']);
      return { subdirectory: containedPath(reference.subdirectory), enabled };
    }
    const { enabled: _enabled, ...remote } = input;
    return { ...parseGitExtensionReference(remote), enabled };
  } catch {
    throw new CustomizationError('invalid-package', 'Invalid committed external customization reference.');
  }
}

export const dependencyGroups = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'] as const;
export function hasDependencies(pkg: Record<string, unknown>): boolean {
  return dependencyGroups.some(key => pkg[key] !== undefined && Object.keys(record(pkg[key])).length > 0);
}
export function npmLockPackages(lock: unknown, packageManager: unknown): Record<string, unknown> {
  if (lock === undefined) throw new CustomizationError('invalid-package', 'Dependencies require a committed npm v3 lockfile.');
  if (packageManager !== supportedPackageManager) throw new CustomizationError('invalid-package', `Dependencies require ${supportedPackageManager}.`);
  const value = record(lock);
  if (value.lockfileVersion !== 3) throw new CustomizationError('invalid-package', 'Dependencies require a committed npm v3 lockfile.');
  return record(value.packages);
}
export function manifestMatchesLockEntry(packageJson: Record<string, unknown>, entry: Record<string, unknown>): void {
  for (const key of dependencyGroups) {
    const declared = packageJson[key] === undefined ? {} : record(packageJson[key]);
    const locked = entry[key] === undefined ? {} : record(entry[key]);
    if (Object.values(declared).some(value => typeof value !== 'string' || !value.trim()) ||
      Object.keys(declared).length !== Object.keys(locked).length || Object.keys(declared).some(name => locked[name] !== declared[name])) {
      throw new CustomizationError('invalid-package', 'Lockfile dependencies disagree with package.json.');
    }
  }
  if (entry.version !== packageJson.version) throw new CustomizationError('invalid-package', 'Lockfile version disagrees with package.json.');
}

export function parseCustomizationPackage(input: unknown, files: ReadonlySet<string>): CustomizationSource | undefined {
  try {
    const packageJson = record(input);
    if (packageJson.agentui === undefined) return undefined;
    const metadata = fields(packageJson.agentui, ['extension', 'sources', 'shared', 'extensions', 'installations']);
    let local: CustomizationSource['local'];
    if (metadata.extension !== undefined || metadata.sources !== undefined) {
      const manifest = parseExtensionManifest(metadata.extension);
      const mapping = record(metadata.sources);
      const outputs = new Set(manifest.entries.map(entry => entry.module));
      if (Object.keys(mapping).length !== outputs.size || Object.keys(mapping).some(key => !outputs.has(key))) {
        throw new Error('Expected exactly one source mapping per manifest module');
      }
      const sources = new Map<string, string>();
      for (const output of outputs) {
        containedPath(output, true);
        const source = containedPath(mapping[output], true);
        if (!files.has(source)) throw new Error('Declared source is not a committed regular file');
        sources.set(output, `./${source}`);
      }
      local = { manifest, sources };
    }
    let shared: string | undefined;
    if (metadata.shared !== undefined) {
      const path = containedPath(metadata.shared, true);
      if (!files.has(path)) throw new Error('Shared source is not a committed regular file');
      shared = `./${path}`;
    }
    const extensions: CommittedExtensionReference[] = [];
    if (metadata.extensions !== undefined) {
      if (!Array.isArray(metadata.extensions)) throw new Error('Expected external reference array');
      if (metadata.extensions.length > 256) throw new CustomizationError('resource-limit', 'Customization source edge limit exceeded.');
      for (const value of metadata.extensions) {
        extensions.push(parseCommittedExtensionReference(value));
      }
    }
    const installations = metadata.installations === undefined ? undefined : parseInstallationGrants(metadata.installations);
    if (!local && shared === undefined && !extensions.length && installations === undefined) return undefined;
    return { ...(local ? { local } : {}), ...(shared === undefined ? {} : { shared }), extensions, ...(installations === undefined ? {} : { installations }) };
  } catch (error) {
    if (error instanceof CustomizationError) throw error;
    throw new CustomizationError('invalid-package', 'Invalid committed customization package or npm inputs.');
  }
}
