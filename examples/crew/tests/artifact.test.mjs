import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';

const directory = new URL('../../../vendor/crew-client/d595188879d902a980f956591f8cd2c35d0c4f4b/', import.meta.url);
test('retained Crew package and source archives match the exact-revision manifest', async () => {
  const manifest = JSON.parse(await readFile(new URL('manifest.json', directory), 'utf8'));
  assert.equal(manifest.sourceRevision, 'd595188879d902a980f956591f8cd2c35d0c4f4b');
  assert.equal(manifest.sourceTree, '2de8d9745b66eeb669e049b1c0b2ae53969a570d');
  assert.equal(manifest.sourcePackageTree, '7caf04d1eb3d5cd90546fec2c3f52249b098bf4f');
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
