import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync, lstatSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import { digest, parseJson, readJson } from './bytes.mjs';

const nativeVersions = {
  '@openai/codex-sdk': '0.167.1', '@openai/codex': '0.167.1',
  '@earendil-works/pi-agent-core': '1.5.0', '@earendil-works/pi-ai': '1.5.0',
  '@earendil-works/pi-coding-agent': '1.5.0', zod: '3.25.76',
};
const codexVersion = nativeVersions['@openai/codex'];

export function verifyConsumerLock(consumer, verified) {
  const { metadata, packages: expected } = verified;
  const lockBody = readFileSync(join(consumer, 'package-lock.json'));
  const manifestBody = readFileSync(join(consumer, 'package.json'));
  assert.equal(digest(lockBody), metadata.qualification.consumerLockSha256, 'frozen consumer lock digest');
  assert.equal(digest(manifestBody), metadata.qualification.consumerPackageSha256, 'frozen consumer manifest digest');
  const lock = parseJson(lockBody);
  const manifest = parseJson(manifestBody);
  verifyConsumerMetadata(lock, manifest, expected);
}

export function verifyConsumerMetadata(lock, manifest, expected) {
  assert.deepEqual(lock.packages[''].dependencies, manifest.dependencies, 'consumer root dependencies');
  const seen = new Set();
  for (const [path, entry] of Object.entries(lock.packages)) {
    const name = path.split('node_modules/').at(-1);
    if (!name.startsWith('@ag-ui/') && !entry.name?.startsWith('@ag-ui/')) continue;
    assert.ok(expected.has(name) && !seen.has(name), `${path}: unexpected or repeated AG-UI package`);
    assert.equal(path, `node_modules/${name}`, `${path}: nested or aliased AG-UI`);
    assert.ok(!entry.name || entry.name === name, `${path}: aliased AG-UI identity`);
    const packed = expected.get(name);
    assert.equal(entry.resolved, `file:../artifacts/${packed.filename}`, `${path}: resolution`);
    assert.equal(manifest.dependencies[name], entry.resolved, `${path}: manifest resolution`);
    assert.equal(entry.integrity, packed.integrity, `${path}: integrity`);
    seen.add(name);
  }
  assert.deepEqual([...seen].sort(), [...expected.keys()].sort(), 'consumer AG-UI package set');
  for (const [name, version] of Object.entries(nativeVersions)) {
    assert.equal(lock.packages[`node_modules/${name}`]?.version, version, `${name}: locked native version`);
    assert.equal(manifest.dependencies[name], version, `${name}: native dependency`);
  }
  for (const os of ['darwin', 'linux', 'win32']) for (const arch of ['arm64', 'x64']) {
    const entry = lock.packages[`node_modules/@openai/codex-${os}-${arch}`];
    assert.ok(entry?.optional, `${os}-${arch}: optional Codex payload declaration`);
    assert.equal(entry.version, `${codexVersion}-${os}-${arch}`, `${os}-${arch}: optional Codex payload version`);
  }
}
function* packageRoots(modules) {
  if (!existsSync(modules) || !lstatSync(modules).isDirectory()) return;
  for (const entry of readdirSync(modules, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const path = join(modules, entry.name);
    if (entry.name.startsWith('@') && entry.isDirectory()) {
      yield* packageRoots(path);
      continue;
    }
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const manifest = join(path, 'package.json');
    if (existsSync(manifest)) yield { root: path, manifest, linked: entry.isSymbolicLink() };
    if (entry.isDirectory()) yield* packageRoots(join(path, 'node_modules'));
  }
}
export function verifyInstalled(consumer, verified) {
  const { packages: expected } = verified;
  const installed = new Set();
  for (const { root, manifest, linked } of packageRoots(join(consumer, 'node_modules'))) {
    const body = readJson(manifest);
    const name = relative(consumer, root).split('node_modules/').at(-1);
    if (!body.name?.startsWith('@ag-ui/') && !name.startsWith('@ag-ui/')) continue;
    assert.ok(!linked, `${root}: linked AG-UI root`);
    assert.ok(expected.has(body.name) && !installed.has(body.name), `${root}: unexpected or repeated AG-UI`);
    assert.equal(relative(consumer, root), `node_modules/${body.name}`, `${root}: nested or aliased AG-UI`);
    assert.deepEqual(body, expected.get(body.name).manifest, `${root}: packed manifest`);
    installed.add(body.name);
  }
  assert.deepEqual([...installed].sort(), [...expected.keys()].sort(), 'installed AG-UI package set');
  for (const [name, version] of Object.entries(nativeVersions)) {
    assert.equal(readJson(join(consumer, 'node_modules', name, 'package.json')).version, version, `${name}: installed native version`);
  }
  const native = join(consumer, 'node_modules/@openai', `codex-${process.platform}-${process.arch}`);
  assert.equal(readJson(join(native, 'package.json')).version, `${codexVersion}-${process.platform}-${process.arch}`, 'installed optional Codex package');
  assert.ok(readdirSync(join(native, 'vendor'), { recursive: true }).some((path) => basename(path) === 'codex'), 'optional native Codex CLI payload absent');
}
