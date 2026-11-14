import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { digest, forkFile, parseJson, readJson } from './bytes.mjs';

const printableAsciiWithoutBackslash = /^[\x20-\x5b\x5d-\x7e]+$/u;
const donorNotices = {
  '@ag-ui/pi': {
    copyright: 'Copyright (c) 2026 YS-BW', member: 'package/PROVENANCE.md',
    retained: 'notices/ag-ui-pi.PROVENANCE.md', revision: 'ee810dfb9ad3fe81d8854e9121b84ddee4c59148',
  },
};

function tar(args, label) {
  const env = { ...process.env, LC_ALL: 'C' };
  for (const key of ['TAR_OPTIONS', 'TAR_READER_OPTIONS', 'TAR_WRITER_OPTIONS', 'GZIP', 'TAPE']) delete env[key];
  try {
    return execFileSync('tar', args, {
      env, timeout: 60_000, maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (cause) {
    throw new Error(`tar ${args.join(' ')} failed for ${label}`, { cause });
  }
}
export const tarVersion = () => tar(['--version'], 'version probe').toString('utf8').split('\n')[0];

function extractOnce(archive, members, member) {
  assert.equal(members.filter((name) => name === member).length, 1, `${archive}: ${member} must occur exactly once`);
  return tar(['-xzOf', archive, member], archive);
}
export function verifyArchive(folder, artifact) {
  assert.equal(basename(artifact.artifact), artifact.artifact, 'archive must be inside fork folder');
  const archive = forkFile(folder, artifact.artifact);
  const body = readFileSync(archive);
  assert.equal(body.length, artifact.bytes, `${archive}: bytes`);
  assert.equal(digest(body), artifact.sha256, `${archive}: sha256`);
  assert.equal(digest(body, 'sha512'), artifact.sha512, `${archive}: sha512`);
  const integrity = `sha512-${digest(body, 'sha512', 'base64')}`;
  assert.equal(integrity, artifact.npmIntegrity, `${archive}: integrity`);
  assert.ok(artifact.members.every((member) => printableAsciiWithoutBackslash.test(member)), `${archive}: members must be printable ASCII without backslashes`);
  const listing = tar(['-tzf', archive], archive).toString('utf8');
  assert.ok(listing.endsWith('\n'), `${archive}: member listing must end with a newline`);
  const members = listing.slice(0, -1).split('\n');
  assert.deepEqual(members, artifact.members, `${archive}: ordered members`);
  const manifest = parseJson(extractOnce(archive, members, 'package/package.json'));
  assert.equal(manifest.name, artifact.package, `${archive}: package identity`);
  assert.deepEqual(manifest, artifact.packedManifest, `${archive}: packed manifest`);
  assert.equal(manifest.version, artifact.version, `${archive}: artifact version`);
  assert.ok(!JSON.stringify(manifest).includes('workspace:'), `${archive}: workspace reference`);
  assert.equal(manifest.license, 'MIT', `${archive}: license`);
  const prefix = artifact.package.replace('@', '').replace('/', '-');
  assert.deepEqual(manifest, readJson(forkFile(folder, `manifests/${prefix}.json`)), `${archive}: retained manifest`);
  const notice = extractOnce(archive, members, 'package/LICENSE');
  assert.deepEqual(notice, readFileSync(forkFile(folder, `notices/${prefix}.LICENSE`)), `${archive}: retained license`);
  assert.ok(notice.includes(Buffer.from('MIT License')), `${archive}: MIT notice`);
  const donor = donorNotices[artifact.package];
  if (donor) {
    assert.ok(notice.includes(Buffer.from(donor.copyright)), `${archive}: donor copyright`);
    const provenance = extractOnce(archive, members, donor.member);
    assert.deepEqual(provenance, readFileSync(forkFile(folder, donor.retained)), `${archive}: donor notice`);
    assert.ok(provenance.includes(Buffer.from(donor.revision)), `${archive}: donor revision`);
  }
  return { filename: artifact.artifact, integrity, manifest };
}
