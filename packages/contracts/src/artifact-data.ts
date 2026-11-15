import type { NativeRuntimeIdentity } from './compatibility.js';
import { hex, nonempty, record } from './decode.js';

export interface ArtifactAsset {
  readonly path: string;
  readonly sha256: string;
}
export const RUNTIME_IDENTITY_FIELDS = ['engine', 'version', 'format'] as const satisfies readonly (keyof NativeRuntimeIdentity)[];

export function runtimeIdentity(input: Record<string, unknown>): NativeRuntimeIdentity {
  return { engine: nonempty(input.engine), version: nonempty(input.version), format: nonempty(input.format) };
}

function artifactPath(value: unknown): string {
  const path = nonempty(value);
  if (path !== path.normalize('NFC') || path.startsWith('/') || path.includes('\\') || path.includes(':') ||
      [...path].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127) ||
      path.split('/').some(part => part === '' || part === '.' || part === '..')) {
    throw new Error('Invalid artifact asset path');
  }
  return path;
}

export function assetInventory(value: unknown, reservedPath?: string): readonly ArtifactAsset[] {
  if (!Array.isArray(value)) throw new Error('Expected artifact asset inventory');
  const assets = Array.from(value, item => {
    const input = record(item, ['path', 'sha256']);
    const path = artifactPath(input.path);
    if (path === reservedPath) throw new Error('Invalid artifact asset path');
    return { path, sha256: hex(input.sha256, 64) };
  });
  if (assets.length === 0 || assets.some((entry, index) => {
    const previous = assets[index - 1];
    return previous !== undefined && entry.path <= previous.path;
  })) throw new Error('Artifact assets must be nonempty, unique and sorted');
  return assets;
}
