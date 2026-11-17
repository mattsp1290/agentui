import { DatabaseSync } from 'node:sqlite';
import { createRefreshController } from '../../../apps/host/build/tsc/refresh-jobs.js';
import { buildServerCustomization } from '../../../scripts/server-customization.mjs';
const [path, root, payload] = process.argv.slice(2), input = JSON.parse(payload);
const database = new DatabaseSync(path);
const owner = await createRefreshController({ database: { database, hostId: 'refresh-test-host' }, artifactRoot: root,
  selection: { entries: [], runtime: () => ({ kind: 'empty' }), isClosing: () => false,
    replace: async () => { throw new Error('Refresh must not activate'); }, stopRuntime: () => {} },
  builder: { kind: 'ready', identity: input.identity, close: async () => {}, run: async command => {
    const built = await buildServerCustomization({ reference: command.source, out: command.directory });
    process.stdout.write(JSON.stringify({ pid: process.pid, directory: built.directory, artifactId: built.manifest.artifactId }) + '\n');
    process.stdin.resume();
    return new Promise(() => {});
  } } });
await owner.request(input.request);
