import { record } from '@agentui/contracts/decode';
import { parseExtensionManifest, type ExtensionManifest } from '@agentui/sdk';

export type CustomizationErrorCode = 'invalid-input' | 'invalid-package' | 'path' |
  'unsupported-tree-entry' | 'unknown-commit' | 'access' | 'retrieval-failed' | 'resource-limit';

export class CustomizationError extends Error {
  constructor(readonly code: CustomizationErrorCode, message: string) {
    super(message);
    this.name = 'CustomizationError';
  }
}

export interface GitExtensionReference {
  readonly repository: string;
  readonly commit: string;
  readonly subdirectory?: string;
}
export interface CustomizationSource {
  readonly local?: {
    readonly manifest: ExtensionManifest;
    readonly sources: ReadonlyMap<string, string>;
  };
  readonly shared?: string;
  readonly extensions: readonly GitExtensionReference[];
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
  if (typeof value !== 'string' || !value || value.startsWith('-') || value.includes('\\') || (/\s/u.test(value) || hasControl(value))) throw invalid();
  if (value.includes('://')) {
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

export function containedPath(value: unknown, source = false): string {
  if (typeof value !== 'string' || !value || (source && !value.startsWith('./'))) {
    throw new CustomizationError('path', 'Expected a contained repository path.');
  }
  const path = value.startsWith('./') ? value.slice(2) : value;
  if ((/[\\:]/u.test(path) || hasControl(path)) || path.split('/').some(part => !part || part === '.' || part === '..' || part.toLowerCase() === '.git')) {
    throw new CustomizationError('path', 'Repository paths must be relative and cannot traverse directories or contain .git.');
  }
  return path;
}

function fields(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  const object = record(value);
  if (Object.keys(object).some(key => !allowed.includes(key))) throw new Error('Unexpected customization field');
  return object;
}

export const dependencyGroups = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'] as const;
export interface NpmContext { readonly lock: unknown; readonly packagePath: string; readonly packageManager: unknown }
export function validateNpmManifest(packageJson: Record<string, unknown>, context: NpmContext): void {
  if (context.packageManager !== 'npm@11.19.1') throw new Error('Dependencies require npm@11.19.1');
  const lock = record(context.lock);
  if (lock.lockfileVersion !== 3) throw new Error('Dependencies require a committed npm v3 lockfile');
  const entry = record(record(lock.packages)[context.packagePath]);
  for (const key of dependencyGroups) {
    const declared = packageJson[key] === undefined ? {} : record(packageJson[key]);
    const locked = entry[key] === undefined ? {} : record(entry[key]);
    if (Object.values(declared).some(value => typeof value !== 'string' || !value.trim()) ||
      Object.keys(declared).length !== Object.keys(locked).length || Object.keys(declared).some(name => locked[name] !== declared[name])) {
      throw new Error('Lockfile dependencies disagree with package.json');
    }
  }
  if (entry.version !== packageJson.version) throw new Error('Lockfile version disagrees with package.json');
  const link = record(lock.packages)[`node_modules/${String(packageJson.name)}`];
  const linkedName = context.packagePath && link !== undefined && record(link).link === true && record(link).resolved === context.packagePath;
  if (entry.name !== packageJson.name && !(entry.name === undefined && linkedName)) throw new Error('Lockfile name disagrees with package.json');
}

export function parseCustomizationPackage(input: unknown, files: ReadonlySet<string>, npm?: NpmContext): CustomizationSource | undefined {
  try {
    const packageJson = record(input);
    if (packageJson.agentui === undefined) return undefined;
    const metadata = fields(packageJson.agentui, ['extension', 'sources', 'shared', 'extensions']);
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
    const extensions: GitExtensionReference[] = [];
    if (metadata.extensions !== undefined) {
      if (Array.isArray(metadata.extensions) && metadata.extensions.length > 256) throw new CustomizationError('resource-limit', 'Customization source edge limit exceeded.');
      if (!Array.isArray(metadata.extensions)) throw new Error('Expected external reference array');
      for (const value of metadata.extensions) {
        const reference = fields(value, ['repository', 'commit', 'subdirectory']);
        const repository = repositoryLocation(reference.repository);
        const commit = commitId(reference.commit);
        extensions.push({ repository, commit, ...(reference.subdirectory === undefined ? {} : { subdirectory: containedPath(reference.subdirectory) }) });
      }
    }
    if (!local && shared === undefined && !extensions.length) return undefined;
    if (dependencyGroups.some(key => packageJson[key] !== undefined && Object.keys(record(packageJson[key])).length > 0)) {
      validateNpmManifest(packageJson, npm ?? { lock: undefined, packagePath: '', packageManager: packageJson.packageManager });
    }
    return { ...(local ? { local } : {}), ...(shared === undefined ? {} : { shared }), extensions };
  } catch (error) {
    if (error instanceof CustomizationError) throw error;
    throw new CustomizationError('invalid-package', 'Invalid committed customization package or npm inputs.');
  }
}
