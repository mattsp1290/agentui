import { mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { readArtifactBytes } from '../apps/host/build/tsc/artifact.js';

export async function createNativeOutput({ artifact, out }) {
  const source = await realpath(artifact), parent = await realpath(dirname(resolve(out)));
  if (parent === source || parent.startsWith(`${source}${sep}`)) {
    throw new Error('Native output cannot be inside the input artifact');
  }
  await mkdir(out, { mode: 0o700 });
}

export async function stageNativeArtifact({ artifact, artifactId, out }) {
  const { manifest, files } = readArtifactBytes(artifact, 'browser-development');
  if (manifest.artifactId !== artifactId) throw new Error('Selected artifact ID does not match');
  if (!files.has('index.html') || !files.has('browser.html')) {
    throw new Error('Artifact needs native index.html and browser.html entries; rebuild the customization');
  }
  await createNativeOutput({ artifact, out });
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
