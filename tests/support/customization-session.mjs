import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const clean = () => Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_') && !key.startsWith('AGENTUI_EXTENSION_') &&
  !['EMAIL', 'HOME'].includes(key)));

/**
 * A temporary git world under `directory`: an empty HOME with its own git identity, and a local bare remote whose
 * `customization` branch holds `files`. No real remote and no real git configuration is touched.
 */
export async function seedRemote(directory, files) {
  const home = join(directory, 'home');
  await mkdir(home, { recursive: true });
  const gitconfig = join(home, '.gitconfig');
  await writeFile(gitconfig, '[user]\n\tname = Session Test\n\temail = session@example.invalid\n[commit]\n\tgpgsign = false\n[init]\n\tdefaultBranch = main\n');
  const gitEnvironment = { ...clean(), HOME: home, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: gitconfig };
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: gitEnvironment, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const remote = join(directory, 'remote.git');
  git(directory, 'init', '--quiet', '--bare', remote);
  const seed = join(directory, 'seed');
  await mkdir(seed);
  git(seed, 'init', '--quiet', '-b', 'customization');
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(seed, path)), { recursive: true });
    await writeFile(join(seed, path), text);
  }
  git(seed, 'add', '-A');
  git(seed, 'commit', '--quiet', '-m', 'Seed');
  git(seed, 'push', '--quiet', remote, 'customization');
  return { home, gitconfig, gitEnvironment, git, remote, seed };
}

/**
 * A host started by the real session wrapper the way the launcher starts it (`desktop`, Pi preferred), with a real worker
 * in this process, a local bare remote holding `files`, real builds and a temporary HOME. Every directory is temporary.
 */
export async function startSession(t, { files, tokens = { AGENTUI_EXTENSION_ALPHA_TOKEN: 'alpha-test-token', AGENTUI_EXTENSION_BETA_TOKEN: 'beta-test-token' },
  hostTokens = tokens } = {}) {
  const { spawn } = await import('node:child_process');
  const { randomBytes, randomUUID } = await import('node:crypto');
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { createServer } = await import('node:net');
  const { tmpdir } = await import('node:os');
  const { fileURLToPath } = await import('node:url');
  const { startCustomizationWorker } = await import('../../scripts/agentui-customization-worker.mjs');
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const directory = await mkdtemp(join(tmpdir(), 'agentui-session-'));
  // One cleanup in a fixed order: the worker, then the wrapper and its host, then the directory they write into.
  let stopSession = async () => {};
  t.after(async () => { await stopSession(); await rm(directory, { recursive: true, force: true }); });
  const { remote, git, gitEnvironment, home, seed } = await seedRemote(directory, files);
  const data = join(directory, 'data');
  await mkdir(data, { mode: 0o700 });
  const workspace = join(directory, 'workspace');
  await mkdir(workspace);
  const port = await new Promise(resolve => { const server = createServer().listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolve(port)); }); });
  const origin = `http://127.0.0.1:${port}`;
  const environment = { ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('AGENTUI_EXTENSION_'))), HOME: home };
  const wrapper = spawn(process.execPath, [join(root, 'scripts/agentui-launch-session.mjs'), process.execPath, join(root, 'apps/host/dist/main.js'), 'desktop',
    '--preferred', 'pi', '--workspace', workspace, '--data-dir', data, '--assets', join(root, 'apps/desktop/web-dist-browser'), '--port', String(port)],
    { cwd: root, env: environment, stdio: ['pipe', 'pipe', 'pipe'] });
  let output = '', errors = '';
  wrapper.stdout.on('data', chunk => { output += chunk; });
  wrapper.stderr.on('data', chunk => { errors += chunk; });
  const closed = new Promise(resolve => wrapper.once('close', resolve));
  wrapper.stdin.write(`${JSON.stringify({ OPENCODE_GO_API_KEY: null, AGENTUI_SETUP_CAPABILITY: randomBytes(32).toString('hex'), extensionVariables: hostTokens })}\n`);
  const until = async (predicate, label, timeout = 300_000) => {
    const deadline = Date.now() + timeout;
    for (;;) {
      const value = await predicate();
      if (value) return value;
      if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  };
  let worker = null;
  const startWorker = () => {
    const controller = new AbortController();
    const running = startCustomizationWorker({ origin, localSetupRoot: join(directory, 'setup'), repositoryRoot: root, signal: controller.signal, gitEnvironment,
      environment: tokens, pushIntervalMs: 500, profileId: 'browser-test' });
    worker = { stop: async () => { controller.abort(); await running.stopped; worker = null; } };
  };
  stopSession = async () => { await worker?.stop(); wrapper.stdin.end(); await closed; };
  await until(() => output.includes('"hostId"'), 'host ready', 30_000).catch(error => { throw new Error(`${error.message}\n${errors}`); });
  startWorker();
  const call = async body => {
    const response = await fetch(`${origin}/api/v1`, { method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify(body) });
    const reply = await response.json();
    if (!reply.ok) throw new Error(reply.error.message);
    return reply.value;
  };
  const status = () => call({ op: 'customization-status' });
  const mutate = async (op, fields = {}) => {
    const requestId = randomUUID();
    const reply = await call({ op: `customization-${op}`, requestId, ...fields });
    if (reply.kind !== 'accepted') return { refused: reply.cause };
    return (await until(async () => (await status()).results.find(item => item.requestId === requestId), `${op} result`, 120_000)).outcome;
  };
  const agents = async () => (await call({ op: 'metadata' })).agents.map(agent => agent.label);
  const ready = (different = null) => until(async () => {
    const build = (await status()).build;
    if (build?.state === 'failed') throw new Error(`Build failed: ${JSON.stringify(build)}`);
    return build?.state === 'ready' && build.buildKey !== different ? build : null;
  }, 'a ready build');
  await until(async () => (await status()).support === 'supported', 'worker online', 30_000);
  return { directory, origin, data, remote, seed, git, gitEnvironment, call, status, mutate, agents, ready, until, startWorker,
    stopWorker: () => worker?.stop(), output: () => output, errors: () => errors };
}
