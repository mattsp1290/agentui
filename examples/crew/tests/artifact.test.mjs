import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';

const directory = new URL('../../../vendor/crew-client/37c596577b4998fba67b09451ddb16ac0695c08d/', import.meta.url);
test('retained Crew package and source archives match the exact-revision manifest', async () => {
  const manifest = JSON.parse(await readFile(new URL('manifest.json', directory), 'utf8'));
  assert.equal(manifest.sourceRevision, '37c596577b4998fba67b09451ddb16ac0695c08d');
  assert.equal(manifest.sourceTree, '304b892eccc22d1f6a7d4e3a70a30e840bc1d856');
  assert.equal(manifest.sourcePackageTree, '7968b05bf317f9036ca2cb6d7a998d2856025099');
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
