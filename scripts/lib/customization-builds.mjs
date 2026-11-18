// The worker's builds: keys, records, the one-build-per-machine slot, preemption, recovery and pruning.
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join, posix } from 'node:path';
import { promisify } from 'node:util';
import { canonicalJson } from '@agentui/contracts';
import { committedReferenceKey, customizationSettingsFile, resolveCustomizationSources } from '@agentui/host/customization';
import { ownerIsDead, processStartTime, StoreBusy, writeAtomic } from './customization-store.mjs';

const run = promisify(execFile);
export const BUILD_LIMIT_MS = 30 * 60_000;
export const BUILD_LIMITS = Object.freeze({ installSeconds: 900, prepareSeconds: 1_200, resolveSeconds: 600 });
const FINAL = new Set(['ready', 'failed', 'cancelled']);
const LOG_TAIL = 64 * 1024;
const sha256 = value => createHash('sha256').update(value).digest('hex');

/** The checkout's builder identity, read in a fresh process so a rebuilt checkout is seen. */
export async function readBuilderIdentity(repositoryRoot) {
  const program = `const { readFile } = await import('node:fs/promises');
    const host = JSON.parse(await readFile(${JSON.stringify(join(repositoryRoot, 'apps/host/dist/artifact.json'))}, 'utf8'));
    const { serverCustomizationAbi } = await import(${JSON.stringify(join(repositoryRoot, 'scripts/server-customization-abi.mjs'))});
    const { EXTENSION_SDK_VERSION, SERVICE_WIRE_VERSION } = await import('@agentui/contracts/compatibility');
    process.stdout.write(JSON.stringify({ hostArtifactId: host.artifactId, abiIdentity: (await serverCustomizationAbi()).identity, sdkVersion: EXTENSION_SDK_VERSION, wireVersion: SERVICE_WIRE_VERSION }));`;
  const { stdout } = await run(process.execPath, ['--input-type=module', '-e', program], { cwd: repositoryRoot, encoding: 'utf8', timeout: 60_000 });
  return JSON.parse(stdout);
}

function walk(root) {
  const seen = new Set(), nodes = [];
  const visit = node => { if (seen.has(node)) return; seen.add(node); nodes.push(node); node.extensions.forEach(visit); };
  visit(root);
  return nodes;
}
/**
 * The inputs key: the resolved graph without the settings file. Packages in the root's repository are keyed by that
 * repository's file inventory minus the root's settings file, because their package identity covers every committed
 * file, settings included. Computing it resolves sources but installs nothing.
 */
export async function inputsKeyFor({ clone, commit, subdirectory, scratchParent }) {
  const resolved = await resolveCustomizationSources({ reference: { repository: clone, commit, ...(subdirectory ? { subdirectory } : {}) }, scratchParent });
  try {
    const { root } = resolved;
    const settings = subdirectory ? posix.join(subdirectory, customizationSettingsFile) : customizationSettingsFile;
    const inventory = sha256(JSON.stringify(root.inputs.files.filter(file => file.path !== settings).map(file => [file.path, file.sha256, file.executable])));
    const identity = node => node.repositoryDirectory === root.repositoryDirectory ? sha256(JSON.stringify(['agentui-same-repository-v1', inventory, node.subdirectory])) : node.identity;
    const customization = root.customization;
    const local = customization?.local;
    const metadata = canonicalJson({ extension: local?.manifest ?? null, sources: local ? Object.fromEntries(local.sources) : null, shared: customization?.shared ?? null,
      extensions: (customization?.extensions ?? []).map(reference => ({ key: committedReferenceKey(reference), enabled: reference.enabled })),
      installations: customization?.installations ?? [] });
    const enabled = walk(root).slice(1).map(identity);
    const nodes = walk(root);
    const builds = nodes.some(node => node.customization?.local);
    const key = sha256(JSON.stringify(['agentui-inputs-v1', enabled, metadata, local ? inventory : null]));
    return { inputsKey: key, buildsSomething: builds, namespaces: nodes.flatMap(node => node.customization?.local ? [node.customization.local.manifest.namespace] : []),
      grants: customization?.installations ?? [] };
  } finally { await resolved.dispose(); }
}
export const buildKeyFor = (inputsKey, builder) => sha256(JSON.stringify(['agentui-build-v1', inputsKey, canonicalJson(builder)]));

export async function chromiumInstalled(repositoryRoot, environment = process.env) {
  const program = `const { chromium } = await import('playwright'); const { existsSync } = await import('node:fs'); process.stdout.write(existsSync(chromium.executablePath()) ? 'yes' : 'no');`;
  try {
    const { stdout } = await run(process.execPath, ['--input-type=module', '-e', program], { cwd: repositoryRoot, env: environment, encoding: 'utf8', timeout: 30_000 });
    return stdout === 'yes';
  } catch { return false; }
}
const alive = (pid, startTime) => pid > 0 && processStartTime(pid) === startTime;
const killGroup = pgid => { try { process.kill(-pgid, 'SIGKILL'); } catch { /* gone */ } };

/**
 * Creates the build manager for one worker. `onChange` is called whenever a record changes so the worker pushes status.
 * Injectable for tests: `readIdentity`, `script` (the builder), `limitMs`, `chromium`.
 */
export function createBuildManager({ store, repositoryRoot, sessionId, signal, registerChild = () => {}, onChange = () => {},
  readIdentity = () => readBuilderIdentity(repositoryRoot), script = join(repositoryRoot, 'scripts/build-customization.mjs'),
  limitMs = BUILD_LIMIT_MS, chromium = () => chromiumInstalled(repositoryRoot, environment), environment = process.env }) {
  const builds = store.paths.builds;
  const recordPath = key => join(builds, key, 'build.json');
  let current = null; // the record of the connected head's build, as last written
  let running = null; // { key, child, timer }
  const owner = () => ({ sessionId, pid: process.pid, processStartTime: processStartTime(process.pid), hostname: hostname() });
  const readRecord = async key => { try { return JSON.parse(await readFile(recordPath(key), 'utf8')); } catch { return null; } };
  const write = async record => { await writeAtomic(recordPath(record.buildKey), `${JSON.stringify(record)}\n`); if (record.buildKey === current?.buildKey || !current) current = record; onChange(); };
  const records = async () => {
    const keys = await readdir(builds).catch(() => []);
    return (await Promise.all(keys.filter(key => /^[0-9a-f]{64}$/u.test(key)).map(readRecord))).filter(Boolean);
  };
  const ownerAlive = record => record.owner && !ownerIsDead({ ...record.owner, heartbeatAt: Date.now() });
  const withLock = async action => {
    const release = await store.lock({ sessionId, signal });
    try { return await action(); } finally { await release(); }
  };

  async function finish(key, update) {
    const record = await readRecord(key);
    if (!record || FINAL.has(record.state)) return record;
    const next = { ...record, ...update, finishedAt: Date.now() };
    delete next.child;
    await write(next);
    return next;
  }
  async function prune() {
    const keep = new Set();
    for (const name of await readdir(store.paths.profiles).catch(() => [])) {
      try { const profile = JSON.parse(await readFile(join(store.paths.profiles, name), 'utf8')); for (const key of [profile.current, profile.next]) if (key) keep.add(key); } catch { /* ignore */ }
    }
    const all = await records();
    const ready = all.filter(record => record.state === 'ready').sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0));
    if (ready[0]) keep.add(ready[0].buildKey);
    if (current) keep.add(current.buildKey);
    for (const record of all) if (FINAL.has(record.state) && !keep.has(record.buildKey)) await rm(join(builds, record.buildKey), { recursive: true, force: true });
  }

  /** Kills and marks interrupted every non-final record whose owning worker is dead. Live owners are left alone. */
  async function recover() {
    await withLock(async () => {
      for (const record of await records()) {
        if (FINAL.has(record.state) || ownerAlive(record)) continue;
        // Only a process group whose leader still has the recorded start time is the build; a reused ID is left alone.
        if (record.child && alive(record.child.pgid, record.child.startTime)) killGroup(record.child.pgid);
        const next = { ...record, state: 'failed', failure: 'interrupted', finishedAt: Date.now() };
        delete next.child;
        await writeAtomic(recordPath(record.buildKey), `${JSON.stringify(next)}\n`);
      }
    }).catch(error => { if (!(error instanceof StoreBusy)) throw error; });
  }

  async function cancelRunning(state = 'cancelled', failure) {
    if (!running) return;
    const { key, child, timer } = running;
    running = null;
    clearTimeout(timer);
    killGroup(child.pid);
    await finish(key, failure ? { state: 'failed', failure } : { state });
  }

  // Starts run one at a time, in request order, so a later request always sees the earlier one's running build.
  let queue = Promise.resolve();
  const start = request => { const next = queue.then(() => startNow(request)); queue = next.catch(() => {}); return next; };
  /** Starts (or reuses) the build of `head`. Returns the record. */
  async function startNow({ connection, head, force = false }) {
    let builder, inputs;
    const scratchKey = sha256(`${connection.location}\0${head}`);
    try {
      builder = await readIdentity();
      inputs = await inputsKeyFor({ clone: store.paths.clone, commit: head, subdirectory: connection.subdirectory, scratchParent: join(store.paths.scratch, scratchKey) });
    } catch {
      inputs = null;
    } finally { await rm(join(store.paths.scratch, scratchKey), { recursive: true, force: true }); }
    const inputsKey = inputs?.inputsKey ?? sha256(JSON.stringify(['agentui-unresolved-v1', head, connection.subdirectory]));
    const buildKey = buildKeyFor(inputsKey, builder ?? {});
    if (running?.key === buildKey && !force) return current;
    const existing = await readRecord(buildKey);
    if (existing?.state === 'ready' && !force) { current = existing; onChange(); return existing; }
    if (existing && !FINAL.has(existing.state) && ownerAlive(existing) && existing.owner.sessionId !== sessionId) { current = existing; onChange(); return existing; }
    const grantsFor = namespaces => ({ grants: (inputs?.grants ?? []).filter(grant => namespaces.includes(grant.instance.namespace)),
      ignoredGrants: (inputs?.grants ?? []).filter(grant => !namespaces.includes(grant.instance.namespace)).map(grant => `${grant.instance.namespace}/${grant.id}`) });
    const base = { version: 1, buildKey, inputsKey, builderIdentity: builder ?? null, commit: head, startedAt: Date.now(), phases: {},
      namespaces: inputs?.namespaces ?? [], ...grantsFor(inputs?.namespaces ?? []), owner: owner() };
    return withLock(async () => {
      // The slot: one build per machine. This worker's own build is preempted; another live session's build is reported.
      const others = (await records()).filter(record => !FINAL.has(record.state) && record.buildKey !== buildKey);
      const foreign = others.find(record => ownerAlive(record) && record.owner.sessionId !== sessionId);
      if (foreign) { current = foreign; onChange(); return foreign; }
      await cancelRunning();
      await rm(join(builds, buildKey), { recursive: true, force: true });
      await rm(join(store.paths.scratch, buildKey), { recursive: true, force: true });
      await mkdir(join(builds, buildKey), { recursive: true, mode: 0o700 });
      current = { ...base, state: 'queued' };
      if (!builder || !inputs) { current = { ...base, state: 'failed', failure: builder ? 'resolve-failed' : 'toolchain-missing', finishedAt: Date.now() }; await write(current); return current; }
      if (!inputs.buildsSomething) {
        current = { ...base, ...grantsFor([]), state: 'ready', namespaces: [], desktopArtifactId: null, serverArtifactId: null, finishedAt: Date.now() };
        await write(current);
        return current;
      }
      if (!await chromium()) { current = { ...base, state: 'failed', failure: 'toolchain-missing', finishedAt: Date.now() }; await write(current); return current; }
      await write(current);
      const child = spawn(process.execPath, [script, '--repository', store.paths.clone, '--commit', head, ...(connection.subdirectory ? ['--subdirectory', connection.subdirectory] : []),
        '--out', join(builds, buildKey), '--scratch', join(store.paths.scratch, buildKey), '--npm-cache', store.paths.npmCache,
        '--install-timeout-seconds', String(BUILD_LIMITS.installSeconds), '--prepare-timeout-seconds', String(BUILD_LIMITS.prepareSeconds),
        '--resolve-timeout-seconds', String(BUILD_LIMITS.resolveSeconds)], { cwd: repositoryRoot, detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: environment });
      registerChild(child);
      const startTime = await new Promise(resolve => child.once('spawn', () => resolve(processStartTime(child.pid))));
      current = { ...current, child: { pgid: child.pid, startTime } };
      await write(current);
      const timer = setTimeout(() => { void cancelRunning('failed', 'timeout'); }, limitMs);
      running = { key: buildKey, child, timer };
      let log = '', lines = '', outcome = null;
      const phaseNames = { resolving: 'resolve', preparing: 'prepare', 'building-desktop': 'desktop', 'building-server': 'server' };
      let phase = null;
      child.stderr.on('data', data => { log = (log + data).slice(-LOG_TAIL); });
      child.stdout.on('data', data => {
        log = (log + data).slice(-LOG_TAIL);
        lines += data;
        const parts = lines.split('\n');
        lines = parts.pop();
        for (const line of parts) {
          let message;
          try { message = JSON.parse(line); } catch { continue; }
          if (typeof message.phase === 'string' && phaseNames[message.phase]) {
            const now = Date.now();
            const phases = { ...current.phases };
            if (phase) phases[phaseNames[phase]] = { ...phases[phaseNames[phase]], finishedAt: now };
            phase = message.phase;
            phases[phaseNames[phase]] = { startedAt: now };
            if (current.buildKey === buildKey) { current = { ...current, state: phase, phases }; void write(current); }
          } else if (message.result || message.failure) outcome = message;
        }
      });
      child.once('close', () => {
        void (async () => {
          clearTimeout(timer);
          await writeFile(join(builds, buildKey, 'log.txt'), log, { mode: 0o600 }).catch(() => {});
          if (running?.key !== buildKey) return; // cancelled, timed out or interrupted already recorded
          running = null;
          const now = Date.now();
          const phases = { ...(await readRecord(buildKey))?.phases };
          if (phase) phases[phaseNames[phase]] = { ...phases[phaseNames[phase]], finishedAt: now };
          let update;
          if (outcome?.result) {
            const after = await readIdentity().catch(() => null);
            update = canonicalJson(after) !== canonicalJson(builder) ? { state: 'failed', failure: 'builder-changed', phases }
              : { state: 'ready', phases, desktopArtifactId: outcome.result.desktopArtifactId, serverArtifactId: outcome.result.serverArtifactId,
                namespaces: outcome.result.namespaces, ...grantsFor(outcome.result.namespaces) };
          } else update = { state: 'failed', failure: outcome?.failure ?? 'interrupted', phases };
          await withLock(async () => { await finish(buildKey, update); await prune(); }).catch(() => finish(buildKey, update));
        })();
      });
      return current;
    });
  }

  signal?.addEventListener('abort', () => { if (running) { const { key, child, timer } = running; running = null; clearTimeout(timer); killGroup(child.pid); void finish(key, { state: 'failed', failure: 'interrupted' }); } }, { once: true });

  return {
    recover,
    start,
    async startIfNeeded(connection, head) {
      if (!connection || !head) return;
      await start({ connection, head });
    },
    status() {
      if (!current) return null;
      const grantVariables = [...new Set((current.grants ?? []).flatMap(grant => grant.authentication?.kind === 'environment' ? [grant.authentication.variable] : []))].sort();
      return { buildKey: current.buildKey, inputsKey: current.inputsKey, commit: current.commit, state: current.state,
        ...(current.failure ? { failure: current.failure } : {}), startedAt: current.startedAt, ...(current.finishedAt ? { finishedAt: current.finishedAt } : {}),
        namespaces: current.namespaces ?? [], ignoredGrants: current.ignoredGrants ?? [], hostArtifactId: current.builderIdentity?.hostArtifactId ?? '0'.repeat(64), grantVariables };
    },
    current: () => current,
    async idle() { while (running) await new Promise(resolve => setTimeout(resolve, 50)); },
    exists: key => existsSync(join(builds, key)),
  };
}
