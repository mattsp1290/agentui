import { execFileSync } from 'node:child_process';
import { lstat, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { stageNativeArtifact } from './stage-native-artifact.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const { values } = parseArgs({ options: Object.fromEntries(['artifact', 'artifact-id', 'out'].map(name => [name, { type: 'string' }])) });
if (!values.artifact || !/^[a-f0-9]{64}$/u.test(values['artifact-id'] ?? '') || !values.out) {
  throw new Error('Usage: node scripts/package-native-customization.mjs --artifact DIRECTORY --artifact-id SHA256 --out FRESH_DIRECTORY');
}
if (process.platform !== 'darwin' || !['arm64', 'x64'].includes(process.arch)) {
  throw new Error('Native customization packaging requires an arm64 or x64 Mac');
}
const out = resolve(values.out);
await mkdir(out, { mode: 0o700 });
let complete = false;
try {
  const directory = await realpath(out);
  const { directory: frontendDist, manifest } = await stageNativeArtifact({
    artifact: resolve(values.artifact), artifactId: values['artifact-id'], out: join(directory, 'frontend'),
  });
  const config = join(directory, 'tauri-build.json');
  await writeFile(config, JSON.stringify({ build: { frontendDist, beforeBuildCommand: '' } }), { flag: 'wx', mode: 0o600 });
  const target = process.arch === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin';
  const cargoTarget = join(directory, 'cargo-target');
  execFileSync(process.execPath, [join(root, 'node_modules/@tauri-apps/cli/tauri.js'),
    'build', '--bundles', 'app', '--target', target, '--config', config], {
    cwd: join(root, 'apps/desktop'), stdio: 'inherit', env: { ...process.env, CARGO_TARGET_DIR: cargoTarget },
  });
  const app = join(cargoTarget, target, 'release/bundle/macos/AgentUI.app');
  if (!(await lstat(app)).isDirectory()) throw new Error('Tauri did not produce the native app');
  complete = true;
  process.stdout.write(`${JSON.stringify({ app, artifactId: manifest.artifactId })}\n`);
} finally {
  if (!complete) await rm(out, { recursive: true, force: true });
}
