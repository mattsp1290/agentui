import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, readFile, realpath, rm, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { canonicalJson } from '@agentui/contracts';
import { hex, identifier, record } from '@agentui/contracts/decode';
import { readServerCustomizationArtifact } from '@agentui/host/customization';
import type { ServerArtifactExpectation } from '@agentui/host/customization';
import type { RefreshBuilder, RefreshBuildCommand, RefreshBuildFailure, RefreshBuildResult } from './refresh-jobs.js';

type Identity = Extract<RefreshBuilder, { kind: 'ready' }>['identity'];
type Compatibility = Omit<ServerArtifactExpectation, 'artifactId'>;
type Qualification = Readonly<{ protocol: 'agentui-refresh-builder-v1'; entry: string; lockfile: string; identity: Identity; compatibility: Compatibility }>;
const fail = (failure: RefreshBuildFailure): RefreshBuildResult => ({ kind: 'failed', failure });
const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
const hash = async (path: string) => createHash('sha256').update(await readFile(path)).digest('hex');
const limits = { qualification: 30_000, build: 15 * 60_000, diagnostics: 65_536, term: 750, drain: 5000 };
const environmentKeys = ['PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME',
  'SSH_AUTH_SOCK', 'SSH_AGENT_PID', 'SSH_ASKPASS', 'SSH_ASKPASS_REQUIRE', 'DISPLAY', 'GIT_SSH', 'GIT_SSH_COMMAND',
  'GIT_SSH_VARIANT', 'GIT_ASKPASS', 'GIT_TERMINAL_PROMPT', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM', 'GIT_CONFIG_NOSYSTEM',
  'GIT_CONFIG_COUNT', 'GIT_SSL_CAINFO', 'GIT_SSL_CAPATH', 'GIT_PROXY_COMMAND', 'GH_TOKEN', 'GITHUB_TOKEN',
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy',
  'SSL_CERT_FILE', 'SSL_CERT_DIR', 'CURL_CA_BUNDLE', 'NODE_EXTRA_CA_CERTS'];
function builderEnvironment(): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => environmentKeys.includes(key) || /^GIT_CONFIG_(KEY|VALUE)_\d+$/.test(key)));
}
function qualification(value: unknown): Qualification {
  const input = record(value, ['protocol', 'entry', 'lockfile', 'identity', 'compatibility']);
  const identity = record(input.identity, ['kind', 'node', 'entrySha256', 'lockSha256', 'builder']);
  const builder = record(identity.builder, ['identity', 'esbuildVersion']);
  const compatibility = record(input.compatibility, ['sdkVersion', 'nodeVersion', 'nodeModules', 'abiIdentity']);
  if (input.protocol !== 'agentui-refresh-builder-v1' || identity.kind !== 'ready') throw new Error('Incompatible refresh builder');
  return { protocol: input.protocol, entry: identifier(input.entry, 4096), lockfile: identifier(input.lockfile, 4096),
    identity: { kind: identity.kind, node: identifier(identity.node, 4096), entrySha256: hex(identity.entrySha256, 64), lockSha256: hex(identity.lockSha256, 64),
      builder: { identity: hex(builder.identity, 64), esbuildVersion: identifier(builder.esbuildVersion, 128) } },
    compatibility: { sdkVersion: identifier(compatibility.sdkVersion, 128), nodeVersion: identifier(compatibility.nodeVersion, 128),
      nodeModules: identifier(compatibility.nodeModules, 128), abiIdentity: hex(compatibility.abiIdentity, 64) } };
}
function signal(pid: number, value: NodeJS.Signals | 0): boolean {
  try { process.kill(-pid, value); return true; }
  catch (error) {
    if (error instanceof Error && 'code' in error) {
      if (error.code === 'ESRCH') return false;
      if (error.code === 'EPERM') return true;
    }
    throw new Error('Refresh drainage failed');
  }
}

export async function createInstalledRefreshBuilder(input: { readonly entry?: string; readonly expected: Compatibility }): Promise<RefreshBuilder> {
  if (!input.entry || process.platform === 'win32') return { kind: 'unavailable' };
  const invocationDirectory = process.cwd();
  const configuredEntry = input.entry;
  let entry: string, lockfile: string;
  try {
    if (!isAbsolute(input.entry) || !(await stat(input.entry)).isFile()) return { kind: 'unavailable' };
    entry = await realpath(input.entry);
    lockfile = await realpath(join(dirname(entry), '..', 'package-lock.json'));
    if (!(await stat(lockfile)).isFile()) return { kind: 'unavailable' };
  } catch { return { kind: 'unavailable' }; }
  let closed = false, drainFailed = false, closePromise: Promise<void> | undefined;
  const runs = new Set<Promise<RefreshBuildResult>>();
  const active = new Set<{ stop(): Promise<void>; done: Promise<unknown> }>();
  async function validate(current: Qualification, expected?: Qualification, command?: RefreshBuildCommand): Promise<void> {
    if (current.entry !== entry || current.lockfile !== lockfile || current.identity.node !== process.execPath ||
      !same(current.compatibility, input.expected) || expected && !same(current, expected) || command && !same(command.toolchain, current.identity) ||
      await realpath(configuredEntry) !== entry || await realpath(join(dirname(entry), '..', 'package-lock.json')) !== lockfile ||
      current.identity.entrySha256 !== await hash(entry) || current.identity.lockSha256 !== await hash(lockfile)) throw new Error('Incompatible refresh builder');
  }
  function launch(expected?: Qualification, command?: RefreshBuildCommand): Promise<Qualification | RefreshBuildResult> {
    const child = spawn(process.execPath, ['--max-old-space-size=512', entry, '--refresh-ipc'], {
      detached: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env: builderEnvironment(), cwd: invocationDirectory,
    });
    let settled = false, phase: 'qualifying' | 'authorizing' | 'building' | 'finished' = 'qualifying';
    let diagnostics = 0, drainPromise: Promise<void> | undefined;
    let finish!: (value: Qualification | RefreshBuildResult) => void;
    const done = new Promise<Qualification | RefreshBuildResult>(resolve => { finish = resolve; });
    const closeEvent = new Promise<void>(resolve => child.once('close', () => resolve()));
    let timer = setTimeout(() => complete(fail('resource-limit')), limits.qualification);
    function drain(): Promise<void> {
      if (drainPromise) return drainPromise;
      drainPromise = (async () => {
        const pid = child.pid;
        if (pid) {
          signal(pid, 'SIGTERM');
          const grace = Date.now() + limits.term;
          while (signal(pid, 0) && Date.now() < grace) await delay(25);
          signal(pid, 'SIGKILL');
          const deadline = Date.now() + limits.drain;
          while (signal(pid, 0) && Date.now() < deadline) await delay(25);
          if (signal(pid, 0)) throw new Error('Refresh drainage failed');
        }
        let deadline: ReturnType<typeof setTimeout> | undefined;
        try { await Promise.race([closeEvent, new Promise<never>((_, reject) => { deadline = setTimeout(() => reject(new Error('Refresh drainage failed')), limits.drain); })]); }
        finally { clearTimeout(deadline); }
      })().catch(() => {
        drainFailed = true; closed = true;
        for (const owned of active) void owned.stop().catch(() => {});
        throw new Error('Refresh drainage failed');
      });
      return drainPromise;
    }
    function complete(value: Qualification | RefreshBuildResult): void {
      if (settled) return;
      settled = true; phase = 'finished'; clearTimeout(timer);
      void drain().then(() => finish(value), () => finish(fail('resource-limit')));
    }
    const owned = { stop: () => { complete(fail('unavailable')); return drain(); }, done };
    active.add(owned);
    void done.finally(() => active.delete(owned));
    child.once('error', () => complete(fail(command ? 'incompatible' : 'unavailable')));
    child.once('exit', () => complete(fail(phase === 'qualifying' || phase === 'authorizing' ? 'incompatible' : 'build')));
    for (const stream of [child.stdout, child.stderr]) stream?.on('data', (bytes: Buffer) => {
      diagnostics += bytes.length;
      if (diagnostics > limits.diagnostics) complete(fail('resource-limit'));
    });
    child.on('message', (value: unknown) => { void (async () => {
      if (settled) return;
      if (Buffer.byteLength(JSON.stringify(value)) > limits.diagnostics) { complete(fail('resource-limit')); return; }
      const message = record(value);
      if (phase === 'qualifying') {
        phase = 'authorizing';
        record(message, ['kind', 'qualification']);
        if (message.kind !== 'qualified') throw new Error();
        const current = qualification(message.qualification);
        await validate(current, expected, command);
        if (settled || closed) return;
        if (!command) { complete(current); return; }
        phase = 'building'; clearTimeout(timer);
        timer = setTimeout(() => complete(fail('resource-limit')), limits.build);
        child.send({ kind: 'build', expected: current, command }, error => { if (error) complete(fail('build')); });
      } else if (phase === 'building') {
        phase = 'finished';
        if (message.kind === 'failed') {
          record(message, ['kind', 'failure']);
          const failures: readonly RefreshBuildFailure[] = ['source', 'build', 'qualification', 'publication', 'incompatible', 'resource-limit'];
          const failure = failures.find(candidate => candidate === message.failure);
          if (!failure) throw new Error();
          complete(fail(failure)); return;
        }
        record(message, ['kind', 'artifactId', 'qualification']);
        if (message.kind !== 'built' || !command) throw new Error();
        await validate(qualification(message.qualification), expected, command);
        const artifactId = hex(message.artifactId, 64);
        const { manifest } = await readServerCustomizationArtifact({ directory: command.directory, expected: { ...input.expected, artifactId } });
        if (!same(manifest.builder, command.toolchain.kind === 'ready' ? command.toolchain.builder : null)) throw new Error();
        if (!settled && !closed) complete({ kind: 'built', pin: { directory: command.directory, artifactId }, manifest });
      } else throw new Error();
    })().catch(() => complete(fail('incompatible'))); });
    return done;
  }
  const startup = await launch();
  if (!('protocol' in startup)) {
    if (drainFailed) throw new Error('Refresh drainage failed');
    return { kind: 'unavailable' };
  }
  return { kind: 'ready', identity: structuredClone(startup.identity),
    run(command) {
      const task = (async () => {
        if (closed) return fail('unavailable');
        if (!same(command.toolchain, startup.identity) || !/^[a-zA-Z0-9_-]{1,80}$/.test(command.id)) return fail('incompatible');
        const scratch = join(dirname(command.directory), `.agentui-server-${command.id}`);
        if (await lstat(scratch).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; })) return fail('publication');
        if (closed) return fail('unavailable');
        const result = await launch(startup, command);
        if (!drainFailed) await rm(scratch, { recursive: true, force: true });
        if (closed) return fail('unavailable');
        return 'protocol' in result ? fail('incompatible') : result;
      })().catch(() => fail('publication'));
      runs.add(task);
      void task.finally(() => runs.delete(task)).catch(() => {});
      return task;
    },
    close() {
      if (!closePromise) {
        closed = true;
        closePromise = (async () => {
          const owned = [...active];
          const drained = await Promise.allSettled(owned.map(child => child.stop()));
          await Promise.allSettled([...owned.map(child => child.done), ...runs]);
          if (drainFailed || drained.some(result => result.status === 'rejected')) throw new Error('Refresh drainage failed');
        })();
      }
      return closePromise;
    } };
}
