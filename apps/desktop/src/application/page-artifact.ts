import type { ArtifactSource } from './application-controller.js';

/** The exact URL this page was loaded from. The Mac app allows navigation only to it, so a reload uses nothing else. */
const LOADED_URL = typeof location === 'undefined' ? '' : location.href;

async function read(): Promise<string | null> {
  const response = await fetch('/artifact.json', { cache: 'no-store' });
  if (!response.ok) return null;
  const value: unknown = await response.json();
  const artifactId = value && typeof value === 'object' && 'artifactId' in value ? value.artifactId : null;
  return typeof artifactId === 'string' && /^[0-9a-f]{64}$/u.test(artifactId) ? artifactId : null;
}
let loaded: Promise<string | null> | null = null;
/**
 * Reads the served build once, when the page creates its application, so a host that restarts before the first
 * handshake is still noticed. Nothing is read in builds that never create one.
 */
export function capturePageArtifact(): ArtifactSource {
  loaded ??= read().catch(() => null);
  return pageArtifact;
}

/** The browser page's served build, read from the host's `/artifact.json`. */
const pageArtifact: ArtifactSource = {
  loaded: () => loaded ?? Promise.resolve(null),
  read,
  reload() {
    const withoutHash = (url: string) => url.split('#')[0];
    // Only the fragment differs (or nothing does): replace would not load the page again, so reload once it is current.
    if (withoutHash(location.href) === withoutHash(LOADED_URL)) {
      if (location.href !== LOADED_URL) location.replace(LOADED_URL);
      location.reload();
    } else location.replace(LOADED_URL);
  },
};
