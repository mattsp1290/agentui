import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { gunzipSync } from 'node:zlib';
import { createReleaseArchive } from '../../scripts/agentui-launch.mjs';

test('deployment archives contain artifact bytes without Mac metadata files', async t => {
  const temporary = await mkdtemp(join(tmpdir(), 'agentui-archive-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const source = join(temporary, 'source'), extracted = join(temporary, 'extracted');
  await mkdir(join(source, 'assets'), { recursive: true });
  await mkdir(extracted);
  await writeFile(join(source, 'artifact.json'), '{"artifactId":"example"}\n');
  await writeFile(join(source, 'assets', 'main.js'), 'console.log("artifact bytes");\n');
  if (process.platform === 'darwin') {
    for (const path of [source, join(source, 'artifact.json'), join(source, 'assets', 'main.js')]) {
      const attribute = spawnSync('/usr/bin/xattr', ['-w', 'com.agentui.archive-test', 'metadata', path], { encoding: 'utf8' });
      assert.equal(attribute.status, 0, attribute.stderr);
    }
  }
  const archive = join(temporary, 'release.tar.gz');
  await createReleaseArchive(source, archive);
  const tar = gunzipSync(await readFile(archive));
  assert.equal(tar.includes(Buffer.from('./._')), false, 'Archive must not contain AppleDouble records that Mac tar hides from its listing');
  assert.equal(tar.includes(Buffer.from('LIBARCHIVE.xattr.')), false, 'Archive must not contain Mac extended attributes');
  const listing = spawnSync('tar', ['-tzf', archive], { encoding: 'utf8' });
  assert.equal(listing.status, 0, listing.stderr);
  const files = listing.stdout.trim().split('\n').map(path => path.replace(/^\.\//, '')).filter(Boolean).sort();
  assert.deepEqual(files, ['artifact.json', 'assets/', 'assets/main.js']);
  const unpacked = spawnSync('tar', ['-xzf', archive, '-C', extracted], { encoding: 'utf8' });
  assert.equal(unpacked.status, 0, unpacked.stderr);
  assert.equal(await readFile(join(extracted, 'artifact.json'), 'utf8'), '{"artifactId":"example"}\n');
  assert.equal(await readFile(join(extracted, 'assets', 'main.js'), 'utf8'), 'console.log("artifact bytes");\n');
});
