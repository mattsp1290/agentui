import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createRefreshController } from '../../apps/host/build/tsc/refresh-jobs.js';
import { buildServerCustomization } from '../../scripts/server-customization.mjs';
import { serverCustomizationAbi } from '../../scripts/server-customization-abi.mjs';
import { fixture, write } from '../customization/build/preparation-support.mjs';
import { extension, validSource } from '../customization/build/server-support.mjs';

export const source = { repository: '/tmp/refresh-source', commit: 'a'.repeat(40) };
export const request = (id, reference = source, expectedSelectionRevision = 0) => ({ id, reference, expectedSelectionRevision });
export function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
export function databaseFixture(t, builder = { kind: 'unavailable' }) {
  const database = new DatabaseSync(':memory:'), owners = [];
  const artifactRoot = '/tmp/agentui-refresh-' + randomUUID();
  let stops = 0, replacements = 0;
  const selection = { entries: [], runtime: () => ({ kind: 'empty' }), isClosing: () => false,
    replace: async () => { replacements++; return { kind: 'replaced', generation: null }; }, stopRuntime: () => { stops++; } };
  const access = { database, hostId: 'refresh-test-host' };
  const open = async (custom = builder) => {
    const owner = await createRefreshController({ database: access, artifactRoot, builder: custom, selection });
    owners.push(owner); return owner;
  };
  t.after(async () => {
    for (const owner of owners) await owner.close().catch(() => {});
    database.close();
    await fs.rm(artifactRoot, { recursive: true, force: true });
  });
  return { database, access, artifactRoot, selection, open, stops: () => stops, replacements: () => replacements };
}
export async function realFixture(t) {
  const files = await fixture(t), repo = await files.repository('refresh-source');
  await write(repo.directory, 'server/package.json', { type: 'module', agentui: extension('refresh-test') });
  await write(repo.directory, 'server/index.ts', validSource);
  const first = { ...repo.reference(repo.commit()), subdirectory: 'server' };
  await write(repo.directory, 'server/index.ts', validSource.replace('dispose(){}', 'dispose(){} , value: "new"'));
  const second = { ...repo.reference(repo.commit()), subdirectory: 'server' };
  await write(repo.directory, 'server/index.ts', 'dirty bytes cannot compile');
  const seed = await buildServerCustomization({ reference: first, out: join(files.root, 'identity') });
  globalThis.AGENTUI_SERVER_CUSTOMIZATION_ABI = (await serverCustomizationAbi()).identity;
  const hash = async path => createHash('sha256').update(await fs.readFile(path)).digest('hex');
  const identity = { kind: 'ready', node: process.execPath,
    entrySha256: await hash(new URL('../../scripts/build-server-customization.mjs', import.meta.url)),
    lockSha256: await hash(new URL('../../package-lock.json', import.meta.url)), builder: seed.manifest.builder };
  const commands = [];
  let closes = 0, override;
  const actual = async command => {
    const built = await buildServerCustomization({ reference: command.source, out: command.directory });
    return { kind: 'built', pin: { directory: built.directory, artifactId: built.manifest.artifactId }, manifest: built.manifest };
  };
  const builder = { kind: 'ready', identity, run: async command => {
    commands.push(structuredClone(command)); return override ? override(command) : actual(command);
  }, close: async () => { closes++; } };
  const db = databaseFixture(t, builder);
  t.after(async () => { await fs.rm(db.artifactRoot, { recursive: true, force: true }); });
  return { ...db, first, second, seed, builder, commands, actual, setRun: value => { override = value; }, closes: () => closes };
}
export function verificationBarrier(t, commandId) {
  const entered = deferred(), release = deferred(), original = fs.readFile;
  const deadline = setTimeout(() => { release.resolve(); entered.resolve('timed out'); }, 10000);
  let reads = 0;
  const mock = t.mock.method(fs, 'readFile', async (path, ...args) => {
    const bytes = await original(path, ...args);
    if (String(path).endsWith('/entries.mjs') && String(path).includes(commandId()) && ++reads === 2) {
      clearTimeout(deadline); entered.resolve(); await release.promise;
    }
    return bytes;
  });
  syncBuiltinESMExports();
  const restore = () => { clearTimeout(deadline); release.resolve(); mock.mock.restore(); syncBuiltinESMExports(); };
  t.after(restore);
  return { entered: entered.promise, release: release.resolve, restore };
}
export function rows(database) {
  return database.prepare('SELECT * FROM host_refresh_jobs ORDER BY ordinal').all();
}
export function assertSelected(receipt, id) {
  assert.equal(receipt.job.promotion.kind, 'selected');
  assert.equal(receipt.job.request.id, id);
  assert.equal(receipt.job.promotion.operation.id, receipt.job.promotion.command.id);
  assert.equal(receipt.selectionStatus.runtime.kind, 'withheld');
}
