// The session wrapper. The SSH release ships this file alone as `session.mjs`, so it imports nothing local.
// It owns one host process at a time: it reads the secrets line, chooses the launch target, starts the host, confirms its
// ready line, falls back when a target cannot start, and starts the host again when it exits with code 75.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { createInterface } from 'node:readline';

const RESTART_EXIT_CODE = 75;
const READY_TIMEOUT_MS = Number(process.env.AGENTUI_SESSION_READY_TIMEOUT_MS) > 0 ? Number(process.env.AGENTUI_SESSION_READY_TIMEOUT_MS) : 20_000;
const TOKEN = /^AGENTUI_EXTENSION_[A-Za-z0-9_]+$/;
const DIGEST = /^[0-9a-f]{64}$/;

const [node, main, ...original] = process.argv.slice(2);
const dataDirectory = original.includes('--data-dir') ? original[original.indexOf('--data-dir') + 1] : null;
const customization = dataDirectory ? join(dataDirectory, 'customization') : null;
let host = null;
let hostGroupPid = null;
let stopping;
let environment;
const lines = createInterface({ input: process.stdin, terminal: false });

function forceStopHost() {
  if (hostGroupPid === null) return;
  try {
    if (process.platform === 'win32') host.kill('SIGKILL');
    else process.kill(-hostGroupPid, 'SIGKILL');
  } catch (error) { if (error.code !== 'ESRCH') throw error; }
  hostGroupPid = null;
}
function end() {
  lines.close();
  process.stdin.destroy();
}
async function stop() {
  if (stopping) return stopping;
  stopping = (async () => {
    if (!host) return;
    if (host.exitCode !== null || host.signalCode !== null) { forceStopHost(); return; }
    const exited = new Promise(resolve => host.once('exit', resolve));
    host.kill('SIGINT');
    const deadline = setTimeout(forceStopHost, 15_000);
    try { await exited; } finally { clearTimeout(deadline); forceStopHost(); }
  })();
  await stopping;
  end();
}
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => { void stop(); });

function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return undefined; }
}
function writeAtomic(path, value) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, path);
  } finally { rmSync(temporary, { force: true }); }
}
function target(value) {
  if (value === null || typeof value !== 'object' || !DIGEST.test(value.buildKey ?? '') || !DIGEST.test(value.hostArtifactId ?? '')) return null;
  if (value.assets !== null && (typeof value.assets !== 'string' || !isAbsolute(value.assets))) return null;
  if (value.server !== null && (typeof value.server?.directory !== 'string' || !isAbsolute(value.server.directory) || !DIGEST.test(value.server.artifactId ?? ''))) return null;
  if (!Array.isArray(value.grants)) return null;
  return value;
}
/** Targets in the order they are tried: `next`, then `current`, then the original arguments (null). */
function candidates() {
  if (!customization) return { list: [null], stale: false };
  const launch = readJson(join(customization, 'launch.json'));
  const hostArtifactId = readJson(join(dirname(main), 'artifact.json'))?.artifactId;
  const list = [];
  let stale = false;
  if (launch?.version === 1) {
    for (const item of [launch.next, launch.current].map(value => value === undefined ? null : target(value))) {
      if (!item || list.some(entry => entry.buildKey === item.buildKey)) continue;
      // A build made by another host build is never started.
      if (item.hostArtifactId !== hostArtifactId) { stale = true; continue; }
      list.push(item);
    }
  }
  return { list: [...list, null], stale };
}
function withFlag(args, flag, value) {
  const next = [...args];
  const index = next.indexOf(flag);
  if (index >= 0) next.splice(index, 2, flag, value);
  else next.push(flag, value);
  return next;
}
/** The host arguments for one start. A grant whose token variable is unset or blank is left out; names only are kept. */
function argumentsFor(selected) {
  if (!selected) return { args: original, omittedGrants: [] };
  let args = original;
  const omittedGrants = [];
  if (selected.assets) args = withFlag(args, '--assets', selected.assets);
  if (selected.server) {
    const grants = selected.grants.filter(grant => {
      const authentication = grant?.authentication;
      if (authentication?.kind !== 'environment') return true;
      if (typeof environment[authentication.variable] === 'string' && environment[authentication.variable].trim()) return true;
      omittedGrants.push(authentication.variable);
      return false;
    });
    const file = join(customization, 'extensions.generated.json');
    writeAtomic(file, { version: 2, ownership: 'transient', extensions: [{ kind: 'artifact', directory: selected.server.directory,
      artifactId: selected.server.artifactId, installations: grants }] });
    args = withFlag(args, '--extensions', file);
  }
  return { args, omittedGrants: [...new Set(omittedGrants)].sort() };
}
const readyLine = line => {
  try { const value = JSON.parse(line); return typeof value?.origin === 'string' && typeof value?.hostId === 'string'; } catch { return false; }
};
/**
 * Starts the host and forwards its standard output byte for byte. Resolves `{ kind: 'ready', exited }` at its ready
 * line, or `{ kind: 'failed', code, signal }` when it exits first or, when `timed`, misses the ready deadline.
 * `onReady` runs before the ready line is forwarded, so whoever reads that line finds this start's result written.
 */
function startHost(args, timed, onReady) {
  return new Promise(resolve => {
    let ready = false, pending = '', timer;
    host = spawn(node, [main, ...args], { detached: process.platform !== 'win32', env: environment, stdio: ['ignore', 'pipe', 'inherit'] });
    hostGroupPid = host.pid ?? null;
    const exited = new Promise(done => {
      host.once('error', error => {
        process.stderr.write(`Cannot start AgentUI host: ${error.message}\n`);
        done({ code: 1, signal: null, error: true });
      });
      // A ready line printed just before an exit is still read: the exit waits briefly for standard output to end.
      host.once('exit', (code, signal) => {
        const finish = () => { clearTimeout(grace); forceStopHost(); done({ code, signal, error: false }); };
        const grace = setTimeout(finish, 200);
        if (host.stdout.readableEnded) finish(); else host.stdout.once('end', finish);
      });
    });
    host.stdout.on('data', chunk => {
      if (!ready) {
        pending = (pending + chunk.toString('utf8')).slice(-65_536);
        const parts = pending.split('\n');
        pending = parts.pop();
        if (parts.some(readyLine)) {
          ready = true;
          pending = '';
          clearTimeout(timer);
          onReady();
          resolve({ kind: 'ready', exited });
        }
      }
      process.stdout.write(chunk);
    });
    if (timed) timer = setTimeout(() => { if (!ready) forceStopHost(); }, READY_TIMEOUT_MS);
    void exited.then(result => { if (!ready) { clearTimeout(timer); resolve({ kind: 'failed', ...result }); } });
  });
}
/** One host start with fallback: `next`, then `current`, then defaults. Resolves with how the ready host, or the last try, ended. */
async function runOnce() {
  const { list, stale } = candidates();
  const failed = [];
  for (const selected of list) {
    if (stopping) return null;
    const { args, omittedGrants } = argumentsFor(selected);
    const started = await startHost(args, selected !== null, () => {
      if (!customization) return;
      writeAtomic(join(customization, 'launch-result.json'), { version: 1, hostPid: host.pid, attempted: list[0]?.buildKey ?? null,
        started: selected?.buildKey ?? null, outcome: failed.length ? 'start-failed' : selected ? 'ok' : stale ? 'stale' : 'defaults', failed, omittedGrants });
    });
    if (started.kind === 'ready') return { ...await started.exited, ready: true };
    if (!selected || started.error) return { ...started, ready: false };
    process.stderr.write(`The AgentUI host did not start with customization build ${selected.buildKey.slice(0, 12)}. Falling back.\n`);
    failed.push(selected.buildKey);
  }
  return null;
}
async function session() {
  for (;;) {
    const result = await runOnce();
    if (stopping || !result) return;
    // An applied customization asks for a restart; the session's standard input stays open because it is the lease.
    if (result.ready && result.code === RESTART_EXIT_CODE) { host = null; hostGroupPid = null; continue; }
    process.exitCode = result.code ?? (result.signal ? 1 : 0);
    end();
    return;
  }
}
lines.once('line', line => {
  try {
    const supplied = JSON.parse(line);
    if (supplied.OPENCODE_GO_API_KEY !== null && typeof supplied.OPENCODE_GO_API_KEY !== 'string') throw new Error();
    if (supplied.AGENTUI_SETUP_CAPABILITY !== undefined && (typeof supplied.AGENTUI_SETUP_CAPABILITY !== 'string' || !/^[a-f0-9]{64}$/.test(supplied.AGENTUI_SETUP_CAPABILITY))) throw new Error();
    const variables = supplied.extensionVariables ?? {};
    if (typeof variables !== 'object' || variables === null || Array.isArray(variables)) throw new Error();
    for (const [name, value] of Object.entries(variables)) if (!TOKEN.test(name) || typeof value !== 'string') throw new Error();
    const supplement = Object.fromEntries(Object.entries(variables).filter(([name]) => !process.env[name]?.trim()));
    // One environment object for every start of this session.
    environment = { ...process.env, ...supplement, ...(supplied.AGENTUI_SETUP_CAPABILITY ? { AGENTUI_SETUP_CAPABILITY: supplied.AGENTUI_SETUP_CAPABILITY } : {}), ...(process.env.OPENCODE_GO_API_KEY ? {} : supplied.OPENCODE_GO_API_KEY ? { OPENCODE_GO_API_KEY: supplied.OPENCODE_GO_API_KEY } : {}) };
  } catch {
    process.stderr.write('Invalid AgentUI session environment.\n');
    process.exitCode = 1;
    end();
    return;
  }
  void session().catch(error => {
    process.stderr.write(`AgentUI session failed: ${error?.message ?? 'unknown error'}\n`);
    process.exitCode = 1;
    void stop();
  });
});
lines.once('close', () => { void stop(); });
