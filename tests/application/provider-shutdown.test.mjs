import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ownDirectory } from '../../apps/host/build/tsc/ownership.js';

const root = new URL('../../', import.meta.url);
const childSource = `
  import assert from 'node:assert/strict';
  import { existsSync } from 'node:fs';
  import { registerHooks } from 'node:module';
  import { join } from 'node:path';
  import { fileURLToPath, pathToFileURL } from 'node:url';
  const [mode, directory] = process.argv.slice(1);
  const root = pathToFileURL(process.cwd() + '/');
  const artifact = new URL('apps/host/build/tsc/artifact.js', root).href;
  const hostPackage = import.meta.resolve('@agentui/host');
  const piPackage = import.meta.resolve('@agentui/host/pi');
  const sourceModule = source => ({ url: 'data:text/javascript,' + encodeURIComponent(source), shortCircuit: true });
  registerHooks({ resolve(specifier, context, nextResolve) {
    if (specifier === './artifact.js' && context.parentURL?.endsWith('/server.js')) {
      return sourceModule(
        'export * from ' + JSON.stringify(artifact) + ';' +
        'import { readInstalledArtifact as read } from ' + JSON.stringify(artifact) + ';' +
        'export function readInstalledArtifact() { return read(' +
        JSON.stringify(fileURLToPath(new URL('apps/host/dist/', root))) + '); }'
      );
    }
    if (specifier === '@agentui/host' && context.parentURL?.endsWith('/server.js')) {
      return sourceModule(
        'export * from ' + JSON.stringify(hostPackage) + ';' +
        'import { openLocalHost as open } from ' + JSON.stringify(hostPackage) + ';' +
        'export function openLocalHost(options) {' +
        '  const host = open(options); globalThis.shutdownTestHost = host;' +
        '  return { ...host, get drained() {' +
        '    return host.drained.then(() => {' +
        '      if (globalThis.shutdownTestDrainFailure) throw new Error("injected drain failure");' +
        '    });' +
        '  } };' +
        '}'
      );
    }
    if (specifier === '@agentui/host/pi' && context.parentURL?.endsWith('/server.js')) {
      return sourceModule(
        'import { createPiDriver as create } from ' + JSON.stringify(piPackage) + ';' +
        'export async function createPiDriver(options) {' +
        '  const driver = await create(options);' +
        '  return { ...driver, async close() {' +
        '    if (globalThis.shutdownTestDriverFailure) throw new Error("private native failure");' +
        '    await driver.close();' +
        '  } };' +
        '}'
      );
    }
    return nextResolve(specifier, context);
  } });
  async function main() {
    const { startBrowserHost } = await import(new URL('apps/host/build/tsc/server.js', root));
    const { ownDirectory } = await import(new URL('apps/host/build/tsc/ownership.js', root));
    const options = { directory, port: 0,
      assetsDirectory: fileURLToPath(new URL('apps/desktop/web-dist-browser/', root)),
      agentStartup: mode === 'recorded' ? { kind: 'recorded' } : { kind: 'provider', provider: { kind: 'pi', cwd: process.cwd() } } };
    if (mode === 'startup') {
      await assert.rejects(startBrowserHost({ ...options, agentStartup: { kind: 'provider', provider: { kind: 'pi', cwd: join(directory, 'missing') } } }), /existing directory/);
    } else {
      const running = await startBrowserHost(options);
      globalThis.shutdownTestDriverFailure = mode === 'driver';
      globalThis.shutdownTestDrainFailure = mode === 'drain';
      if (mode === 'access') {
        const { Access } = await import(new URL('apps/host/build/tsc/access.js', root));
        Access.prototype.close = () => { throw new Error('injected access close failure'); };
      }
      const closing = running.close();
      assert.equal(running.close(), closing, 'shutdown must retain its original result');
      if (mode === 'driver' || mode === 'drain' || mode === 'access') {
        await assert.rejects(closing, mode === 'access' ? /injected access close failure/ : /^Error: Host shutdown failed$/);
        assert.throws(() => ownDirectory(directory), /Another host owns this data directory/);
        if (mode === 'driver') {
          assert.deepEqual(globalThis.shutdownTestHost.listConversations(running.hostId, null, 100), [],
            'failed native cleanup must leave host storage usable by late native callbacks');
        }
      } else {
        await closing;
      }
      assert.equal(existsSync(join(directory, 'control.sock')), false);
      await assert.rejects(fetch(running.origin, { signal: AbortSignal.timeout(1000) }), /fetch failed/);
    }
    if (mode === 'normal' || mode === 'recorded' || mode === 'startup') ownDirectory(directory).close();
  }
  main().then(() => process.exit(0), error => { console.error(error); process.exit(1); });
`;

for (const [mode, description] of [
  ['driver', 'native cleanup failure keeps ownership and host storage while closing listeners'],
  ['drain', 'host drain failure keeps ownership while closing listeners'],
  ['access', 'access database close failure rejects and keeps ownership'],
  ['normal', 'successful provider shutdown releases ownership'],
  ['recorded', 'successful recorded shutdown releases ownership'],
  ['startup', 'ordinary startup failure releases ownership'],
]) {
  test(description, { timeout: 15_000 }, async t => {
    const directory = mkdtempSync(join(tmpdir(), 'aui-close-'));
    const child = spawn(process.execPath, ['--input-type=module', '-e', childSource, mode, directory], {
      cwd: root, env: { ...process.env, OPENCODE_GO_API_KEY: 'unused-shutdown-test-key' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.setEncoding('utf8').on('data', value => { output += value; });
    child.stderr.setEncoding('utf8').on('data', value => { output += value; });
    const exited = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => resolve({ code, signal }));
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), 12_000);
    t.after(async () => {
      clearTimeout(timer);
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await exited;
      rmSync(directory, { recursive: true, force: true });
    });
    assert.deepEqual(await exited, { code: 0, signal: null }, output);
    ownDirectory(directory).close();
  });
}
