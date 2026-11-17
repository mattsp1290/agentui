import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXTENSION_SDK_VERSION, SERVICE_WIRE_VERSION } from '@agentui/contracts/compatibility';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const hash = value => createHash('sha256').update(value).digest('hex');
export async function assertSourceMapFresh(path, originalPath = path) {
  const map = JSON.parse(await readFile(path, 'utf8')), sources = [];
  for (const [index, source] of map.sources.entries()) {
    const path = resolve(dirname(originalPath), source), local = relative(root, path);
    if (!/^(?:apps|packages)\/[^/]+\/src\//u.test(local)) continue;
    assert.equal(map.sourcesContent[index], await readFile(path, 'utf8'), `Stale installed source map: ${local}`);
    sources.push(local);
  }
  return sources;
}
export async function assertInstalledFresh() {
  const source = await readFile(resolve(root, 'packages/contracts/src/compatibility.ts'), 'utf8');
  assert.equal(EXTENSION_SDK_VERSION, /EXTENSION_SDK_VERSION = '([^']+)'/u.exec(source)?.[1], 'Stale loaded SDK compatibility');
  assert.equal(SERVICE_WIRE_VERSION, Number(/SERVICE_WIRE_VERSION = (\d+)/u.exec(source)?.[1]), 'Stale loaded wire compatibility');
  const distribution = resolve(root, 'apps/host/dist'), artifact = JSON.parse(await readFile(resolve(distribution, 'artifact.json'), 'utf8'));
  assert.equal(artifact.sourceRevision, execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), 'Stale installed source revision');
  assert.equal(artifact.lockSha256, hash(await readFile(resolve(root, 'package-lock.json'))), 'Stale installed dependency lock');
  assert.equal(artifact.extensionSdkVersion, EXTENSION_SDK_VERSION); assert.equal(artifact.wireVersion, SERVICE_WIRE_VERSION);
  const graph = JSON.parse(await readFile(resolve(distribution, 'runtime-graph.json'), 'utf8')), sources = new Set();
  for (const output of Object.keys(graph.outputs)) {
    const path = resolve(root, output), asset = artifact.assets.find(value => value.path === relative(distribution, path));
    assert.ok(asset, `Installed output lacks artifact binding: ${output}`);
    assert.equal(hash(await readFile(path)), asset.sha256, `Installed output changed: ${output}`);
    if (output.endsWith('.map')) for (const source of await assertSourceMapFresh(path)) sources.add(source);
  }
  for (const path of ['apps/host/src/main.ts', 'apps/host/src/control.ts', 'apps/host/src/refresh-jobs.ts', 'packages/contracts/src/compatibility.ts']) assert.ok(sources.has(path), `Missing installed source binding: ${path}`);
}
