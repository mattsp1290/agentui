import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startBrowserHost } from '../host/extensions/fixtures.mjs';
import { startCustomizationWorker } from '../../scripts/agentui-customization-worker.mjs';

export const checkout = fileURLToPath(new URL('../../', import.meta.url));
const clean = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_') && !key.startsWith('AGENTUI_EXTENSION_') &&
  !['EMAIL', 'HOME'].includes(key)));

/** A temporary world: HOME, git configuration, a bare remote, the launcher setup root and a host in this process. */
export async function world(t, { files } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'agentui-worker-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  await mkdir(home);
  const gitconfig = join(home, '.gitconfig');
  await writeFile(gitconfig, '[user]\n\tname = Worker Test\n\temail = worker@example.invalid\n[commit]\n\tgpgsign = false\n[init]\n\tdefaultBranch = main\n');
  const gitEnvironment = { ...clean, HOME: home, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: gitconfig };
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: gitEnvironment, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const remote = join(root, 'remote.git');
  git(root, 'init', '--quiet', '--bare', remote);
  const seed = join(root, 'seed');
  await mkdir(seed);
  git(seed, 'init', '--quiet', '-b', 'customization');
  for (const [path, text] of Object.entries(files ?? await exampleFiles())) {
    await mkdir(dirname(join(seed, path)), { recursive: true });
    await writeFile(join(seed, path), text);
  }
  git(seed, 'add', '-A');
  git(seed, 'commit', '--quiet', '-m', 'Seed');
  git(seed, 'push', '--quiet', remote, 'customization');
  const setupRoot = join(root, 'setup');
  const assetsDirectory = join(checkout, 'apps/desktop/web-dist-browser');
  let host = await startBrowserHost({ agentStartup: { kind: 'recorded' }, directory: join(root, 'host'), port: 0, assetsDirectory, extensions: { kind: 'transient', entries: [] } });
  t.after(() => host.close());
  const call = async body => {
    const response = await fetch(`${host.origin}/api/v1`, { method: 'POST', headers: { 'content-type': 'application/json', origin: host.origin }, body: JSON.stringify(body) });
    const reply = await response.json();
    if (!reply.ok) throw new Error(reply.error.message);
    return reply.value;
  };
  const status = () => call({ op: 'customization-status' });
  const workers = [];
  const startWorker = (options = {}) => {
    const controller = new AbortController();
    const children = new Set();
    const worker = startCustomizationWorker({ origin: host.origin, localSetupRoot: setupRoot, signal: controller.signal, gitEnvironment, environment: {},
      pushIntervalMs: 500, registerChild: child => { children.add(child); child.once('close', () => children.delete(child)); }, ...options });
    const handle = { ...worker, children, stop: async () => { controller.abort(); await worker.stopped; } };
    workers.push(handle);
    return handle;
  };
  t.after(async () => { for (const worker of workers) await worker.stop(); });
  const until = async (predicate, label, timeout = 30_000) => {
    const deadline = Date.now() + timeout;
    for (;;) {
      const value = await predicate();
      if (value) return value;
      if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  };
  /** Queues one mutation and waits for its outcome. */
  const mutate = async (op, fields = {}, timeout = 60_000) => {
    const requestId = randomUUID();
    const reply = await call({ op: `customization-${op}`, requestId, ...fields });
    if (reply.kind !== 'accepted') return { refused: reply.cause };
    const result = await until(async () => (await status()).results.find(item => item.requestId === requestId), `${op} result`, timeout);
    return result.outcome;
  };
  const online = () => until(async () => (await status()).support === 'supported', 'worker online');
  return { root, home, gitconfig, gitEnvironment, git, remote, setupRoot, get host() { return host; }, call, status, startWorker, mutate, until, online,
    remoteLog: () => git(remote, 'log', '--format=%H %s', 'customization').split('\n'),
    remoteFile: path => git(remote, 'show', `customization:${path}`),
    restartHost: async () => { await host.close(); host = await startBrowserHost({ agentStartup: { kind: 'recorded' }, directory: join(root, 'host'), port: 0, assetsDirectory, extensions: { kind: 'transient', entries: [] } }); } };
}

/** The example customization's layout: the real example package and the two referenced packages' manifests. */
export async function exampleFiles() {
  const read = path => readFile(join(checkout, path), 'utf8');
  return {
    'examples/customization/package.json': await read('examples/customization/package.json'),
    'examples/customization/agentui-settings.json': await read('examples/customization/agentui-settings.json'),
    'extensions/crew/package.json': await read('extensions/crew/package.json'),
    'extensions/coworkers/package.json': await read('extensions/coworkers/package.json'),
  };
}
export const exampleConnection = remote => ({ location: remote, branch: 'customization', subdirectory: 'examples/customization' });
