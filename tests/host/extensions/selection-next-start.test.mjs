import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { readFile, writeFile, rm, cp } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import { createBrowserConnection } from '@agentui/client/service';
import { setup, extension, write } from '../../customization/build/server-support.mjs';
import { packagedHost } from './artifact-support.mjs';
import { requestControl } from '../../../apps/host/build/tsc/control.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const main = join(root, 'apps/host/dist/main.js');
const secret = 'PRIVATE_SELECTION_NEXT_START_SECRET';
const instance = { namespace: 'example-crew', installationId: 'personal', generation: 'stable', protocolVersion: 'crew-v2' };
const grant = { id: 'service', instance, service: 'http://127.0.0.1:12345', expectedAuthority: 'remote-provider',
  authentication: { kind: 'environment', variable: 'AGENTUI_EXTENSION_SELECTION_TOKEN', revision: 'first' } };
const execute = promisify(execFile);
async function fixture(t) {
  const f = await setup(t);
  const marker = join(f.root, 'imports'), pause = join(f.root, 'pause');
  const source = label => `import { EXTENSION_SDK_VERSION } from '@agentui/sdk';
    import { appendFileSync, existsSync } from 'node:fs';
    import { createCrewFixture } from './crew.ts';
    const instance=${JSON.stringify(instance)}, fixture=createCrewFixture(instance);
    appendFileSync(${JSON.stringify(marker)},${JSON.stringify(label + '\n')});
    export default {kind:'server',sdkVersion:EXTENSION_SDK_VERSION,async activate(context){
      if(existsSync(${JSON.stringify(pause)})) await new Promise(()=>{setInterval(()=>{},1000)});
      context.providers.add('service',{...fixture.crew, async connect(request){
        return {kind:'connected',backend:{...fixture.crewBackend,async discover(){
          return context.credentials.use({credential:request.credential,service:'http://127.0.0.1:12345'},async token=>{
            if(token!==${JSON.stringify(secret)}) throw new Error('bad credential');
            return {kind:'available',agents:[{ref:{instance,kind:'agent',opaqueId:'agent'},name:${JSON.stringify(label)}}]};
          });
        }}};
      }},fixture.crewPresentation);
      return {dispose(){}};
    }};`;
  await write(f.repo.directory, 'package.json', { type: 'module', agentui: extension('example-crew') });
  await write(f.repo.directory, 'crew.ts', await readFile(new URL('../../extensions/providers/contracts/crew.ts', import.meta.url), 'utf8'));
  await Promise.all(Array.from({ length: 180 }, (_, i) => write(f.repo.directory, `inventory/file-${i}.ts`, `export const value=${i};`)));
  await write(f.repo.directory, 'index.ts', source('A'));
  const a = await f.build();
  await write(f.repo.directory, 'index.ts', source('B'));
  const b = await f.build(f.repo.commit(), 'artifact-雪');
  await writeFile(marker, '');
  const directory = join(f.root, 'host'), config = join(f.root, 'extensions.json');
  const pin = value => ({ directory: value.directory, artifactId: value.manifest.artifactId });
  const configuration = { version: 2, ownership: 'durable-artifacts', extensions: [{ kind: 'artifact', ...pin(a), installations: [grant] }] };
  await writeFile(config, JSON.stringify(configuration));
  const environment = { ...process.env, AGENTUI_EXTENSION_SELECTION_TOKEN: secret };
  const args = ['serve', '--data-dir', directory, '--extensions', config, '--assets', join(root, 'apps/desktop/web-dist-browser'), '--port', '0', '--trusted'];
  const children = new Set();
  t.after(async () => { for (const child of children) { child.kill('SIGKILL'); await once(child, 'exit').catch(() => {}); } });
  function launch(env = environment) {
    const child = spawn(process.execPath, [main, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    children.add(child);
    let stdout = '', stderr = '';
    const exited = once(child, 'exit').then(([code, signal]) => { children.delete(child); return { code, signal, stdout, stderr }; });
    child.stderr.on('data', bytes => { stderr += bytes; });
    const ready = new Promise((resolve, reject) => {
      child.stdout.on('data', bytes => { stdout += bytes; if (stdout.includes('\n')) resolve(JSON.parse(stdout.trim())); });
      exited.then(result => reject(new Error(result.stderr || 'Host exited before ready')));
    });
    ready.catch(() => {});
    return { child, ready, exited, async stop(signal = 'SIGTERM') { child.kill(signal); return exited; } };
  }
  async function cli(command, flags = []) {
    const result = await execute(process.execPath, [main, command, '--data-dir', directory, ...flags], { env: environment, timeout: 15000 });
    return JSON.parse(result.stdout).value;
  }
  async function select(id, revision, artifacts = [pin(b)]) {
    const filename = join(f.root, `selection-${id}.json`);
    await writeFile(filename, JSON.stringify({ version: 1, artifacts }));
    return cli('extensions-select', ['--operation', id, '--expected-revision', String(revision), '--selection', filename]);
  }
  function database(action) { const db = new DatabaseSync(join(directory, 'host.sqlite')); try { return action(db); } finally { db.close(); } }
  async function names(ready) {
    const client = createBrowserConnection({ fetch: (path, init) => fetch(ready.origin + path, { ...init, headers: { ...init.headers, Origin: ready.origin } }) });
    return (await client.metadata()).agents.map(value => value.label);
  }
  return { ...f, a, b, pin, directory, config, configuration, marker, pause, launch, cli, select, database, names, environment };
}

test('packaged CLI leaves a fresh namespace unclaimed after bad startup pins and accepts corrected pins', { timeout: 120000 }, async t => {
  const f = await fixture(t);
  await writeFile(f.config, JSON.stringify({ ...f.configuration, extensions: f.configuration.extensions.map(entry => ({ ...entry, artifactId: '0'.repeat(64) })) }));
  const failure = await f.launch().exited;
  assert.equal(failure.code, 1);
  assert.match(failure.stderr, /Invalid artifact selection/);
  assert.equal(await readFile(f.marker, 'utf8'), '');
  assert.deepEqual(f.database(db => db.prepare("SELECT name FROM sqlite_schema WHERE lower(name) GLOB 'service_extension_*'").all()), []);
  await writeFile(f.config, JSON.stringify(f.configuration));
  const host = f.launch(), ready = await host.ready;
  assert.deepEqual(await f.names(ready), ['A']);
  const status = await f.cli('extensions-status');
  assert.equal(status.desiredRevision, 0);
  assert.equal(status.runtime.id, 'startup');
  assert.equal((await host.stop()).code, 0);
});

test('packaged CLI stages immutable artifact selections and restores them independently of launch pins', { timeout: 120000 }, async t => {
  const f = await fixture(t);
  let host = f.launch(), ready = await host.ready;
  assert.deepEqual(await f.names(ready), ['A']);
  assert.equal((await f.cli('extensions-status')).desiredRevision, 0);
  const selected = await f.select('build-b', 0);
  assert.equal(selected.outcome.kind, 'staged');
  assert.equal((await f.cli('extensions-status')).runtime.revision, 0);
  assert.deepEqual(await f.names(ready), ['A']);
  assert.deepEqual(await f.select('build-b', 0), selected);
  const lost = createConnection(join(f.directory, 'control.sock'));
  await once(lost, 'connect');
  lost.write(JSON.stringify({ op: 'extensions-select', command: { id: 'build-b', expectedRevision: 0, selection: { version: 1, artifacts: [f.pin(f.b)] } } }) + '\n');
  lost.destroy();
  assert.deepEqual(await f.select('build-b', 0), selected);
  await assert.rejects(f.select('build-b', 0, []));
  await assert.rejects(f.select('old-build', 0));
  const receiptPath = join(f.root, 'full-receipt.json');
  await f.cli('extensions-status', ['--operation', 'build-b', '--receipt', receiptPath]);
  const bytes = await readFile(receiptPath);
  assert.ok(bytes.length > 16000);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), selected.receiptDigest);
  assert.deepEqual(JSON.parse(bytes).manifests, [f.b.manifest]);
  assert.ok(!bytes.includes(Buffer.from(secret)));
  assert.equal((await host.stop()).code, 0);
  await rm(f.a.directory, { recursive: true });
  host = f.launch(); ready = await host.ready;
  assert.deepEqual(await f.names(ready), ['B']);
  const restored = await f.cli('extensions-status');
  assert.equal(restored.runtime.id, 'build-b');
  assert.equal(restored.desired.outcome.kind, 'applied');
  assert.deepEqual(restored.desired.artifacts, 1);
  const races = await Promise.allSettled([f.select('race-one', 1), f.select('race-two', 1)]);
  assert.equal(races.filter(result => result.status === 'fulfilled').length, 1);
  await assert.rejects(f.select('late-old-build', 1));
  const empty = await f.select('disable', 2, []);
  assert.equal(empty.outcome.kind, 'staged');
  assert.deepEqual(await f.names(ready), ['B']);
  await f.cli('extensions-status', ['--operation', 'build-b', '--receipt', receiptPath]);
  assert.deepEqual(await readFile(receiptPath), bytes);
  await host.stop(); host = f.launch(); ready = await host.ready;
  assert.deepEqual(await f.names(ready), []);
  const disabled = await f.cli('extensions-status');
  assert.equal(disabled.desired.outcome.kind, 'applied-empty');
  assert.equal(disabled.runtime.kind, 'applied-empty');
  assert.equal(disabled.desiredRevision, 3);
  await host.stop(); host = f.launch(); ready = await host.ready;
  assert.deepEqual(await f.names(ready), []);
  assert.equal((await f.cli('extensions-status')).runtime.kind, 'applied-empty');
  const corrupt = join(f.root, 'corrupt'); await cp(f.b.directory, corrupt, { recursive: true });
  await writeFile(join(corrupt, 'entries.mjs'), 'throw new Error("corrupt bytes");');
  await assert.rejects(f.select('corrupt', 3, [{ ...f.pin(f.b), directory: corrupt }]));
  assert.equal((await f.cli('extensions-status')).desiredRevision, 3);
  await f.select('verify-at-boot', 3);
  assert.equal((await host.stop()).code, 0);
  const original = await readFile(join(f.b.directory, 'entries.mjs'));
  await writeFile(join(f.b.directory, 'entries.mjs'), Buffer.concat([original, Buffer.from('\n// altered')]));
  const imports = await readFile(f.marker, 'utf8');
  host = f.launch(); ready = await host.ready;
  assert.deepEqual((await f.cli('extensions-status')).desired.outcome, { kind: 'failed', failure: 'load', recovery: 'replace' });
  assert.deepEqual(await f.names(ready), []);
  assert.equal(await readFile(f.marker, 'utf8'), imports);
  await host.stop();
  await writeFile(join(f.b.directory, 'entries.mjs'), original);
  host = f.launch(); await host.ready;
  assert.equal((await f.cli('extensions-status')).desired.outcome.kind, 'failed');
  assert.equal(await readFile(f.marker, 'utf8'), imports);
  await host.stop();
  assert.ok(!(await readFile(join(f.directory, 'host.sqlite'))).includes(Buffer.from(secret)));
});

test('uncertain boot never imports automatically and requires a new explicit selection', { timeout: 120000 }, async t => {
  const f = await fixture(t);
  let host = f.launch(); await host.ready;
  await f.select('next-boot', 0); await host.stop();
  await writeFile(f.pause, 'pause');
  host = f.launch();
  for (let attempt = 0; attempt < 200; attempt++) {
    const imports = await readFile(f.marker, 'utf8');
    if (imports.includes('B')) break;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.match(await readFile(f.marker, 'utf8'), /B/);
  await host.stop('SIGKILL'); await rm(f.pause);
  const before = await readFile(f.marker, 'utf8');
  host = f.launch(); const ready = await host.ready;
  assert.equal((await f.cli('extensions-status')).desired.outcome.kind, 'interrupted');
  assert.deepEqual(await f.names(ready), []);
  assert.equal(await readFile(f.marker, 'utf8'), before);
  assert.equal((await f.select('next-boot', 0)).outcome.kind, 'interrupted');
  await f.select('new-authorization', 1); await host.stop();
  host = f.launch(); await host.ready;
  assert.equal((await f.cli('extensions-status')).runtime.id, 'new-authorization');
  await host.stop();
  f.configuration.extensions[0].installations[0].authentication.revision = 'changed';
  await writeFile(f.config, JSON.stringify(f.configuration));
  const imports = await readFile(f.marker, 'utf8');
  host = f.launch(); await host.ready;
  assert.equal((await f.cli('extensions-status')).desired.outcome.kind, 'grant-mismatch');
  assert.equal(await readFile(f.marker, 'utf8'), imports);
  await host.stop();
  const environment = { ...f.environment }; delete environment.AGENTUI_EXTENSION_SELECTION_TOKEN;
  host = f.launch(environment);
  assert.equal((await host.exited).stderr.trim(), 'Invalid server extension configuration');
  f.database(db => db.prepare('UPDATE service_extension_selections SET receipt=? WHERE revision=2').run('{}'));
  host = f.launch(); await host.ready;
  assert.deepEqual(await f.cli('extensions-status'), { kind: 'journal-invalid' });
  await assert.rejects(f.select('corrupt-journal', 2));
  assert.equal(await readFile(f.marker, 'utf8'), imports);
  await host.stop();
});

test('durable ownership refuses raw replacement and control framing preserves split Unicode bytes', { timeout: 120000 }, async t => {
  const f = await fixture(t), runtime = await packagedHost(t);
  const entries = [{ kind: 'artifact', ...f.pin(f.a), installations: [{ ...grant,
    authentication: { kind: 'secret', revision: 'first', resolve: async () => secret } }] }];
  const host = await runtime.startBrowserHost({ directory: f.directory, port: 0, assetsDirectory: join(root, 'apps/desktop/web-dist-browser'),
    hostArtifactDirectory: join(root, 'apps/host/dist'), agentStartup: { kind: 'extensions' }, accessMode: 'trusted', extensions: { kind: 'durable-artifacts', entries } });
  t.after(() => host.close());
  await assert.rejects(host.replaceProviderExtensions([]), /Durable extensions/);
  const command = { op: 'extensions-select', command: { id: 'unicode', expectedRevision: 0, selection: { version: 1, artifacts: [f.pin(f.b)] } } };
  const socket = createConnection(join(f.directory, 'control.sock'));
  const response = new Promise((resolve, reject) => { let text = ''; socket.on('data', chunk => { text += chunk; }); socket.on('end', () => resolve(JSON.parse(text))); socket.on('error', reject); });
  await once(socket, 'connect');
  const bytes = Buffer.from(JSON.stringify(command) + '\n'), split = bytes.indexOf(Buffer.from('雪')) + 1;
  assert.ok(split > 0); socket.write(bytes.subarray(0, split));
  await new Promise(resolve => setTimeout(resolve, 10)); socket.write(bytes.subarray(split));
  assert.equal((await response).ok, true);
  assert.equal((await f.cli('extensions-status')).desiredRevision, 1);
  const invalid = createConnection(join(f.directory, 'control.sock'));
  const refused = new Promise((resolve, reject) => { let text = ''; invalid.on('data', chunk => { text += chunk; }); invalid.on('end', () => resolve(JSON.parse(text))); invalid.on('error', reject); });
  await once(invalid, 'connect');
  invalid.write(Buffer.concat([Buffer.from('{"op":"extensions-status","id":"'), Buffer.from([0xff]), Buffer.from('"}\n')]));
  assert.equal((await refused).ok, false);
  await assert.rejects(requestControl(join(f.directory, 'control.sock'), { op: 'extensions-status', id: 'x'.repeat(5000) }), /too large/);
  await host.close();
  const transientDirectory = join(f.root, 'transient');
  const transient = await runtime.startBrowserHost({ directory: transientDirectory, port: 0, assetsDirectory: join(root, 'apps/desktop/web-dist-browser'),
    hostArtifactDirectory: join(root, 'apps/host/dist'), agentStartup: { kind: 'extensions' }, extensions: { kind: 'transient', entries } });
  try {
    for (const command of [{ op: 'extensions-status', id: null },
      { op: 'extensions-select', command: { id: 'refused', expectedRevision: 0, selection: { version: 1, artifacts: [] } } },
      { op: 'extensions-receipt', digest: 'a'.repeat(64), offset: 0 }]) {
      assert.deepEqual(await requestControl(join(transientDirectory, 'control.sock'), command),
        { ok: false, error: 'Selection requires durable artifact ownership' });
    }
    assert.deepEqual(await transient.replaceProviderExtensions([]), { kind: 'replaced', generation: null });
  } finally { await transient.close(); }
});

test('failed post-activation persistence closes the process and leaves an interrupted boot', { timeout: 120000 }, async t => {
  const f = await fixture(t);
  let host = f.launch(); await host.ready;
  await f.select('write-failure', 0); await host.stop();
  f.database(db => db.exec(`CREATE TRIGGER fail_applied BEFORE UPDATE ON service_extension_boots
    WHEN json_extract(NEW.outcome,'$.kind')='applied' BEGIN SELECT RAISE(ABORT,'PRIVATE_PERSISTENCE_FAILURE'); END`));
  host = f.launch();
  const failure = await host.exited;
  assert.equal(failure.code, 1);
  assert.match(failure.stderr, /Selection persistence failed/);
  assert.ok(!failure.stderr.includes('PRIVATE_PERSISTENCE_FAILURE'));
  assert.equal(f.database(db => JSON.parse(db.prepare('SELECT outcome FROM service_extension_boots ORDER BY sequence DESC LIMIT 1').get().outcome)).kind, 'applying');
  const imported = await readFile(f.marker, 'utf8');
  host = f.launch(); await host.ready;
  const status = await f.cli('extensions-status');
  assert.equal(status.desired.outcome.kind, 'interrupted');
  assert.equal(status.lastApplied.id, 'startup');
  assert.equal(status.runtime.kind, 'withheld');
  assert.equal(await readFile(f.marker, 'utf8'), imported);
  await host.stop();
  f.database(db => {
    db.exec('DROP TRIGGER fail_applied');
    db.prepare('UPDATE service_extension_boots SET outcome=? WHERE id=?').run('{"kind":"pending"}', status.desired.bootId);
  });
  host = f.launch(); await host.ready;
  assert.equal((await f.cli('extensions-status')).desired.outcome.kind, 'interrupted');
  assert.equal(await readFile(f.marker, 'utf8'), imported);
  await host.stop();
});
