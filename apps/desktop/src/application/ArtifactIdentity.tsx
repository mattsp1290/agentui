import { useEffect, useState } from 'react';
import { parseArtifactManifest, artifactIdentityText, assertArtifactId } from '@agentui/contracts/artifact';

interface Identity {
  readonly artifactId: string;
  readonly sourceRevision: string;
  readonly dirty: boolean;
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
        const manifest = parseArtifactManifest(value);
        const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(artifactIdentityText(manifest)));
        assertArtifactId(manifest, [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join(''));
        if (manifest.platform !== 'browser-development') throw new Error('Unsupported browser build manifest');
        if (!controller.signal.aborted) setState({ artifactId: manifest.artifactId, sourceRevision: manifest.sourceRevision, dirty: manifest.sourceDirty.kind === 'dirty' });
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
