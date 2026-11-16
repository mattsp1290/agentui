import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { EXTENSION_SDK_VERSION } from '@agentui/sdk';
import { CODEX_RUNTIME } from '@agentui/contracts/compatibility';
import { createCrewFixture } from '../extensions/providers/contracts/crew.ts';
import { setup as setupServerArtifact, extension as artifactExtension, write as writeArtifactSource, resigned } from '../customization/build/server-support.mjs';

const main = fileURLToPath(new URL('../../apps/host/dist/main.js', import.meta.url));
const instance = { namespace: 'example-crew', installationId: 'personal', generation: '1', protocolVersion: 'crew-v2' };
const secret = 'PRIVATE_CLI_EXTENSION_SECRET_94';
const privateError = 'PRIVATE_EXTENSION_ERROR_17';
async function fixture(t, service = 'https://example.com') {
  const directory = await mkdtemp(join(tmpdir(), 'agentui-extension-cli-'));
  const config = join(directory, 'agents.json'), selection = join(directory, 'extensions.json');
  const installed = join(directory, 'crew-v1'), marker = join(directory, 'imported'), lifecycle = join(directory, 'lifecycle');
  await mkdir(installed);
  await writeFile(config, JSON.stringify({ version: 1, default: 'native', agents: [
    { name: 'native', kind: 'codex-sdk', workspace: directory, executable: join(directory, 'not-installed') },
  ] }));
  const manifest = { namespace: instance.namespace, trust: 'full', sdkVersion: EXTENSION_SDK_VERSION, entries: [{ kind: 'server', module: './server.mjs' }] };
  const input = { version: 1, extensions: [{ directory: './crew-v1', installations: [
    { id: 'service', instance: { ...instance }, service, expectedAuthority: 'remote-provider', authentication: { kind: 'environment', variable: 'AGENTUI_EXTENSION_CREW_TOKEN', revision: 'first' } },
  ] }] };
  const module = `import { appendFileSync, writeFileSync } from 'node:fs';
    import { createCrewFixture } from ${JSON.stringify(new URL('../extensions/providers/contracts/crew.ts', import.meta.url).href)};
    writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ credentialPresent: Object.hasOwn(process.env, 'AGENTUI_EXTENSION_CREW_TOKEN') }));
    const instance = ${JSON.stringify(instance)}, service = ${JSON.stringify(service)};
    const fixture = createCrewFixture(instance);
    export default { kind: 'server', sdkVersion: ${JSON.stringify(EXTENSION_SDK_VERSION)}, activate(context) {
      let credential;
      const request = (path, body) => context.credentials.use({ credential, service }, async secret => {
        const response = await fetch(service + path, { method: body === undefined ? 'GET' : 'POST', signal: AbortSignal.timeout(5000),
          headers: { authorization: 'Bearer ' + secret, 'content-type': 'application/json' },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
        if (!response.ok) throw new Error('Remote fixture refused');
        return response.json();
      });
      const backend = { ...fixture.crewBackend,
        capabilities: { ...fixture.crewBackend.capabilities, observe: { kind: 'unsupported', reason: 'No fixture feed' } },
        discover: () => request('/agents'), create: operation => request('/create', operation),
        submit: operation => request('/send', operation),
        async close() { appendFileSync(${JSON.stringify(lifecycle)}, 'close\\n'); }
      };
      context.providers.add('service', { ...fixture.crew, async connect(request) {
        credential = request.credential;
        return { kind: 'connected', backend };
      } }, fixture.crewPresentation);
      return { async dispose() { appendFileSync(${JSON.stringify(lifecycle)}, 'dispose\\n'); } };
    } };`;
  const save = async () => {
    await writeFile(join(installed, 'package.json'), JSON.stringify({ name: '@example/crew', version: '1.0.0', agentui: { extension: manifest, sources: ['ignored'] } }));
    await writeFile(selection, JSON.stringify(input));
  };
  await save(); await writeFile(join(installed, 'server.mjs'), module);
  const children = [];
  const launch = (args, environment = {}) => {
    const child = spawn(process.execPath, [main, ...args, '--data-dir', join(directory, 'data')], {
      cwd: directory, env: { ...process.env, AGENTUI_EXTENSION_CREW_TOKEN: secret, ...environment }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8').on('data', text => { stdout += text; });
    child.stderr.setEncoding('utf8').on('data', text => { stderr += text; });
    const exited = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', code => resolve(code)); });
    const result = { child, exited, get stdout() { return stdout; }, get stderr() { return stderr; } };
    children.push(result); return result;
  };
  t.after(async () => {
    for (const { child, exited } of children) {
      if (child.exitCode !== null || child.signalCode !== null) continue;
      child.kill('SIGTERM'); const timer = setTimeout(() => child.kill('SIGKILL'), 2000);
      try { await exited; } finally { clearTimeout(timer); }
    }
    await rm(directory, { recursive: true, force: true });
  });
  return { directory, config, selection, installed, marker, lifecycle, manifest, input, module, save, launch,
    start: (args = [], environment) => launch(['serve', '--config', config, '--extensions', selection, '--port', '0', ...args], environment) };
}
async function ready(running) {
  const lines = createInterface({ input: running.child.stdout });
  try {
    const info = await Promise.race([
      new Promise(resolve => lines.once('line', line => resolve(JSON.parse(line)))),
      running.exited.then(() => { throw new Error(running.stderr); }),
    ]);
    const response = await fetch(`${info.origin}/api/v1`, { method: 'POST', signal: AbortSignal.timeout(5000),
      headers: { 'Content-Type': 'application/json', Origin: info.origin }, body: JSON.stringify({ op: 'metadata' }) });
    assert.equal(response.status, 401); await response.arrayBuffer();
    return info;
  } finally { lines.close(); }
}
async function stop(running) {
  running.child.kill('SIGTERM'); assert.equal(await running.exited, 0, running.stderr);
}
function privateDiagnostics(running) {
  assert.doesNotMatch(running.stdout + running.stderr, /PRIVATE_CLI_EXTENSION_SECRET|PRIVATE_EXTENSION_ERROR|AGENTUI_EXTENSION_CREW_TOKEN|not-installed|server\.mjs/);
}

test('bundled serve selects an installed public provider, pairs, creates and sends with host credentials, then disposes on SIGTERM', { timeout: 20000 }, async t => {
  const requests = [], publicFixture = createCrewFixture(instance);
  const remote = createServer(async (request, response) => {
    assert.equal(request.headers.authorization, `Bearer ${secret}`);
    requests.push(request.url);
    let text = ''; for await (const part of request) text += part;
    const result = request.url === '/agents' ? await publicFixture.crewBackend.discover()
      : request.url === '/create' ? await publicFixture.crewBackend.create(JSON.parse(text))
      : await publicFixture.crewBackend.submit(JSON.parse(text));
    if (request.url === '/send') result.value.state = 'completed';
    response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(result));
  });
  await new Promise(resolve => remote.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => remote.close(resolve)));
  const f = await fixture(t, `http://127.0.0.1:${remote.address().port}`);
  const executable = join(f.directory, 'codex'), nativeEnvironment = join(f.directory, 'native-environment.json');
  await writeFile(executable, `#!${process.execPath}
    import { writeFileSync } from 'node:fs';
    if (process.argv.includes('--version')) {
      writeFileSync(${JSON.stringify(nativeEnvironment)}, JSON.stringify({
        credentialPresent: Object.hasOwn(process.env, 'AGENTUI_EXTENSION_CREW_TOKEN'),
        unselected: process.env.AGENTUI_EXTENSION_UNSELECTED,
        nativeKeyPresent: Object.hasOwn(process.env, 'OPENCODE_GO_API_KEY'),
        setupCapabilityPresent: Object.hasOwn(process.env, 'AGENTUI_SETUP_CAPABILITY'),
        anthropicKey: process.env.AGENTUI_ANTHROPIC_API_KEY, path: process.env.PATH, sentinel: process.env.AGENTUI_ENV_SENTINEL,
      }));
      console.log(${JSON.stringify('codex-cli ' + CODEX_RUNTIME.version)});
      process.exitCode = 1;
    } else { process.exit(1); }
  `, { mode: 0o700 });
  await writeFile(f.config, JSON.stringify({ version: 1, default: 'native', agents: [
    { name: 'native', kind: 'codex', workspace: f.directory, executable },
  ] }));
  const environment = { AGENTUI_EXTENSION_UNSELECTED: 'unselected', OPENCODE_GO_API_KEY: 'native-key',
    AGENTUI_SETUP_CAPABILITY: 'synthetic-setup-capability',
    AGENTUI_ANTHROPIC_API_KEY: 'anthropic-key', PATH: process.env.PATH, AGENTUI_ENV_SENTINEL: 'preserved' };
  const running = f.start([], environment), info = await ready(running);
  assert.equal(info.mode, 'serve');
  assert.deepEqual(JSON.parse(await readFile(f.marker, 'utf8')), { credentialPresent: false });
  assert.deepEqual(JSON.parse(await readFile(nativeEnvironment, 'utf8')), {
    credentialPresent: false, unselected: 'unselected', nativeKeyPresent: false, setupCapabilityPresent: false, anthropicKey: 'anthropic-key',
    path: process.env.PATH, sentinel: 'preserved',
  });
  let cookie = ''; const payloads = [];
  const call = async body => {
    const response = await fetch(`${info.origin}/api/v1`, { method: 'POST', signal: AbortSignal.timeout(5000), headers: {
      'Content-Type': 'application/json', Origin: info.origin, Cookie: cookie,
    }, body: JSON.stringify(body) });
    if (response.headers.has('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
    const value = await response.json(); payloads.push(value); return { status: response.status, ...value };
  };
  const unpaired = await call({ op: 'metadata' }); assert.equal(unpaired.status, 401); assert.equal(unpaired.ok, false);
  const invitation = f.launch(['invite']); assert.equal(await invitation.exited, 0, invitation.stderr);
  assert.equal((await call({ op: 'pair', code: JSON.parse(invitation.stdout).value.code })).ok, true);
  const metadata = (await call({ op: 'metadata' })).value;
  assert.equal(metadata.agents[0].availability.kind, 'unavailable');
  assert.equal(metadata.defaultAgentId, metadata.agents[0].id);
  const provider = metadata.agents.find(agent => agent.label === 'Crew researcher'); assert.ok(provider);
  assert.equal(provider.kind, 'provider'); assert.equal(provider.namespace, instance.namespace);
  const scope = { hostId: info.hostId, conversationId: 'configured-provider' };
  const created = await call({ op: 'create', scope, agentId: provider.id }); assert.equal(created.ok, true, JSON.stringify(created));
  assert.deepEqual(created.value, scope);
  const sent = await call({ op: 'submit', command: { version: 1, scope, clientCommandId: 'send-one', body: { kind: 'send', text: 'hello' } } });
  assert.equal(sent.ok, true, JSON.stringify(sent)); assert.equal(sent.value.kind, 'receipt');
  assert.equal(sent.value.receipt.state.kind, 'completed');
  assert.ok(requests.includes('/agents')); assert.equal(requests.filter(path => path === '/create').length, 1);
  assert.equal(requests.filter(path => path === '/send').length, 1);
  assert.doesNotMatch(JSON.stringify(payloads), /PRIVATE_CLI_EXTENSION_SECRET|AGENTUI_EXTENSION_CREW_TOKEN|opaqueHandle|not-installed/);
  const db = new DatabaseSync(join(f.directory, 'data', 'host.sqlite'), { readOnly: true });
  try {
    const rows = db.prepare('SELECT * FROM service_provider_credentials').all(); assert.equal(rows.length, 1);
    assert.equal(rows[0].revision, 'first'); assert.doesNotMatch(JSON.stringify(rows), /PRIVATE_CLI_EXTENSION_SECRET|AGENTUI_EXTENSION_CREW_TOKEN/);
  } finally { db.close(); }
  await stop(running); assert.equal(await readFile(f.lifecycle, 'utf8'), 'close\ndispose\n');
  privateDiagnostics(running);
  assert.equal((await readFile(join(f.directory, 'data', 'host.sqlite'))).includes(Buffer.from(secret)), false);
  const unchanged = f.launch(['serve', '--config', f.config, '--port', '0']); await ready(unchanged); await stop(unchanged);
});

test('raw readiness announcement immediately followed by SIGTERM drains the provider and exits normally', { timeout: 15000 }, async t => {
  const f = await fixture(t);
  await writeFile(join(f.installed, 'server.mjs'), f.module.replace("discover: () => request('/agents')",
    'discover: () => fixture.crewBackend.discover()'));
  for (let attempt = 0; attempt < 3; attempt++) {
    await rm(f.lifecycle, { force: true });
    const running = f.start(), lines = createInterface({ input: running.child.stdout });
    try {
      await Promise.race([
        new Promise(resolve => lines.once('line', () => { running.child.kill('SIGTERM'); resolve(); })),
        running.exited.then(() => { throw new Error(running.stderr); }),
      ]);
      assert.equal(await running.exited, 0, running.stderr); assert.equal(running.child.signalCode, null);
      const lifecycle = await readFile(f.lifecycle, 'utf8'); assert.equal(lifecycle, 'close\ndispose\n');
      t.diagnostic(JSON.stringify({ attempt, exitCode: running.child.exitCode, signal: running.child.signalCode, lifecycle }));
      privateDiagnostics(running);
    } finally { lines.close(); }
  }
});

for (const [name, change] of [
  ['selection schema', (f, second) => { second.extra = secret; }],
  ['manifest SDK', (f, second, manifest) => { manifest.sdkVersion = '99.0.0'; }],
  ['manifest server declaration', (f, second, manifest) => { manifest.entries[0].kind = 'desktop'; }],
  ['grant', (f, second) => { second.installations[0].service = `https://example.com/private?token=${secret}`; }],
  ['environment', (f, second) => { second.installations[0].authentication.variable = 'AGENTUI_EXTENSION_MISSING_CLI_TOKEN_94'; }],
]) test(`later invalid ${name} prevents every selected import and listener announcement`, { timeout: 10000 }, async t => {
  const f = await fixture(t), second = structuredClone(f.input.extensions[0]), manifest = structuredClone(f.manifest);
  second.directory = './second'; second.installations[0].instance.namespace = 'second'; manifest.namespace = 'second';
  const directory = join(f.directory, 'second'); await mkdir(directory);
  change(f, second, manifest); f.input.extensions.push(second); await f.save();
  await writeFile(join(directory, 'package.json'), JSON.stringify({ agentui: { extension: manifest } }));
  await writeFile(join(directory, 'server.mjs'), f.module);
  const failed = f.start(); assert.equal(await failed.exited, 1);
  assert.equal(failed.stdout, ''); assert.match(failed.stderr, /Invalid server extension configuration/);
  assert.equal(existsSync(f.marker), false); assert.equal(existsSync(f.lifecycle), false);
  assert.equal(existsSync(join(f.directory, 'data', 'host.sqlite')), false); privateDiagnostics(failed);
});

for (const [name, source] of [
  ['missing module', null],
  ['incompatible export', 'export default {};'],
  ['private import error', `throw new Error(${JSON.stringify(privateError + secret)});`],
  ['private activation error', `export default { kind: 'server', sdkVersion: ${JSON.stringify(EXTENSION_SDK_VERSION)}, activate() { throw new Error(${JSON.stringify(privateError + secret)}); } };`],
]) test(`bundled CLI refuses ${name} safely and releases its host directory for restart`, { timeout: 10000 }, async t => {
  const f = await fixture(t);
  if (source === null) await rm(join(f.installed, 'server.mjs'));
  else await writeFile(join(f.installed, 'server.mjs'), source);
  const failed = f.start(); assert.equal(await failed.exited, 1); assert.equal(failed.stdout, '');
  assert.match(failed.stderr, /Server extension loading failed|Provider activation failed/); privateDiagnostics(failed);
  const recovered = f.launch(['serve', '--config', f.config, '--port', '0']); await ready(recovered); await stop(recovered);
});

test('bundled CLI hides discovery exceptions, closes acquired resources and permits restart', { timeout: 10000 }, async t => {
  const f = await fixture(t);
  await writeFile(join(f.installed, 'server.mjs'), f.module.replace("discover: () => request('/agents')",
    `discover: () => { throw new Error(${JSON.stringify(privateError + secret)}); }`));
  const failed = f.start(); assert.equal(await failed.exited, 1); assert.equal(failed.stdout, '');
  assert.match(failed.stderr, /Provider discovery failed/); privateDiagnostics(failed);
  assert.equal(await readFile(f.lifecycle, 'utf8'), 'close\ndispose\n');
  const recovered = f.launch(['serve', '--config', f.config, '--port', '0']); await ready(recovered); await stop(recovered);
});

test('bundled CLI requires a serving configuration, rejects empty selection options and limits --extensions to serve', { timeout: 15000 }, async t => {
  const f = await fixture(t);
  const missingNative = f.launch(['serve']);
  assert.equal(await missingNative.exited, 1); assert.match(missingNative.stderr, /Provide --config or --extensions/);
  const blank = f.start(['--extensions=']); assert.equal(await blank.exited, 1); assert.match(blank.stderr, /Invalid server extension configuration/);
  for (const command of ['browser-dev', 'codex', 'codex-sdk', 'claude-sdk', 'pi', 'invite', 'invite-native', 'devices', 'revoke']) {
    const failed = f.launch([command, '--extensions', f.selection]);
    assert.equal(await failed.exited, 1); assert.match(failed.stderr, new RegExp(`--extensions is not valid for ${command}`));
    assert.equal(failed.stdout, ''); privateDiagnostics(failed);
  }
});

for (const trusted of [false, true]) test(`bundled extension-only serve creates and sends with ${trusted ? 'trusted' : 'paired'} browser access and separate native credentials`, { timeout: 20000 }, async t => {
  const f = await fixture(t);
  await writeFile(join(f.installed, 'server.mjs'), f.module
    .replace("discover: () => request('/agents')", 'discover: () => fixture.crewBackend.discover()')
    .replace("create: operation => request('/create', operation)", 'create: operation => fixture.crewBackend.create(operation)')
    .replace("submit: operation => request('/send', operation)", 'submit: operation => fixture.crewBackend.submit(operation)'));
  const running = f.launch(['serve', '--extensions', f.selection, '--port', '0', ...(trusted ? ['--trusted'] : [])]);
  const lines = createInterface({ input: running.child.stdout });
  const info = await Promise.race([new Promise(resolve => lines.once('line', line => resolve(JSON.parse(line)))), running.exited.then(() => { throw new Error(running.stderr); })]);
  lines.close();
  let cookie;
  async function call(body, path = '/api/v1', headers = {}) {
    const response = await fetch(info.origin + path, { method: 'POST', signal: AbortSignal.timeout(5000), headers: {
      'Content-Type': 'application/json', ...(path.startsWith('/native/') ? {} : { Origin: info.origin, ...(cookie ? { Cookie: cookie } : {}) }), ...headers,
    }, body: JSON.stringify(body) });
    if (response.headers.has('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
    return { status: response.status, ...await response.json() };
  }
  async function control(args) {
    const request = f.launch(args); assert.equal(await request.exited, 0, request.stderr); return JSON.parse(request.stdout).value;
  }
  assert.equal((await call({ op: 'metadata' })).status, trusted ? 200 : 401);
  if (!trusted) assert.equal((await call({ op: 'pair', code: (await control(['invite'])).code })).ok, true);
  const metadata = (await call({ op: 'metadata' })).value;
  assert.equal(metadata.compatibility.nativeRuntime, null);
  assert.equal(metadata.compatibility.wireVersion, 6);
  assert.ok(metadata.agents.length); assert.ok(metadata.agents.every(agent => agent.kind === 'provider'));
  assert.equal(metadata.defaultAgentId, metadata.agents.filter(agent => agent.availability.kind === 'ready').map(agent => agent.id).sort()[0]);
  const scope = { hostId: info.hostId, conversationId: 'extension-browser' };
  assert.deepEqual((await call({ op: 'create', scope, agentId: metadata.defaultAgentId })).value, scope);
  const sent = await call({ op: 'submit', command: { version: 1, scope, clientCommandId: 'send', body: { kind: 'send', text: 'hello provider' } } });
  assert.equal(sent.ok, true, JSON.stringify(sent)); assert.equal(sent.value.kind, 'receipt');
  assert.equal((await call({ op: 'create', scope: { ...scope, conversationId: 'foreign', hostId: 'foreign' }, agentId: metadata.defaultAgentId })).status, 403);
  const nativePath = '/native/v1';
  assert.equal((await call({ op: 'metadata' }, nativePath)).status, 401);
  const nativeInvite = await control(['invite-native']);
  const native = await call({ version: 1, hostId: info.hostId, code: nativeInvite.code }, nativePath + '/pair');
  assert.equal(native.status, 200);
  const authorization = { Authorization: `Bearer ${native.value.secret}` };
  const nativeMetadata = await call({ op: 'metadata' }, nativePath, authorization);
  assert.equal(nativeMetadata.status, 200); assert.equal(nativeMetadata.value.defaultAgentId, metadata.defaultAgentId);
  assert.deepEqual((await call({ op: 'create', scope: { ...scope, conversationId: 'extension-native' }, agentId: metadata.defaultAgentId }, nativePath, authorization)).value, { ...scope, conversationId: 'extension-native' });
  await control(['revoke', '--id', nativeMetadata.value.principalId]);
  assert.equal((await call({ op: 'metadata' }, nativePath, authorization)).status, 401);
  if (!trusted) {
    assert.equal((await call({ op: 'metadata' }, '/api/v1', { Origin: 'https://foreign.example' })).status, 400);
    await control(['revoke', '--id', metadata.principalId]);
    assert.equal((await call({ op: 'metadata' })).status, 401);
  }
  assert.equal(existsSync(join(f.directory, 'data', 'recorded.jsonl')), false);
  await stop(running); privateDiagnostics(running);
});

for (const [name, change] of [
  ['empty selection', f => { f.input.extensions = []; return f.save(); }],
  ['empty discovery', f => writeFile(join(f.installed, 'server.mjs'), f.module.replace("discover: () => request('/agents')", "discover: () => ({ kind: 'available', agents: [] })"))],
  ['creation unsupported', f => writeFile(join(f.installed, 'server.mjs'), f.module
    .replace("discover: () => request('/agents')", 'discover: () => fixture.crewBackend.discover()')
    .replace('...fixture.crewBackend.capabilities, observe:', "...fixture.crewBackend.capabilities, create: { kind: 'unsupported', reason: 'Read only' }, observe:"))],
]) test(`bundled extension-only serve remains readable with ${name}`, { timeout: 10000 }, async t => {
  const f = await fixture(t); await change(f);
  const running = f.launch(['serve', '--extensions', f.selection, '--port', '0']);
  const info = await ready(running);
  const invitation = f.launch(['invite']); assert.equal(await invitation.exited, 0);
  const pair = await fetch(`${info.origin}/api/v1`, { method: 'POST', headers: { Origin: info.origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ op: 'pair', code: JSON.parse(invitation.stdout).value.code }) });
  const cookie = pair.headers.get('set-cookie').split(';')[0]; await pair.arrayBuffer();
  const client = (await import('@agentui/client/service')).createBrowserConnection({ fetch: (path, init) => fetch(info.origin + path, {
    ...init, headers: { ...init.headers, Origin: info.origin, Cookie: cookie },
  }) });
  const metadata = await client.metadata();
  assert.equal(metadata.defaultAgentId, null); assert.equal(metadata.compatibility.nativeRuntime, null);
  assert.equal(metadata.agents.length, name === 'creation unsupported' ? 1 : 0);
  assert.ok(metadata.agents.every(agent => agent.availability.kind === 'unavailable'));
  assert.deepEqual(await client.catalog(), []);
  assert.equal(existsSync(join(f.directory, 'data', 'recorded.jsonl')), false);
  await stop(running);
});


async function artifactFixture(t) {
  const f = await fixture(t);
  const source = f.module.replace(new URL('../extensions/providers/contracts/crew.ts', import.meta.url).href, './crew.ts')
    .replace("discover: () => request('/agents')", `discover: async () => {
      await context.credentials.use({credential, service}, async value => {if(value !== ${JSON.stringify(secret)}) throw new Error('Wrong credential');});
      return fixture.crewBackend.discover();
    }`)
    .replace("create: operation => request('/create', operation)", 'create: operation => fixture.crewBackend.create(operation)')
    .replace("submit: operation => request('/send', operation)", 'submit: operation => fixture.crewBackend.submit(operation)');
  const build = await setupServerArtifact(t, source);
  await writeArtifactSource(build.repo.directory, 'package.json', { type: 'module', agentui: artifactExtension(instance.namespace) });
  await writeArtifactSource(build.repo.directory, 'crew.ts', await readFile(new URL('../extensions/providers/contracts/crew.ts', import.meta.url), 'utf8'));
  const artifact = await build.build();
  f.input.extensions[0] = { kind: 'artifact', directory: artifact.directory, artifactId: artifact.manifest.artifactId,
    installations: f.input.extensions[0].installations };
  await writeFile(f.selection, JSON.stringify(f.input));
  await rm(f.marker, { force: true });
  return { ...f, artifact };
}

test('bundled serve starts a caller-pinned artifact, uses credentials, creates and sends, and disposes on shutdown', { timeout: 20000 }, async t => {
  const f = await artifactFixture(t);
  const running = f.launch(['serve', '--extensions', f.selection, '--trusted', '--port', '0']);
  const lines = createInterface({ input: running.child.stdout });
  const info = await Promise.race([new Promise(resolve => lines.once('line', line => resolve(JSON.parse(line)))), running.exited.then(() => { throw new Error(running.stderr); })]);
  lines.close();
  const call = async body => {
    const response = await fetch(info.origin + '/api/v1', { method: 'POST', signal: AbortSignal.timeout(5000),
      headers: { Origin: info.origin, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return response.json();
  };
  const metadata = (await call({ op: 'metadata' })).value;
  assert.equal(metadata.agents[0].namespace, instance.namespace);
  assert.equal(metadata.agents[0].availability.kind, 'ready');
  const scope = { hostId: info.hostId, conversationId: 'artifact-provider' };
  assert.deepEqual((await call({ op: 'create', scope, agentId: metadata.defaultAgentId })).value, scope);
  const sent = await call({ op: 'submit', command: { version: 1, scope, clientCommandId: 'artifact-send', body: { kind: 'send', text: 'hello' } } });
  assert.equal(sent.ok, true); assert.equal(sent.value.kind, 'receipt');
  assert.deepEqual(JSON.parse(await readFile(f.marker, 'utf8')), { credentialPresent: false });
  await stop(running); assert.equal(await readFile(f.lifecycle, 'utf8'), 'close\ndispose\n');
  privateDiagnostics(running);
});

for (const [name, mutate] of [
  ['caller pin', async f => { f.input.extensions[0].artifactId = '0'.repeat(64); }],
  ['bytes', f => writeFile(join(f.artifact.directory, 'entries.mjs'), "throw new Error('PRIVATE_ARTIFACT_TAMPER')")],
  ['ABI', async f => {
    const manifest = resigned(f.artifact.manifest, value => { value.runtime.abiIdentity = '0'.repeat(64); });
    await writeFile(join(f.artifact.directory, 'customization.json'), JSON.stringify(manifest));
    f.input.extensions[0].artifactId = manifest.artifactId;
  }],
  ['Node version', async f => {
    const manifest = resigned(f.artifact.manifest, value => { value.runtime.version = '0.0.0'; });
    await writeFile(join(f.artifact.directory, 'customization.json'), JSON.stringify(manifest));
    f.input.extensions[0].artifactId = manifest.artifactId;
  }],
]) test(`artifact ${name} failure prevents earlier installed imports and listener announcement`, { timeout: 15000 }, async t => {
  const f = await artifactFixture(t);
  await mutate(f);
  f.input.extensions.unshift({ directory: f.installed, installations: [] });
  const installedManifest = { ...f.manifest, namespace: 'earlier' };
  await writeFile(join(f.installed, 'package.json'), JSON.stringify({ agentui: { extension: installedManifest } }));
  await writeFile(f.selection, JSON.stringify(f.input));
  const running = f.launch(['serve', '--extensions', f.selection, '--port', '0']);
  assert.equal(await running.exited, 1); assert.equal(running.stdout, '');
  assert.equal(existsSync(f.marker), false); privateDiagnostics(running);
  assert.doesNotMatch(running.stderr, /PRIVATE_ARTIFACT_TAMPER/);
});

test('packaged SDK facade and host use one emitted runtime module graph', async () => {
  const graph = JSON.parse(await readFile(new URL('../../apps/host/dist/runtime-graph.json', import.meta.url), 'utf8'));
  const owner = Object.entries(graph.outputs).filter(([, output]) => Object.keys(output.inputs).includes('packages/sdk/dist/extensions.js'));
  assert.equal(owner.length, 1);
  const [path] = owner[0];
  assert.ok(graph.outputs['apps/host/dist/main.js'].imports.some(value => value.path === path));
  assert.ok(graph.outputs['apps/host/dist/sdk.js'].imports.some(value => value.path === path));
});


test('later selected import failure releases an earlier artifact hook before process cleanup', { timeout: 15000 }, async t => {
  const f = await artifactFixture(t), cleanup = join(f.directory, 'module-cleanup');
  const catalog = await readFile(join(f.artifact.directory, 'entries.mjs'), 'utf8');
  const code = catalog + "\nglobalThis.agentuiArtifactCleanupProbe = () => import('./cleanup-probe.mjs');\n";
  const lazy = 'export const value = 1;';
  const inventory = (path, bytes) => ({ path, sha256: createHash('sha256').update(bytes).digest('hex'), size: Buffer.byteLength(bytes) });
  const manifest = resigned(f.artifact.manifest, value => {
    value.assets = value.assets.filter(asset => asset.path !== 'entries.mjs');
    value.assets.push(inventory('entries.mjs', code), inventory('cleanup-probe.mjs', lazy));
    value.assets.sort((a, b) => a.path.localeCompare(b.path));
  });
  await writeFile(join(f.artifact.directory, 'entries.mjs'), code);
  await writeFile(join(f.artifact.directory, 'cleanup-probe.mjs'), lazy);
  await writeFile(join(f.artifact.directory, 'customization.json'), JSON.stringify(manifest));
  f.input.extensions[0].artifactId = manifest.artifactId;
  f.input.extensions.push({ directory: f.installed, installations: [] });
  await writeFile(join(f.installed, 'package.json'), JSON.stringify({ agentui: { extension: { ...f.manifest, namespace: 'later' } } }));
  await writeFile(join(f.installed, 'server.mjs'), `import {writeFileSync} from 'node:fs';
    setImmediate(async () => {
      try { await globalThis.agentuiArtifactCleanupProbe(); writeFileSync(${JSON.stringify(cleanup)}, 'leaked'); }
      catch { writeFileSync(${JSON.stringify(cleanup)}, 'released'); }
    });
    throw new Error('PRIVATE_LATER_IMPORT_FAILURE');`);
  await writeFile(f.selection, JSON.stringify(f.input));
  const running = f.launch(['serve', '--extensions', f.selection, '--port', '0']);
  assert.equal(await running.exited, 1); assert.equal(running.stdout, '');
  assert.equal(await readFile(cleanup, 'utf8'), 'released');
  privateDiagnostics(running); assert.doesNotMatch(running.stderr, /PRIVATE_LATER_IMPORT_FAILURE/);
});
