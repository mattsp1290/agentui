import { useEffect, useState } from 'react';

interface Identity {
  readonly artifactId: string;
  readonly sourceRevision: string;
  readonly dirty: boolean;
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid build manifest');
  return value as Record<string, unknown>;
}
function hash(value: unknown, ...lengths: readonly number[]): string {
  if (typeof value !== 'string' || !lengths.includes(value.length) || !/^[a-f0-9]+$/.test(value)) throw new Error('Invalid build identity');
  return value;
}
function decode(value: unknown): Identity {
  const input = object(value);
  if (input.schemaVersion !== 1 || input.platform !== 'browser-development' || input.wireVersion !== 1 || input.extensionSdkVersion !== '0.0.0') throw new Error('Unsupported browser build manifest');
  const source = object(input.sourceDirty);
  if (source.kind !== 'clean' && source.kind !== 'dirty') throw new Error('Invalid source state');
  if (source.kind === 'dirty') hash(source.fingerprint, 64);
  for (const value of [input.nativeRuntime, input.artifactRuntime]) {
    const runtime = object(value);
    if (runtime.engine !== 'browser' || runtime.version !== 'development' || runtime.format !== 'web-assets') throw new Error('Unexpected browser runtime');
  }
  hash(input.lockSha256, 64);
  if (!Array.isArray(input.assets) || input.assets.length === 0) throw new Error('Missing build assets');
  const paths = new Set<string>();
  for (const value of input.assets) {
    const asset = object(value);
    if (typeof asset.path !== 'string' || !asset.path || asset.path.startsWith('/') || asset.path.split('/').includes('..') || paths.has(asset.path)) throw new Error('Invalid build asset path');
    paths.add(asset.path);
    hash(asset.sha256, 64);
  }
  return { artifactId: hash(input.artifactId, 64), sourceRevision: hash(input.sourceRevision, 40, 64), dirty: source.kind === 'dirty' };
}

export function ArtifactIdentity() {
  const [state, setState] = useState<Identity | string>('Reading installed build identity…');
  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch('/artifact.json', { signal: controller.signal, cache: 'no-store' });
        if (!response.ok) throw new Error('Build manifest unavailable');
        const value: unknown = await response.json();
        setState(decode(value));
      } catch (error) {
        if (!controller.signal.aborted) setState(error instanceof Error ? error.message : 'Build identity unavailable');
      }
    })();
    return () => controller.abort();
  }, []);
  return typeof state === 'string' ? <p className="artifact-identity">{state}</p> : <details className="artifact-identity">
    <summary>Browser build {state.artifactId.slice(0, 12)} · {state.dirty ? 'includes local changes' : 'clean source'}</summary>
    <p>Client artifact <code>{state.artifactId}</code></p><p>Source revision <code>{state.sourceRevision}</code></p>
  </details>;
}
