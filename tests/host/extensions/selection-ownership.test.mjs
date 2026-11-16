import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { canonicalJson } from '@agentui/contracts';
import { CODEX_RUNTIME } from '@agentui/contracts/compatibility';
import { takeServerExtensionConfiguration } from '../../../apps/host/build/tsc/server-extension-config.js';
import { requestControl } from '../../../apps/host/build/tsc/control.js';
import { normalizeGrantPool, publicGrantBinding } from '../../../apps/host/build/tsc/provider-credentials.js';
import { api, fixture, packagedHost, secret } from './artifact-support.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));

test('pre-correction version 1 journal restarts with the exact original grant digest and receipts', async t => {
  const runtime = await packagedHost(t);
  const golden = JSON.parse(await fs.readFile(new URL('./fixtures/selection-journal-v1.json', import.meta.url), 'utf8'));
  const directory = await fs.mkdtemp(join(tmpdir(), 'agentui-old-selection-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const database = new DatabaseSync(join(directory, 'host.sqlite'));
  database.exec('CREATE TABLE service_identity(singleton INTEGER PRIMARY KEY, host TEXT NOT NULL)');
  database.prepare('INSERT INTO service_identity VALUES(1,?)').run(golden.hostId);
  for (const table of golden.tables) database.exec(table.sql);
  for (const table of [...golden.tables].sort((a, b) => (a.name === 'service_extension_boots') - (b.name === 'service_extension_boots'))) {
    for (const row of table.rows) {
      database.prepare(`INSERT INTO ${table.name} (${Object.keys(row).join(',')}) VALUES (${Object.keys(row).map(() => '?').join(',')})`).run(...Object.values(row));
    }
  }
  database.close();
  const entries = golden.entries.map(entry => ({ ...entry, installations: entry.installations.map(grant => ({ ...grant,
    authentication: { ...grant.authentication, resolve: async () => secret } })) }));
  const publicGrants = normalizeGrantPool(entries.flatMap(entry => entry.installations)).map(publicGrantBinding);
  const digest = createHash('sha256').update('[' + publicGrants.map(grant => canonicalJson(grant)).sort().join(',') + ']').digest('hex');
  assert.equal(digest, golden.grantsDigest);
  const config = join(directory, 'extensions.json');
  await fs.writeFile(config, JSON.stringify({ version: 2, ownership: 'durable-artifacts', extensions: entries.map(entry => ({ ...entry,
    installations: entry.installations.map(grant => ({ ...grant, authentication: { kind: 'environment', revision: grant.authentication.revision,
      variable: 'AGENTUI_EXTENSION_GOLDEN_TOKEN' } })) })) }));
  const extensions = takeServerExtensionConfiguration(config, { AGENTUI_EXTENSION_GOLDEN_TOKEN: secret });
  const host = await runtime.startBrowserHost({ directory, port: 0, assetsDirectory: join(root, 'apps/desktop/web-dist-browser'),
    hostArtifactDirectory: join(root, 'apps/host/dist'), agentStartup: { kind: 'recorded' }, extensions });
  try {
    const status = await requestControl(join(directory, 'control.sock'), { op: 'extensions-status', id: null });
    assert.equal(status.value.runtime.kind, 'applied-empty');
    assert.equal(status.value.desired.id, 'disable');
    assert.deepEqual(host.extensionStatus(), { kind: 'empty' });
  } finally { await host.close(); }
  const reopened = new DatabaseSync(join(directory, 'host.sqlite'));
  try {
    assert.deepEqual(reopened.prepare('SELECT * FROM service_extension_selections ORDER BY revision').all().map(row => ({ ...row })),
      golden.tables.find(table => table.name === 'service_extension_selections').rows);
    assert.equal(reopened.prepare('SELECT version FROM service_extension_selection_schema').get().version, 1);
  } finally { reopened.close(); }
});

for (const kind of ['transient', 'durable-artifacts']) test(`${kind} startup observes saved providers once and settled boot verifies each artifact once`, async t => {
  const runtime = await packagedHost(t), f = await fixture(t, runtime);
  const options = { ...f.options, extensions: { kind, entries: [f.selected(f.first, 'artifact-a')] } };
  let host = await runtime.startBrowserHost(options);
  const metadata = (await api(host)({ op: 'metadata' })).value;
  const scope = { hostId: host.hostId, conversationId: 'saved-observation' };
  assert.deepEqual((await api(host)({ op: 'create', scope, agentId: metadata.defaultAgentId })).value, scope);
  assert.equal(f.count(f.state.modules[0], 'snapshot'), 1);
  await host.close();
  const original = fs.readFile, reads = [];
  const mock = t.mock.method(fs, 'readFile', async (path, ...args) => {
    if (String(path).startsWith(f.first.directory + '/')) reads.push(String(path).slice(f.first.directory.length + 1));
    return original(path, ...args);
  });
  syncBuiltinESMExports();
  try {
    host = await runtime.startBrowserHost(options);
    assert.deepEqual(reads.sort(), ['customization.json', 'entries.mjs', 'probe.mjs']);
    assert.equal(f.count(f.state.modules.at(-1), 'observe'), 1);
    if (kind === 'transient') {
      assert.equal((await host.replaceProviderExtensions(options.extensions.entries)).kind, 'replaced');
      assert.equal(f.count(f.state.modules.at(-1), 'observe'), 1);
    } else {
      await host.close();
      const imports = f.state.modules.length, observations = f.state.events.filter(value => value.endsWith(':observe')).length;
      reads.length = 0;
      const entries = options.extensions.entries.map(entry => ({ ...entry, installations: entry.installations.map(grant => ({ ...grant,
        authentication: { ...grant.authentication, revision: 'changed' } })) }));
      host = await runtime.startBrowserHost({ ...options, extensions: { kind, entries } });
      const status = await requestControl(join(options.directory, 'control.sock'), { op: 'extensions-status', id: null });
      assert.equal(status.value.desired.outcome.kind, 'grant-mismatch');
      assert.deepEqual(reads, []); assert.equal(f.state.modules.length, imports);
      assert.equal(f.state.events.filter(value => value.endsWith(':observe')).length, observations);
      await requestControl(join(options.directory, 'control.sock'), { op: 'extensions-select', command: {
        id: 'disable', expectedRevision: 0, selection: { version: 1, artifacts: [] },
      } });
      await host.close();
      host = await runtime.startBrowserHost({ ...options, extensions: { kind, entries } });
      assert.deepEqual(reads, []); assert.equal(f.state.modules.length, imports);
      assert.equal(f.state.events.filter(value => value.endsWith(':observe')).length, observations);
      assert.equal((await requestControl(join(options.directory, 'control.sock'), { op: 'extensions-status', id: null })).value.runtime.kind, 'applied-empty');
    }
  } finally { mock.mock.restore(); syncBuiltinESMExports(); await host.close(); }
});

test('active provider work defers a candidate before real artifact reads or imports', async t => {
  const runtime = await packagedHost(t), f = await fixture(t, runtime);
  const host = await runtime.startBrowserHost({ ...f.options, extensions: { kind: 'transient', entries: [f.selected(f.first, 'artifact-a')] } });
  const entered = Promise.withResolvers(), finish = Promise.withResolvers();
  f.state.hooks['artifact-a'] = { async discover() { entered.resolve(); await finish.promise; } };
  const discovery = host.discoverProviders();
  await entered.promise;
  const original = fs.readFile, reads = [];
  const mock = t.mock.method(fs, 'readFile', async (path, ...args) => {
    if (String(path).startsWith(f.second.directory + '/')) reads.push(String(path));
    return original(path, ...args);
  });
  syncBuiltinESMExports();
  try {
    assert.deepEqual(await host.replaceProviderExtensions([f.selected(f.second, 'artifact-b')]), { kind: 'deferred', reason: 'active-work' });
    assert.deepEqual(reads, []); assert.equal(f.state.modules.length, 1);
  } finally { mock.mock.restore(); syncBuiltinESMExports(); finish.resolve(); await discovery; await host.close(); }
});

test('durable extensions preserve native model discovery, default choice and stored native drivers', async t => {
  const runtime = await packagedHost(t), f = await fixture(t, runtime);
  const executable = join(f.root, 'codex'), log = join(f.root, 'native-rpc.jsonl');
  const fixtureUrl = new URL('../fixtures/codex-agent.mjs', import.meta.url).href;
  await fs.writeFile(executable, `#!${process.execPath}
    if (process.argv.includes('--version')) {
      process.stdout.write(${JSON.stringify(`codex-cli ${CODEX_RUNTIME.version}\n`)});
    } else {
      process.argv = [process.execPath, ${JSON.stringify(fixtureUrl)}, ${JSON.stringify(log)}];
      await import(${JSON.stringify(fixtureUrl)});
    }
  `, { mode: 0o700 });
  const options = { ...f.options, agentStartup: { kind: 'configured', configuration: { default: 'native', agents: [
    { name: 'native', kind: 'codex', cwd: f.root, executable },
  ] } }, extensions: { kind: 'durable-artifacts', entries: [f.selected(f.first, 'artifact-a')] } };
  const host = await runtime.startBrowserHost(options);
  try {
    const metadata = (await api(host)({ op: 'metadata' })).value;
    const native = metadata.agents.find(agent => agent.id === metadata.defaultAgentId);
    assert.equal(native.model.id, 'gpt-9.1-astra'); assert.equal(native.availability.kind, 'ready');
    assert.ok(metadata.agents.some(agent => agent.kind === 'provider' && agent.availability.kind === 'ready'));
    const scope = { hostId: host.hostId, conversationId: 'native-default' };
    assert.deepEqual((await api(host)({ op: 'create', scope, agentId: native.id })).value, scope);
    const sent = await api(host)({ op: 'submit', command: { version: 1, scope, clientCommandId: 'native-send', body: { kind: 'send', text: 'hello' } } });
    assert.equal(sent.ok, true); assert.equal(sent.value.kind, 'receipt');
    const messages = (await fs.readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.ok(messages.some(message => message.method === 'model/list'));
    assert.ok(messages.some(message => message.method === 'turn/start'));
  } finally { await host.close(); }
});
