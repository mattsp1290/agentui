// The customization worker's store on the launcher machine: `<setup root>/customization/`, shared by every profile.
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';

export const LOCK_WAIT_MS = 30_000;
export const HEARTBEAT_MS = 5_000;
export const STALE_HEARTBEAT_MS = 60_000;

export class StoreBusy extends Error {}
export class StateInvalid extends Error {}

export async function writeAtomic(path, text) {
  const temporary = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    await writeFile(temporary, text, { mode: 0o600 });
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
}

/** The start time `ps` reports for a process, or null when no such process exists. */
export function processStartTime(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  try {
    const text = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, LC_ALL: 'C' } }).trim();
    return text || null;
  } catch { return null; }
}
/** True only when the recorded owner provably no longer holds the lock. */
export function ownerIsDead(owner, now = Date.now()) {
  if (!owner || typeof owner !== 'object') return true;
  if (typeof owner.heartbeatAt !== 'number' || now - owner.heartbeatAt > STALE_HEARTBEAT_MS) return true;
  if (owner.hostname !== hostname()) return false;
  const started = processStartTime(owner.pid);
  return started === null || started !== owner.processStartTime;
}

export function openStore(setupRoot) {
  const root = join(setupRoot, 'customization');
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const paths = { root, connection: join(root, 'connection.json'), clone: join(root, 'clone'), builds: join(root, 'builds'),
    npmCache: join(root, 'npm-cache'), scratch: join(root, 'scratch'), lock: join(root, 'lock'), profiles: join(root, 'profiles'),
    gitLog: join(root, 'git.log') };
  const ownerFile = join(paths.lock, 'owner.json');
  const readOwner = async () => { try { return JSON.parse(await readFile(ownerFile, 'utf8')); } catch { return null; } };

  return {
    paths,
    async readConnection() {
      let text;
      try { text = await readFile(paths.connection, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return null; throw new StateInvalid(); }
      let value;
      try { value = JSON.parse(text); } catch { throw new StateInvalid(); }
      if (value === null) return null;
      if (value?.version !== 1 || Object.keys(value).sort().join() !== 'branch,location,subdirectory,version' ||
        ![value.location, value.branch, value.subdirectory].every(item => typeof item === 'string')) throw new StateInvalid();
      return { location: value.location, branch: value.branch, subdirectory: value.subdirectory };
    },
    async writeConnection(connection) {
      if (connection === null) { await rm(paths.connection, { force: true }); return; }
      await writeAtomic(paths.connection, `${JSON.stringify({ version: 1, ...connection })}\n`);
    },
    async appendGitLog(output) {
      await writeAtomic(paths.gitLog, output.slice(-16 * 1024));
    },
    readOwner,
    /**
     * Takes the store lock for one git or state mutation. Waits up to `waitMs`, then throws StoreBusy. A lock is taken
     * over only when its owner is provably dead.
     */
    async lock({ sessionId, waitMs = LOCK_WAIT_MS, signal, now = Date.now } = {}) {
      const deadline = now() + waitMs;
      const owner = () => ({ pid: process.pid, processStartTime: processStartTime(process.pid), hostname: hostname(), sessionId, heartbeatAt: now() });
      for (;;) {
        if (signal?.aborted) throw new StoreBusy();
        try {
          await mkdir(paths.lock, { mode: 0o700 });
          await writeAtomic(ownerFile, JSON.stringify(owner()));
          break;
        } catch (error) {
          if (error.code !== 'EEXIST') throw error;
          const current = await readOwner();
          // A lock directory without an owner file is mid-creation unless it has been that way for a while.
          const orphaned = !current && await stat(paths.lock).then(info => Date.now() - info.mtimeMs > STALE_HEARTBEAT_MS, () => false);
          if (orphaned || (current && ownerIsDead(current, now()))) {
            const stale = `${paths.lock}.stale-${randomBytes(6).toString('hex')}`;
            try { await rename(paths.lock, stale); await rm(stale, { recursive: true, force: true }); } catch { /* another worker took it */ }
            continue;
          }
          if (now() >= deadline) throw new StoreBusy();
          await new Promise(resolve => setTimeout(resolve, 200));
        }
      }
      let released = false;
      const heartbeat = setInterval(() => { void writeAtomic(ownerFile, JSON.stringify(owner())).catch(() => {}); }, HEARTBEAT_MS);
      heartbeat.unref();
      return async () => {
        if (released) return;
        released = true;
        clearInterval(heartbeat);
        const current = await readOwner();
        if (current?.pid === process.pid && current?.sessionId === sessionId) await rm(paths.lock, { recursive: true, force: true });
      };
    },
  };
}
