// The customization worker. It runs inside the launcher on the launcher machine, for local and SSH sessions alike, and
// owns the connected repository's clone, every git write and every build. The host only relays: this worker long-polls
// `customization-worker-pull` and reports through `customization-worker-push`. It names no service.
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join, posix } from 'node:path';
import { committedReferenceKey, containedPath, customizationSettingsFile, EXTENSION_TOKEN_VARIABLE, isSiblingReference,
  parseCustomizationPackage, parseCustomizationSettings, repositoryLocation, serializeCustomizationSettings } from '@agentui/host/customization';
import { commitFailure, GitFailure, pushFailure, runGit, setReferenceEnabled } from './lib/customization-git.mjs';
import { openStore, StateInvalid, StoreBusy } from './lib/customization-store.mjs';

export const PUSH_INTERVAL_MS = 5_000;
const PULL_WAIT_SECONDS = 10;

class Outcome extends Error {
  constructor(cause) { super(cause); this.cause = cause; }
}
const fail = cause => { throw new Outcome(cause); };

/** A local location must be absolute: a relative path would resolve against whatever directory the launcher ran in. */
function validLocation(location) {
  try { repositoryLocation(location); } catch { return false; }
  if (location.includes('://')) return true;
  if (location.includes(':') && !location.startsWith('/')) return true;
  return isAbsolute(location);
}
const packagePath = (subdirectory, file) => subdirectory ? posix.join(subdirectory, file) : file;

/**
 * Starts the worker. `localSetupRoot` is the launcher machine's setup root, never a remote one; `target` says where the
 * host runs. Resolves once the worker has stopped after `signal` aborts: no child left, lock released.
 */
export function startCustomizationWorker({ origin, localSetupRoot, signal, target = { kind: 'local' }, registerChild = () => {},
  builds = null, environment = process.env, gitEnvironment = process.env, gitTimeoutMs, pushIntervalMs = PUSH_INTERVAL_MS, sessionId = randomUUID(), lockWaitMs,
  fetch: send = fetch }) {
  const store = openStore(localSetupRoot);
  const workerId = randomUUID();
  const unsent = [];
  let state = { connection: null, head: null, extensions: [], settings: null };
  const git = (args, cwd = store.paths.clone) => runGit(args, { cwd, signal, timeoutMs: gitTimeoutMs, env: gitEnvironment, registerChild });
  /** Runs git and returns its output; a nonzero exit records the output tail in git.log and fails with `cause`. */
  const checked = async (args, cause = 'git-failed', cwd) => {
    const { code, output } = await git(args, cwd);
    if (code !== 0) { await store.appendGitLog(output).catch(() => {}); fail(typeof cause === 'function' ? cause(output) : cause); }
    return output;
  };
  const presentTokens = () => Object.keys(environment).filter(name => EXTENSION_TOKEN_VARIABLE.test(name) && environment[name]?.trim()).sort().slice(0, 256);

  async function readCommitted(connection) {
    const head = (await checked(['rev-parse', 'HEAD'])).trim().split('\n').at(-1);
    const file = packagePath(connection.subdirectory, 'package.json');
    const shown = await git(['show', `HEAD:${file}`]);
    if (shown.code !== 0 || shown.stdout === null) fail('invalid-package');
    const listing = await git(['ls-tree', '-r', '-z', '--name-only', 'HEAD', '--', connection.subdirectory || '.']);
    if (listing.code !== 0 || listing.stdout === null) fail('invalid-package');
    const listed = listing.stdout;
    const prefix = connection.subdirectory ? `${connection.subdirectory}/` : '';
    const files = new Set(listed.split('\0').filter(path => path.startsWith(prefix)).map(path => path.slice(prefix.length)));
    let customization;
    try { customization = parseCustomizationPackage(JSON.parse(shown.stdout), files); } catch { fail('invalid-package'); }
    const references = customization?.extensions ?? [];
    const keys = references.map(committedReferenceKey);
    if (new Set(keys).size !== keys.length) fail('invalid-package');
    let settings = null;
    if (files.has(customizationSettingsFile)) {
      const text = await git(['show', `HEAD:${packagePath(connection.subdirectory, customizationSettingsFile)}`]);
      try { if (text.code !== 0 || text.stdout === null) throw new Error(); settings = parseCustomizationSettings(text.stdout); } catch { fail('invalid-settings'); }
    }
    const extensions = [];
    for (const [index, reference] of references.entries()) {
      let namespace = null;
      if (isSiblingReference(reference)) {
        const sibling = await git(['show', `HEAD:${packagePath(reference.subdirectory, 'package.json')}`]);
        try { const value = JSON.parse(sibling.stdout)?.agentui?.extension?.namespace; namespace = typeof value === 'string' && /^[a-z][a-z0-9-]{0,31}$/u.test(value) ? value : null; } catch { namespace = null; }
      }
      extensions.push({ key: keys[index], enabled: reference.enabled, namespace });
    }
    return { head, text: shown.stdout, references, extensions, settings };
  }
  async function refresh() {
    const connection = await store.readConnection();
    if (!connection || !existsSync(join(store.paths.clone, '.git'))) { state = { connection, head: null, extensions: [], settings: null }; return null; }
    const committed = await readCommitted(connection);
    state = { connection, head: committed.head, extensions: committed.extensions, settings: committed.settings };
    return committed;
  }
  async function sync(connection) {
    await checked(['fetch', '--no-tags', 'origin']);
    const merged = await git(['merge', '--ff-only', `origin/${connection.branch}`]);
    // Diverged only after a failed push: the clone belongs to the worker, so it follows the remote.
    if (merged.code !== 0) await checked(['reset', '--hard', `origin/${connection.branch}`]);
    return refresh();
  }
  async function resetToRemote(connection) {
    await git(['fetch', '--no-tags', 'origin']).catch(() => {});
    await git(['reset', '--hard', `origin/${connection.branch}`]).catch(() => {});
  }
  async function commitAndPush(connection, path, message) {
    await checked(['add', '--', path]);
    await checked(['commit', '-m', message[0], '-m', message[1]], commitFailure);
    const pushed = await git(['push', 'origin', `HEAD:refs/heads/${connection.branch}`]);
    if (pushed.code !== 0) {
      await store.appendGitLog(pushed.output).catch(() => {});
      await resetToRemote(connection);
      fail(pushFailure(pushed.output));
    }
  }
  async function connected() {
    const connection = await store.readConnection();
    if (!connection) fail('invalid-request');
    return connection;
  }

  const handlers = {
    async connect({ location, branch, subdirectory }) {
      await store.readConnection();
      if (!validLocation(location)) fail('invalid-location');
      if ((await git(['check-ref-format', '--branch', branch], localSetupRoot)).code !== 0) fail('invalid-location');
      try { if (subdirectory) containedPath(subdirectory); } catch { fail('invalid-location'); }
      await rm(store.paths.clone, { recursive: true, force: true });
      const connection = { location, branch, subdirectory };
      try {
        await checked(['clone', '--quiet', '--no-tags', '--branch', branch, '--single-branch', '--', location, store.paths.clone], 'clone-failed', store.paths.root);
        await store.writeConnection(connection);
        const committed = await refresh();
        builds?.start({ connection, head: committed.head });
      } catch (error) {
        await store.writeConnection(null);
        await rm(store.paths.clone, { recursive: true, force: true });
        state = { connection: null, head: null, extensions: [], settings: null };
        throw error;
      }
    },
    async disconnect() {
      await store.readConnection();
      await store.writeConnection(null);
      await rm(store.paths.clone, { recursive: true, force: true });
      state = { connection: null, head: null, extensions: [], settings: null };
    },
    async sync() {
      const connection = await connected();
      const before = state.head;
      const committed = await sync(connection);
      if (committed.head !== before) builds?.start({ connection, head: committed.head });
    },
    async rebuild() {
      const connection = await connected();
      await refresh();
      builds?.start({ connection, head: state.head, force: true });
    },
    async toggle({ key, enabled, expectedHead }) {
      const connection = await connected();
      const committed = await sync(connection);
      if (committed.head !== expectedHead) fail('conflict');
      const index = committed.extensions.findIndex(item => item.key === key);
      if (index < 0) fail('unknown-extension');
      const edit = setReferenceEnabled(committed.text, index, enabled);
      if (edit.kind === 'unchanged') fail('unchanged');
      if (edit.kind !== 'changed') fail('unsupported-format');
      const path = packagePath(connection.subdirectory, 'package.json');
      await writeFile(join(store.paths.clone, path), edit.text);
      try { await commitAndPush(connection, path, [`${enabled ? 'Enable' : 'Disable'} ${key} extension`, 'Changed by AgentUI.']); }
      catch (error) { await resetToRemote(connection); throw error; }
      const after = await refresh();
      builds?.start({ connection, head: after.head });
    },
    async settings({ settings, expectedHead }) {
      const connection = await connected();
      const committed = await sync(connection);
      if (committed.head !== expectedHead) fail('conflict');
      let text;
      try { text = serializeCustomizationSettings(settings); } catch { fail('invalid-settings'); }
      const path = packagePath(connection.subdirectory, customizationSettingsFile);
      const current = await git(['show', `HEAD:${path}`]);
      if (current.code === 0 && current.stdout === text) fail('unchanged');
      await writeFile(join(store.paths.clone, path), text);
      try { await commitAndPush(connection, path, ['Update AgentUI settings', 'Changed by AgentUI.']); }
      catch (error) { await resetToRemote(connection); throw error; }
      // Settings are not a build input, so no build starts.
      await refresh();
    },
  };

  async function handle(request) {
    const handler = handlers[request.op];
    if (!handler) return 'not-ready';
    let release;
    try { release = await store.lock({ sessionId, signal, ...(lockWaitMs === undefined ? {} : { waitMs: lockWaitMs }) }); }
    catch (error) { return error instanceof StoreBusy ? 'busy' : 'state-invalid'; }
    try {
      await handler(request);
      return 'ok';
    } catch (error) {
      if (error instanceof Outcome) return error.cause === 'invalid-request' ? 'state-invalid' : error.cause;
      if (error instanceof StateInvalid) return 'state-invalid';
      if (error instanceof GitFailure) return error.cause === 'git-timeout' ? 'git-timeout' : 'git-failed';
      return 'git-failed';
    } finally {
      await release();
    }
  }

  async function call(op, body) {
    const response = await send(`${origin}/api/v1/worker`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ op, workerId, ...body }), signal });
    const reply = await response.json();
    if (!reply?.ok) throw new Error('The host refused the worker request.');
    return reply.value;
  }
  const status = () => ({ connection: state.connection, head: state.head, extensions: state.extensions, settings: state.settings,
    build: builds?.status() ?? null, presentTokens: presentTokens() });
  async function push() {
    const results = unsent.slice(0, 32);
    await call('customization-worker-push', { status: status(), results });
    unsent.splice(0, results.length);
  }
  const pause = ms => new Promise(resolve => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
  });

  async function heartbeat() {
    while (!signal.aborted) {
      await push().catch(() => {});
      await pause(pushIntervalMs);
    }
  }
  async function requests() {
    while (!signal.aborted) {
      try {
        const { requests: queued } = await call('customization-worker-pull', { waitSeconds: PULL_WAIT_SECONDS });
        for (const request of queued) {
          if (signal.aborted) break;
          unsent.push({ requestId: request.requestId, outcome: await handle(request) });
          await push().catch(() => {});
        }
      } catch {
        await pause(1_000);
      }
    }
  }
  const stopped = (async () => {
    await refresh().catch(() => {});
    void target;
    await Promise.all([heartbeat(), requests()]);
  })();
  return { workerId, stopped, store };
}
