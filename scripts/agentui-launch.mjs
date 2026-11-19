import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, existsSync, readFileSync, realpathSync } from 'node:fs';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootstrapScript, distribution, profileFor, shellQuote } from './agentui-runtime.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
/** The local setup root, matching `root="$HOME/.local/share/agentui"` in agentui-runtime.mjs. */
const LOCAL_SETUP_ROOT = join(homedir(), '.local/share/agentui');
const sshOptions = ['-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=2'];
const usage = `Usage: ./agentui [--ssh USER@HOST] [--workspace PATH] [--agent codex|pi] [--port PORT]
                 [--no-open] [--skip-build]
       ./agentui --host-url http://127.0.0.1:PORT/browser.html
       ./agentui setup --agent codex|pi|claude [--ssh USER@HOST]

Starts a trusted single-user host and opens the Mac client without pairing.
The SSH form installs the matching tools and host on the selected machine.
Keep this terminal running. Quit the app or press Ctrl+C to stop the session.
Local workspaces default to the current directory. SSH workspaces default to the remote home.
Pi uses bundled GLM 5.3 chat. Open Settings to connect OpenCode Go securely, or supply OPENCODE_GO_API_KEY.
--no-open starts the session without a window and prints a ready JSON record.
--skip-build uses existing built artifacts. --help prints this text without setup.
`;

export function parseLaunchArgs(args, cwd = process.cwd()) {
  const values = new Map();
  const flags = new Set();
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (['--help', '-h', '--no-open', '--skip-build'].includes(arg)) {
      if (flags.has(arg)) throw new Error(`Duplicate ${arg}. ${usage}`);
      flags.add(arg);
    } else if (['--ssh', '--workspace', '--port', '--agent', '--host-url'].includes(arg)) {
      const value = args[++index];
      if (!value || value.startsWith('--') || values.has(arg)) throw new Error(`Provide one value for ${arg}. ${usage}`);
      values.set(arg, value);
    } else throw new Error(`Unknown option ${arg}. ${usage}`);
  }
  if (flags.has('--help') || flags.has('-h')) return { kind: 'help' };
  const common = { open: !flags.has('--no-open'), build: !flags.has('--skip-build') };
  if (values.has('--host-url')) {
    if (values.size !== 1 || flags.size !== 0) throw new Error(`Use --host-url by itself. ${usage}`);
    const text = values.get('--host-url');
    let url;
    try { url = new URL(text); } catch { throw new Error(`Invalid --host-url. ${usage}`); }
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password ||
        url.pathname !== '/browser.html' || text.includes('?') || text.includes('#')) throw new Error(`The desktop host must use http://127.0.0.1:PORT/browser.html. ${usage}`);
    return { kind: 'existing', url: text, ...common };
  }
  const agent = values.get('--agent') ?? 'codex';
  if (!['codex', 'pi'].includes(agent)) throw new Error(`Use --agent codex or --agent pi. ${usage}`);
  const port = values.has('--port') ? Number(values.get('--port')) : null;
  if (port !== null && (!Number.isInteger(port) || port < 1024 || port > 65535)) throw new Error(`Use a --port between 1024 and 65535. ${usage}`);
  const destination = values.get('--ssh');
  if (destination && (!/^[A-Za-z0-9_][A-Za-z0-9_.@:-]*$/.test(destination) || destination.includes('..'))) throw new Error(`Use --ssh USER@HOST or an SSH config alias. ${usage}`);
  const workspace = values.get('--workspace');
  if (workspace?.includes('\0') || workspace?.includes('\n')) throw new Error(`Workspace paths cannot contain NUL or newline. ${usage}`);
  return destination
    ? { kind: 'ssh', destination, workspace: workspace ?? null, agent, port, ...common }
    : { kind: 'local', workspace: resolve(cwd, workspace ?? '.'), agent, port, ...common };
}

/** Names of the environment variables an extension configuration reads its tokens from. */
function tokenVariables(configuration) {
  const names = new Set();
  for (const extension of Array.isArray(configuration?.extensions) ? configuration.extensions : []) {
    for (const installation of Array.isArray(extension?.installations) ? extension.installations : []) {
      if (installation?.authentication?.kind === 'environment' && typeof installation.authentication.variable === 'string') names.add(installation.authentication.variable);
    }
  }
  return [...names].sort();
}
/**
 * Whether the launcher can hand this configuration to the host. The host refuses to start on an invalid file, so the
 * launcher checks the parts that go stale: the version and each selected directory. The host still validates the rest.
 */
function loadableConfiguration(configuration, base) {
  if (configuration?.version !== 2 || !Array.isArray(configuration.extensions)) return false;
  return configuration.extensions.every(extension => {
    if (typeof extension?.directory !== 'string' || !extension.directory) return false;
    const directory = resolve(base, extension.directory);
    return existsSync(extension.kind === 'artifact' ? directory : join(directory, 'package.json'));
  });
}
/**
 * Host arguments for `<setup root>/extensions.json`. A local profile passes `--extensions` only when the file names
 * version 2 and existing extension directories and every named token variable is set. Otherwise it prints one warning
 * (naming every missing variable, never a value) and starts with native agents only.
 * A remote profile never loads bundled server extensions (decision D13).
 */
export function extensionArguments({ setupRoot, kind, env = process.env, warn = line => process.stderr.write(`${line}\n`) }) {
  const file = join(setupRoot, 'extensions.json');
  if (kind === 'ssh') {
    if (existsSync(file)) warn('Server extensions run only with a local host. Ignoring extensions.json for this remote session.');
    return [];
  }
  if (!existsSync(file)) return [];
  let configuration;
  try { configuration = JSON.parse(readFileSync(file, 'utf8')); }
  catch { warn('extensions.json is not valid JSON. Starting without server extensions.'); return []; }
  if (!loadableConfiguration(configuration, setupRoot)) {
    warn('extensions.json is not a usable extension configuration (version 2 with existing extension directories). Starting without server extensions.');
    return [];
  }
  const missing = tokenVariables(configuration).filter(name => !env[name]?.trim());
  if (missing.length) warn(`Set ${missing.join(', ')} to load server extensions. Starting without server extensions.`);
  return missing.length ? [] : ['--extensions', file];
}

export async function assertPortAvailable(port) {
  const server = createServer();
  await new Promise((done, reject) => {
    server.once('error', () => reject(new Error(`Local port ${port} is in use. Close that session or select another --port.`)));
    server.listen(port, '127.0.0.1', done);
  });
  await new Promise((done, reject) => server.close(error => error ? reject(error) : done()));
}

function command(file, args, options = {}) {
  options.checkRunning?.();
  const child = spawn(file, args, { cwd: root, env: process.env, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'], ...options });
  let output = '';
  let errors = '';
  child.stdout?.on('data', data => { output = (output + data).slice(-1_000_000); if (options.echo) process.stdout.write(data); });
  child.stderr?.on('data', data => { errors = (errors + data).slice(-20_000); process.stderr.write(data); });
  child.stdin?.on('error', () => {});
  const exited = new Promise((done, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => code === 0 ? done(output) : reject(Object.assign(new Error(`${file} ${signal ? `ended with ${signal}` : `exited with ${code}`}${errors ? `\n${errors.trim()}` : ''}`), { exitCode: code ?? 1 })));
  });
  // Session children may exit while setup is still being checked.
  void exited.catch(() => {});
  const task = { child, exited, lease: options.lease ?? false, output: () => output };
  options.children?.add(task);
  void exited.finally(() => options.children?.delete(task)).catch(() => {});
  return task;
}

function terminate(task, signal) {
  if (!task.child.pid) return;
  try {
    if (process.platform === 'win32') task.child.kill(signal);
    else process.kill(-task.child.pid, signal);
  } catch (error) { if (error.code !== 'ESRCH') throw error; }
}

async function run(file, args, options = {}, input = '') {
  const process = command(file, args, options);
  process.child.stdin?.end(input);
  return process.exited;
}

function checkArtifacts(host, browser, nodeVersion) {
  if (host.platform !== 'host' || host.artifactRuntime?.engine !== 'node' || host.artifactRuntime.version !== nodeVersion ||
      browser.platform !== 'browser-development' || !/^[a-f0-9]{64}$/.test(host.artifactId) || !/^[a-f0-9]{64}$/.test(browser.artifactId)) {
    throw new Error('Built host or browser artifacts do not match the pinned runtime. Run ./agentui without --skip-build.');
  }
}

function sessionArguments(setup, directory, workspace, dataDir, agent, port) {
  return [setup.node, join(directory, 'host', 'main.js'), 'desktop', '--preferred', agent, '--workspace', workspace,
    '--data-dir', dataDir, '--assets', join(directory, 'browser'), '--port', String(port),
    ...(agent === 'codex' ? ['--executable', setup.codex] : [])];
}

export async function createReleaseArchive(directory, archive, lifecycle = {}) {
  const metadata = process.platform === 'darwin' ? ['--no-xattrs'] : [];
  await run('tar', [...metadata, '-czf', archive, '-C', directory, '.'],
    { ...lifecycle, env: { ...process.env, COPYFILE_DISABLE: '1' } });
}

async function deploy(destination, setup, releaseId, lifecycle) {
  const release = join(setup.root, 'releases', releaseId);
  const staging = await mkdtemp(join(tmpdir(), 'agentui-release-'));
  try {
    await cp(join(root, 'apps/host/dist'), join(staging, 'host'), { recursive: true });
    await cp(join(root, 'apps/desktop/web-dist-browser'), join(staging, 'browser'), { recursive: true });
    await cp(join(root, 'scripts/agentui-launch-session.mjs'), join(staging, 'session.mjs'));
    await writeFile(join(staging, 'package.json'), '{"type":"module"}\n');
    const archive = `${staging}.tar.gz`;
    try {
      await createReleaseArchive(staging, archive, lifecycle);
      const script = `set -eu; umask 077; release=${shellQuote(release)}; if [ -f "$release/package.json" ]; then cat >/dev/null; else work=$(mktemp -d ${shellQuote(join(setup.root, 'releases', '.upload-XXXXXX'))}); trap 'rm -rf "$work"' EXIT HUP INT TERM; tar -xzf - -C "$work"; mv "$work" "$release"; fi`;
      const transfer = command('ssh', [...sshOptions, destination, `sh -c ${shellQuote(script)}`], lifecycle);
      const source = createReadStream(archive);
      source.once('error', () => transfer.child.stdin.destroy());
      source.pipe(transfer.child.stdin);
      await transfer.exited;
    } finally { await rm(archive, { force: true }); }
  } finally { await rm(staging, { recursive: true, force: true }); }
  return release;
}

async function waitForHost(session, origin, artifactId) {
  let done = false;
  let failure;
  session.exited.then(() => { done = true; }, error => { done = true; failure = error; });
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (done) throw failure ?? new Error('The host stopped before becoming ready.');
    const lines = session.output().split('\n');
    const announced = lines.some(line => {
      try { const value = JSON.parse(line); return value.origin === origin && value.hostId; } catch { return false; }
    });
    if (announced) {
      try {
        const response = await fetch(`${origin}/api/v1`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ op: 'metadata' }), signal: AbortSignal.timeout(2000) });
        const metadata = await response.json();
        if (response.ok && metadata.ok && metadata.value?.compatibility?.appliedArtifact?.artifactId === artifactId) return;
        throw new Error('The host did not accept trusted access or is serving another artifact.');
      } catch (error) {
        if (error.message.includes('trusted access')) throw error;
      }
    }
    await new Promise(done => setTimeout(done, 100));
  }
  throw new Error('Timed out waiting for the AgentUI host. Check the setup output above.');
}

export async function launch(options) {
  if (options.kind === 'help') { process.stdout.write(usage); return; }
  if (process.platform !== 'darwin' && options.open) throw new Error('The AgentUI desktop client requires macOS. Use --no-open to run without a window.');
  const children = new Set();
  let stopping;
  const checkRunning = () => { if (stopping) throw new Error('AgentUI startup cancelled.'); };
  const lifecycle = { children, checkRunning };
  async function stop() {
    stopping ??= (async () => {
      await Promise.allSettled([...children].map(async session => {
        if (session.lease) session.child.stdin?.end();
        else terminate(session, 'SIGTERM');
        const deadline = setTimeout(() => terminate(session, 'SIGTERM'), 17_000);
        const kill = setTimeout(() => terminate(session, 'SIGKILL'), 20_000);
        try { await session.exited; } finally { clearTimeout(deadline); clearTimeout(kill); }
      }));
    })();
    return stopping;
  }
  const interrupt = () => { void stop(); };
  const interruptionSignals = ['SIGINT', 'SIGTERM', 'SIGHUP'];
  for (const signal of interruptionSignals) process.on(signal, interrupt);
  try {
    const nodeVersion = (await readFile(join(root, '.node-version'), 'utf8')).trim();
    if (options.build) {
      const { packageManager } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
      const build = command('npm', ['exec', '--yes', `--package=node@${nodeVersion}`, `--package=${packageManager}`, '--call', 'npm ci && npm run build && npm run desktop:bundle'],
        { ...lifecycle, echo: true, env: { ...process.env, PATH: `/usr/bin:/bin:/usr/sbin:/sbin:${process.env.PATH}`, CARGO_TARGET_DIR: join(root, 'apps/desktop/src-tauri/target') } });
      await build.exited;
    }
    checkRunning();
    const open = async (url, setupEnvironment = {}) => {
      checkRunning();
      const app = command(join(root, 'apps/desktop/src-tauri/target/release/bundle/macos/AgentUI.app/Contents/MacOS/agentui-desktop'), ['--host-url', url],
        { ...lifecycle, env: { ...process.env, ...setupEnvironment } });
      await app.exited;
    };
    if (options.kind === 'existing') { await open(options.url); return; }
    const [host, browser] = await Promise.all(['apps/host/dist/artifact.json', 'apps/desktop/web-dist-browser/artifact.json'].map(async path => JSON.parse(await readFile(join(root, path), 'utf8'))));
    checkArtifacts(host, browser, nodeVersion);
    const { CODEX_RUNTIME } = await import('@agentui/contracts/compatibility');
    const setupScript = bootstrapScript(nodeVersion, options.agent, CODEX_RUNTIME.version);
    const setupOutput = options.kind === 'ssh'
      ? await run('ssh', [...sshOptions, options.destination, 'sh -s'], lifecycle, setupScript)
      : await run('/bin/sh', ['-s'], lifecycle, setupScript);
    checkRunning();
    const setupLine = setupOutput.split('\n').findLast(line => line.startsWith('AGENTUI_SETUP '));
    if (!setupLine) throw new Error('Server setup did not return its runtime information.');
    const setup = JSON.parse(setupLine.slice('AGENTUI_SETUP '.length));
    const platform = distribution(setup.os, setup.arch);
    const target = options.kind === 'ssh' ? options.destination : 'local';
    const workspace = options.kind === 'ssh'
      ? options.workspace === null ? setup.home : options.workspace === '~' ? setup.home : options.workspace.startsWith('~/') ? join(setup.home, options.workspace.slice(2)) : options.workspace.startsWith('/') ? options.workspace : join(setup.home, options.workspace)
      : options.workspace;
    const profile = profileFor(target, workspace, options.agent);
    const port = options.port ?? profile.port;
    await assertPortAvailable(port);
    checkRunning();
    const dataDir = join(setup.root, 'data', profile.id);
    const setupCapability = randomBytes(32).toString('hex');
    const origin = `http://127.0.0.1:${port}`;
    let session;
    if (options.kind === 'ssh') {
      // A remote host never loads server extensions; this only warns when a local extensions.json would be ignored.
      void extensionArguments({ setupRoot: LOCAL_SETUP_ROOT, kind: 'ssh' });
      const deploymentHash = createHash('sha256').update(await readFile(join(root, 'scripts/agentui-launch-session.mjs')))
        .update('\0').update(await readFile(fileURLToPath(import.meta.url))).digest('hex').slice(0, 12);
      const release = await deploy(options.destination, setup, `${host.artifactId.slice(0, 16)}-${browser.artifactId.slice(0, 16)}-${deploymentHash}`, lifecycle);
      checkRunning();
      const args = [setup.node, join(release, 'session.mjs'), ...sessionArguments(setup, release, workspace, dataDir, options.agent, port)];
      const script = `export PATH=${shellQuote(`${dirname(setup.node)}:`)}"$PATH"; exec ${args.map(shellQuote).join(' ')}`;
      session = command('ssh', [...sshOptions, '-o', 'ExitOnForwardFailure=yes', '-L', `${port}:127.0.0.1:${port}`, options.destination, script], { ...lifecycle, lease: true });
    } else {
      const args = [setup.node, join(root, 'apps/host/dist/main.js'), 'desktop', '--preferred', options.agent, '--workspace', workspace,
        '--data-dir', dataDir, '--assets', join(root, 'apps/desktop/web-dist-browser'), '--port', String(port),
        ...(options.agent === 'codex' ? ['--executable', setup.codex] : []), ...extensionArguments({ setupRoot: setup.root, kind: 'local' })];
      session = command(setup.node, [join(root, 'scripts/agentui-launch-session.mjs'), ...args],
        { ...lifecycle, lease: true, env: { ...process.env, PATH: `${dirname(setup.node)}:${process.env.PATH}` } });
    }
    session.child.stdin.write(`${JSON.stringify({ OPENCODE_GO_API_KEY: process.env.OPENCODE_GO_API_KEY ?? null, AGENTUI_SETUP_CAPABILITY: setupCapability })}\n`);
    await waitForHost(session, origin, host.artifactId);
    checkRunning();
    process.stdout.write(`${JSON.stringify({ event: 'ready', url: `${origin}/browser.html`, target, workspace, dataDir, port, agent: options.agent, platform })}\n`);
    process.stderr.write(`AgentUI is ready. ${target} runs ${options.agent} in ${workspace}. Keep this terminal running.\n`);
    if (options.open) await Promise.race([open(`${origin}/browser.html`, { AGENTUI_SETUP_CAPABILITY: setupCapability, AGENTUI_SETUP_PROFILE: profile.id, AGENTUI_SETUP_TARGET: `${target} · ${workspace}` }), session.exited.then(() => { if (!stopping) throw new Error('AgentUI host stopped.'); })]);
    else await session.exited;
  } finally {
    await stop();
    for (const signal of interruptionSignals) process.off(signal, interrupt);
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await launch(parseLaunchArgs(process.argv.slice(2))); }
  catch (error) {
    process.stderr.write(`Cannot connect to AgentUI host: ${error.message}\n`);
    process.exitCode = error.exitCode ?? 1;
  }
}
