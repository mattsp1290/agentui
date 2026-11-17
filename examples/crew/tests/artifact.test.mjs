import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';

const revision = 'f3327346d979270a18c9f46b9cfe6a075b1cb157';
const directory = new URL(`../../../vendor/crew-client/${revision}/`, import.meta.url);
test('retained Crew package and source archives match the exact-revision manifest', async () => {
  const manifest = JSON.parse(await readFile(new URL('manifest.json', directory), 'utf8'));
  assert.equal(manifest.sourceRevision, revision);
  assert.equal(manifest.sourceTree, 'd0b9f8b90b95dd55e27b96ab11c754c3f432fc39');
  assert.equal(manifest.sourcePackageTree, '3a7c73b158ef21e7e0ccfa767a0b4aebff106509');
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
