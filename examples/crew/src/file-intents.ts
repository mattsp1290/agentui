import { open, readFile, rename, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { IntentStorage } from './index.js';

export function fileIntents(path: string): IntentStorage {
  return {
    async load() {
      try { return JSON.parse(await readFile(path, 'utf8')); }
      catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
        throw error;
      }
    },
    async save(record) {
      await mkdir(dirname(path), { recursive: true });
      const handle = await open(`${path}.next`, 'w', 0o600);
      try { await handle.writeFile(JSON.stringify(record)); await handle.sync(); }
      finally { await handle.close(); }
      await rename(`${path}.next`, path);
      const directory = await open(dirname(path), 'r');
      try { await directory.sync(); }
      finally { await directory.close(); }
    },
  };
}
