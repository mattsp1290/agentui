import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { EXTENSION_SDK_VERSION } from '@agentui/sdk';
import { takeServerExtensionConfiguration } from '../../apps/host/build/tsc/server-extension-config.js';
import { createProviderAuthority } from '../../apps/host/build/tsc/provider-credentials.js';
import { openAccessDatabase } from '../../apps/host/build/tsc/access-database.js';

const secret = '  PRIVATE_CONFIG_SECRET_673\n';
const instance = { namespace: 'example-crew', installationId: 'personal', generation: '1', protocolVersion: 'v1' };
const grant = () => ({ id: 'service', instance: { ...instance }, service: 'https://EXAMPLE.com:443/', expectedAuthority: 'remote-provider',
  authentication: { kind: 'environment', variable: 'AGENTUI_EXTENSION_CREW_TOKEN', revision: 'first' } });
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'agentui-extension-config-'));
  const installed = join(directory, 'installed'); mkdirSync(installed);
  const config = join(directory, 'extensions.json'), packagePath = join(installed, 'package.json');
  const manifest = { namespace: instance.namespace, trust: 'full', sdkVersion: EXTENSION_SDK_VERSION, entries: [{ kind: 'server', module: './server.mjs' }] };
  const metadata = { name: '@example/crew', exports: './ignored.js', agentui: { sources: ['ignored'], extension: manifest } };
  const input = { version: 1, extensions: [{ directory: './installed', installations: [grant()] }] };
  const environment = { AGENTUI_EXTENSION_CREW_TOKEN: secret, AGENTUI_EXTENSION_UNSELECTED: 'unselected', PATH: '/native/path', OPENCODE_GO_API_KEY: 'native-key' };
  const read = (values = environment) => {
    writeFileSync(packagePath, JSON.stringify(metadata)); writeFileSync(config, JSON.stringify(input));
    return takeServerExtensionConfiguration(config, values);
  };
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return { directory, installed, config, packagePath, manifest, metadata, input, environment, read };
}
function invalid(action) {
  assert.throws(action, error => {
    assert.equal(error.message, 'Invalid server extension configuration');
    assert.equal(error.cause, undefined);
    assert.doesNotMatch(String(error.stack), /PRIVATE_CONFIG_SECRET|AGENTUI_EXTENSION_CREW_TOKEN|installed\/package/);
    return true;
  });
}

test('compiled consumer resolves package metadata from the config directory and captures secret bytes for the existing authority', async t => {
  const f = fixture(t), [selection] = f.read();
  assert.equal(selection.kind, 'installed'); assert.equal(selection.directory, f.installed);
  assert.deepEqual(selection.manifest, f.manifest);
  assert.equal(selection.installations[0].service, 'https://example.com');
  assert.doesNotMatch(JSON.stringify(selection), /PRIVATE_CONFIG_SECRET|AGENTUI_EXTENSION_CREW_TOKEN|sources|ignored/);
  assert.deepEqual(f.environment, { AGENTUI_EXTENSION_UNSELECTED: 'unselected', PATH: '/native/path', OPENCODE_GO_API_KEY: 'native-key' });
  f.environment.AGENTUI_EXTENSION_CREW_TOKEN = 'changed'; delete f.environment.AGENTUI_EXTENSION_CREW_TOKEN;
  assert.equal(await selection.installations[0].authentication.resolve(), secret);
  const state = openAccessDatabase(join(f.directory, 'host.sqlite'));
  const authority = createProviderAuthority(state, instance.namespace, selection.installations);
  const { credential } = authority.issue('service', instance);
  assert.equal(await authority.credentials.use({ credential, service: 'https://example.com' }, async value => value), secret);
  assert.doesNotMatch(JSON.stringify(state.database.prepare('SELECT * FROM service_provider_credentials').all()), /PRIVATE_CONFIG_SECRET|AGENTUI_EXTENSION_CREW_TOKEN/);
  await authority.close(); state.database.close();
  assert.equal(readFileSync(join(f.directory, 'host.sqlite')).includes(Buffer.from(secret)), false);
});

test('shared variables are consumed once after all grants capture their exact bytes', async t => {
  const f = fixture(t), second = grant();
  second.id = 'other'; second.instance.installationId = 'other';
  f.input.extensions[0].installations.push(second);
  const [selection] = f.read();
  assert.equal(Object.hasOwn(f.environment, 'AGENTUI_EXTENSION_CREW_TOKEN'), false);
  for (const installation of selection.installations) assert.equal(await installation.authentication.resolve(), secret);
});

for (const [name, change] of [
  ['missing second credential', f => {
    const second = grant(); second.id = 'other'; second.instance.installationId = 'other';
    second.authentication.variable = 'AGENTUI_EXTENSION_MISSING'; f.input.extensions[0].installations.push(second);
  }],
  ['invalid second grant', f => {
    const second = grant(); second.id = 'other'; second.instance.installationId = 'other';
    second.service = 'https://example.com/path'; f.input.extensions[0].installations.push(second);
  }],
  ['duplicate normalized identity', f => {
    const second = grant(); second.id = 'other'; f.input.extensions[0].installations.push(second);
  }],
  ['duplicate second namespace', f => { f.input.extensions.push(structuredClone(f.input.extensions[0])); }],
  ['missing second package', f => { f.input.extensions.push({ directory: './missing', installations: [] }); }],
  ['invalid second manifest', f => {
    const directory = join(f.directory, 'second'); mkdirSync(directory);
    writeFileSync(join(directory, 'package.json'), JSON.stringify({ agentui: { extension: { ...f.manifest, sdkVersion: '99.0.0' } } }));
    f.input.extensions.push({ directory: './second', installations: [] });
  }],
]) test(`later ${name} leaves every environment value unchanged`, t => {
  const f = fixture(t); change(f); const before = { ...f.environment };
  invalid(f.read); assert.deepEqual(f.environment, before);
});

for (const variable of ['PATH', 'HOME', 'OPENCODE_GO_API_KEY', 'AGENTUI_ANTHROPIC_API_KEY', 'OTEL_EXPORTER_OTLP_HEADERS',
  'CREW_TOKEN', 'AGENTUI_EXTENSION_', 'AGENTUI_EXTENSION_bad-name', 'AGENTUI_EXTENSION_bad\n']) {
  test(`consumer refuses reserved or malformed variable ${JSON.stringify(variable)} without mutation`, t => {
    const f = fixture(t); f.input.extensions[0].installations[0].authentication.variable = variable;
    f.environment[variable] = secret; const before = { ...f.environment };
    invalid(f.read); assert.deepEqual(f.environment, before);
  });
}

test('selection supports empty arrays, absolute directories, unauthenticated grants and config symlinks relative to the supplied path', t => {
  const f = fixture(t);
  f.input.extensions[0].directory = f.installed;
  f.input.extensions[0].installations[0].authentication = { kind: 'unauthenticated' };
  assert.deepEqual(f.read()[0].installations[0].authentication, { kind: 'unauthenticated' });
  f.input.extensions[0].installations = []; assert.deepEqual(f.read()[0].installations, []);
  f.input.extensions = []; assert.deepEqual(f.read(), []);
  f.input.extensions = [{ directory: './installed', installations: [] }]; f.read();
  const elsewhere = join(f.directory, 'elsewhere'); mkdirSync(elsewhere);
  const target = join(elsewhere, 'target.json'); writeFileSync(target, JSON.stringify(f.input));
  const link = join(f.directory, 'linked.json'); symlinkSync(target, link);
  assert.equal(takeServerExtensionConfiguration(link, {})[0].directory, f.installed);
});

for (const [name, change] of [
  ['root extra field', f => { f.input.secret = secret; }],
  ['missing root field', f => { delete f.input.version; }],
  ['unknown version', f => { f.input.version = 2; }],
  ['string version', f => { f.input.version = '1'; }],
  ['non-array selection', f => { f.input.extensions = {}; }],
  ['entry extra field', f => { f.input.extensions[0].manifest = f.manifest; }],
  ['missing directory', f => { delete f.input.extensions[0].directory; }],
  ['blank directory', f => { f.input.extensions[0].directory = ' '; }],
  ['unbounded directory', f => { f.input.extensions[0].directory = 'x'.repeat(1025); }],
  ['non-array grants', f => { f.input.extensions[0].installations = {}; }],
  ['missing package manifest', f => { delete f.metadata.agentui.extension; }],
  ['compiled catalog metadata', f => { delete f.metadata.agentui; f.metadata.entries = []; }],
  ['manifest extra field', f => { f.manifest.secret = secret; }],
  ['manifest blank namespace', f => { f.manifest.namespace = ' '; }],
  ['manifest namespace syntax', f => { f.manifest.namespace = 'UPPER'; }],
  ['manifest trust', f => { f.manifest.trust = 'partial'; }],
  ['manifest SDK', f => { f.manifest.sdkVersion = '99.0.0'; }],
  ['missing server declaration', f => { f.manifest.entries[0].kind = 'desktop'; }],
  ['empty declarations', f => { f.manifest.entries = []; }],
  ['duplicate entry kinds', f => { f.manifest.entries.push({ ...f.manifest.entries[0] }); }],
  ['entry extra field', f => { f.manifest.entries[0].secret = secret; }],
  ['module traversal', f => { f.manifest.entries[0].module = './../server.mjs'; }],
  ['duplicate namespaces', f => { f.input.extensions.push(structuredClone(f.input.extensions[0])); }],
  ['grant extra field', f => { f.input.extensions[0].installations[0].secret = secret; }],
  ['missing grant field', f => { delete f.input.extensions[0].installations[0].service; }],
  ['blank grant ID', f => { f.input.extensions[0].installations[0].id = ' '; }],
  ['unbounded grant ID', f => { f.input.extensions[0].installations[0].id = 'x'.repeat(1025); }],
  ['unknown authority', f => { f.input.extensions[0].installations[0].expectedAuthority = 'browser'; }],
  ['identity namespace mismatch', f => { f.input.extensions[0].installations[0].instance.namespace = 'other'; }],
  ['identity extra field', f => { f.input.extensions[0].installations[0].instance.secret = secret; }],
  ['duplicate grant IDs', f => { const a = structuredClone(f.input.extensions[0].installations[0]); a.instance.generation = '2'; f.input.extensions[0].installations.push(a); }],
  ['duplicate full identities', f => { const a = structuredClone(f.input.extensions[0].installations[0]); a.id = 'other'; f.input.extensions[0].installations.push(a); }],
  ['literal secret', f => { f.input.extensions[0].installations[0].authentication = { kind: 'secret', value: secret, revision: '1' }; }],
  ['unknown authentication', f => { f.input.extensions[0].installations[0].authentication.kind = 'unknown'; }],
  ['unauthenticated extra field', f => { f.input.extensions[0].installations[0].authentication = { kind: 'unauthenticated', revision: '1' }; }],
  ['environment extra field', f => { f.input.extensions[0].installations[0].authentication.value = secret; }],
  ['missing revision', f => { delete f.input.extensions[0].installations[0].authentication.revision; }],
  ['blank revision', f => { f.input.extensions[0].installations[0].authentication.revision = ' '; }],
  ['unbounded revision', f => { f.input.extensions[0].installations[0].authentication.revision = 'x'.repeat(1025); }],
  ...['', '1TOKEN', 'CREW-TOKEN', ' TOKEN', 'TOKEN\n', 'AGENTUI_EXTENSION_' + 'x'.repeat(1025)].map(variable => ['invalid environment variable', f => { f.input.extensions[0].installations[0].authentication.variable = variable; }]),
  ...[undefined, '', ' \t\n', 42].map(value => ['absent or blank environment value', f => { f.environment.AGENTUI_EXTENSION_CREW_TOKEN = value; }]),
  ...['namespace', 'installationId', 'generation', 'protocolVersion'].flatMap(field => [
    ['blank identity field', f => { f.input.extensions[0].installations[0].instance[field] = ' '; }],
    ['missing identity field', f => { delete f.input.extensions[0].installations[0].instance[field]; }],
    ['unbounded identity field', f => { f.input.extensions[0].installations[0].instance[field] = 'x'.repeat(1025); }],
  ]),
  ...['invalid', 'file:///tmp/secret', 'ftp://example.com', 'https://user:secret@example.com', 'https://example.com/path', 'https://example.com?secret=x', 'https://example.com#secret'].map(service => ['invalid service origin', f => { f.input.extensions[0].installations[0].service = service; }]),
]) test(`consumer refuses ${name} with fixed private diagnostics`, t => {
  const f = fixture(t); change(f); const before = { ...f.environment };
  invalid(f.read); assert.deepEqual(f.environment, before);
});

test('missing files and malformed secret-bearing selection or package JSON never expose underlying diagnostics', t => {
  const f = fixture(t); invalid(() => takeServerExtensionConfiguration(f.config, f.environment));
  f.read({ ...f.environment }); rmSync(f.packagePath); invalid(() => takeServerExtensionConfiguration(f.config, f.environment));
  for (const path of [f.config, f.packagePath]) {
    f.read({ ...f.environment }); writeFileSync(path, `{"${secret.trim()}":`);
    invalid(() => takeServerExtensionConfiguration(f.config, f.environment));
  }
});
