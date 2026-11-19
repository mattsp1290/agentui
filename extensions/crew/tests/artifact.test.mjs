import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';

const revision = 'dfe1c288bc4f0e338011389e10ad35656d6e4154';
const directory = new URL(`../../../vendor/crew-client/${revision}/`, import.meta.url);
test('retained Crew package and source archives match the exact-revision manifest', async () => {
  const manifest = JSON.parse(await readFile(new URL('manifest.json', directory), 'utf8'));
  assert.equal(manifest.sourceRevision, revision);
  assert.equal(manifest.sourceTree, '46e0df77348f319004a50641a8f377c7ee1d848d');
  assert.equal(manifest.sourcePackageTree, '545c249fe7da04eb72134ed5616405c607b6fd3c');
  for (const [file, digest] of [[manifest.packageArchive, manifest.packageArchiveSha256],
    [manifest.sourceArchive, manifest.sourceArchiveSha256]]) {
    const bytes = await readFile(new URL(file, directory));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), digest);
  }
  const listing = execFileSync('tar', ['tzf', new URL(manifest.packageArchive, directory).pathname], { encoding: 'utf8' });
  assert.ok(listing.includes('package/dist/index.js'));
  assert.ok(listing.includes('package/dist/agui.js'));
  assert.ok(!listing.includes('node_modules'));
  const archive = new URL(manifest.packageArchive, directory).pathname;
  const source = new URL(manifest.sourceArchive, directory).pathname;
  for (const file of ['LICENSE', 'README.md']) {
    const retained = await readFile(new URL(file, directory));
    assert.deepEqual(execFileSync('tar', ['xOzf', archive, `package/${file}`]), retained);
    assert.deepEqual(execFileSync('tar', ['xOzf', source, `packages/client/${file}`]), retained);
  }
  assert.match(await readFile(new URL('LICENSE', directory), 'utf8'), /MIT License/);
  const lock = JSON.parse(await readFile(new URL('../../../package-lock.json', import.meta.url), 'utf8'));
  const installed = lock.packages['node_modules/@birbcrew/client'];
  assert.equal(installed.resolved, `file:vendor/crew-client/${manifest.sourceRevision}/${manifest.packageArchive}`);
  assert.equal(installed.integrity, manifest.npmIntegrity);
  const bytes = await readFile(new URL(manifest.packageArchive, directory));
  assert.equal(manifest.npmIntegrity, `sha512-${createHash('sha512').update(bytes).digest('base64')}`);
  const consumer = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(consumer.dependencies['@birbcrew/client'], `file:../../vendor/crew-client/${manifest.sourceRevision}/${manifest.packageArchive}`);
});
