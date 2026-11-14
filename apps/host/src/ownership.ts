import { chmodSync, lstatSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export function ownDirectory(directory: string): { readonly directory: string; close(): void } {
  const path = resolve(directory);
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) {
    throw new Error('Host data directory must be a private directory owned by this user');
  }
  const lockPath = join(path, 'owner.sqlite');
  const lock = new DatabaseSync(lockPath);
  try {
    chmodSync(lockPath, 0o600);
    lock.exec('PRAGMA busy_timeout=0; PRAGMA journal_mode=DELETE; BEGIN EXCLUSIVE;');
  } catch (error) {
    lock.close();
    if (error instanceof Error && 'errcode' in error && error.errcode === 5) throw new Error('Another host owns this data directory');
    throw error;
  }
  let closed = false;
  return { directory: path, close() { if (!closed) { closed = true; lock.close(); } } };
}
