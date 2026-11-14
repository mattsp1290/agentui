import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';

const directory = new URL('../../../vendor/crew-client/80c9804cfae7d5c323dbbdda77071ac9d0939877/', import.meta.url);
test('retained Crew package and source archives match the exact-revision manifest', async () => {
  const manifest = JSON.parse(await readFile(new URL('manifest.json', directory), 'utf8'));
  assert.equal(manifest.sourceRevision, '80c9804cfae7d5c323dbbdda77071ac9d0939877');
  for (const [file, digest] of [[manifest.packageArchive, manifest.packageArchiveSha256],
    [manifest.sourceArchive, manifest.sourceArchiveSha256]]) {
    const bytes = await readFile(new URL(file, directory));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), digest);
  }
  const listing = execFileSync('tar', ['tzf', new URL(manifest.packageArchive, directory).pathname], { encoding: 'utf8' });
  assert.ok(listing.includes('package/dist/index.js'));
  assert.ok(listing.includes('package/dist/agui.js'));
  assert.ok(!listing.includes('node_modules'));
  assert.match(await readFile(new URL('LICENSE', directory), 'utf8'), /MIT License/);
  const consumer = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(consumer.dependencies['@birbcrew/client'], `file:../../vendor/crew-client/${manifest.sourceRevision}/${manifest.packageArchive}`);
});
