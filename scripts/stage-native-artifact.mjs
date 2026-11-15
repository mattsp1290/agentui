import { mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { readArtifactBytes } from '../apps/host/build/tsc/artifact.js';

export async function stageNativeArtifact({ artifact, artifactId, out }) {
  const { manifest, files } = readArtifactBytes(artifact, 'browser-development');
  if (manifest.artifactId !== artifactId) throw new Error('Selected artifact ID does not match');
  if (!files.has('index.html') || !files.has('browser.html')) {
    throw new Error('Artifact needs native index.html and browser.html entries; rebuild the customization');
  }
  await mkdir(out, { mode: 0o700 });
  try {
    const directory = await realpath(out);
    for (const [name, bytes] of files) {
      const path = join(directory, name);
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      await writeFile(path, bytes, { flag: 'wx', mode: 0o600 });
    }
    return { directory, manifest };
  } catch (error) {
    await rm(out, { recursive: true, force: true });
    throw error;
  }
}
