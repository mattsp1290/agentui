import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { secretResolver } from '@agentui/host';
import { openAccessDatabase } from '../../apps/host/build/tsc/access-database.js';
import { Access } from '../../apps/host/build/tsc/access.js';
import { createProviderAuthority } from '../../apps/host/build/tsc/provider-credentials.js';

const instance = { namespace: 'example-crew', installationId: 'personal', generation: '1', protocolVersion: 'v1' };
const service = 'http://127.0.0.1:12345';
const secret = 'PRIVATE_PROVIDER_SENTINEL_71';
const installation = { expectedAuthority: 'remote-provider', id: 'service', instance, service, authentication: { kind: 'secret', revision: 'revision-1', resolve: async () => secret } };
function database(t) {
  const directory = mkdtempSync(join(tmpdir(), 'agentui-provider-credentials-'));
  const path = join(directory, 'host.sqlite');
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return { path, state: openAccessDatabase(path) };
}

test('opaque provider grants persist with complete bindings', async t => {
  const { path, state } = database(t), access = new Access(state);
  let authority = createProviderAuthority(state, instance.namespace, [installation]);
  const { credential } = authority.issue('service', instance);
  assert.equal(await authority.credentials.use({ credential, service }, async value => value === secret), true);
  const grant = state.database.prepare('SELECT * FROM service_provider_credentials').get();
  assert.deepEqual({ ...grant }, { handle: credential.opaqueHandle, host: state.hostId, namespace: instance.namespace,
    contribution: 'service', installation: instance.installationId, generation: '1', protocol: 'v1', service, revision: 'revision-1', revoked: 0 });
  assert.doesNotMatch(JSON.stringify(grant), /PRIVATE_PROVIDER_SENTINEL/);
  await authority.close(); access.close();
  assert.equal(readFileSync(path).includes(Buffer.from(secret)), false);
  const reopened = openAccessDatabase(path), reopenedAccess = new Access(reopened);
  t.after(() => reopenedAccess.close());
  authority = createProviderAuthority(reopened, instance.namespace, [installation]);
  t.after(() => authority.close());
  assert.equal(authority.issue('service', instance).credential.opaqueHandle, credential.opaqueHandle);
  const revised = createProviderAuthority(reopened, instance.namespace, [{ ...installation, authentication: { ...installation.authentication, revision: 'revision-2' } }]);
  await assert.rejects(revised.credentials.use({ credential, service }, async () => assert.fail('stale revision reached action')), /^Error: Provider credential use refused$/);
  await revised.close();
  authority.revoke(credential.opaqueHandle);
  assert.throws(() => authority.issue('service', instance), /authorization refused/);
  await assert.rejects(authority.credentials.use({ credential, service }, async () => assert.fail('revoked reached action')), /credential use refused/);
});

test('host, namespace, contribution, full instance, service and revision are checked before secret effects', async t => {
  const { state } = database(t);
  t.after(() => state.database.close());
  let resolves = 0, actions = 0;
  const authority = createProviderAuthority(state, instance.namespace, [{ ...installation,
    authentication: { ...installation.authentication, async resolve() { resolves++; return secret; } } }]);
  t.after(() => authority.close());
  const { credential } = authority.issue('service', instance);
  const action = async () => { actions++; };
  for (const foreign of [
    { ...credential, hostId: 'foreign' }, { ...credential, kind: 'device-token' }, { ...credential, opaqueHandle: 'foreign' },
    ...['namespace', 'installationId', 'generation', 'protocolVersion'].map(field => ({ ...credential, instance: { ...instance, [field]: 'foreign' } })),
  ]) await assert.rejects(authority.credentials.use({ credential: foreign, service }, action), /credential use refused/);
  for (const foreign of ['http://127.0.0.1:12346', `${service}/other`, `${service}?token=${secret}`, 'http://secret@example.com']) {
    await assert.rejects(authority.credentials.use({ credential, service: foreign }, action), /^Error: Provider credential use refused$/);
  }
  for (const field of ['host', 'namespace', 'contribution', 'installation', 'generation', 'protocol', 'service', 'revision']) {
    const previous = state.database.prepare(`SELECT ${field} AS value FROM service_provider_credentials`).get().value;
    state.database.prepare(`UPDATE service_provider_credentials SET ${field}=?`).run('foreign');
    await assert.rejects(authority.credentials.use({ credential, service }, action), /credential use refused/);
    state.database.prepare(`UPDATE service_provider_credentials SET ${field}=?`).run(previous);
  }
  const other = createProviderAuthority(state, instance.namespace, [{ ...installation, id: 'other' }]);
  await assert.rejects(other.credentials.use({ credential, service }, action), /credential use refused/);
  await other.close();
  assert.equal(resolves, 0); assert.equal(actions, 0);
  const missing = createProviderAuthority(state, instance.namespace, []);
  assert.throws(() => missing.issue('service', instance), /authorization refused/);
  await missing.close();
  const publicService = createProviderAuthority(state, instance.namespace, [{ ...installation, authentication: { kind: 'unauthenticated' } }]);
  assert.equal(publicService.issue('service', instance).credential, null);
  await publicService.close();
  for (const malformed of [{ ...installation, service: secret }, { ...installation, authentication: { kind: 'unknown' } }]) {
    assert.throws(() => createProviderAuthority(state, instance.namespace, [malformed]), /^Error: Provider authorization refused$/);
  }
});

test('revocation during resolution prevents action; close drains admitted uses and discards late results', async t => {
  const { state } = database(t);
  t.after(() => state.database.close());
  const resolving = Promise.withResolvers();
  const authority = createProviderAuthority(state, instance.namespace, [{ ...installation,
    authentication: { ...installation.authentication, resolve: () => resolving.promise } }]);
  const { credential } = authority.issue('service', instance);
  const use = authority.credentials.use({ credential, service }, async () => assert.fail('revoked resolution invoked action'));
  const rejected = assert.rejects(use, /^Error: Provider credential use refused$/);
  await new Promise(resolve => setImmediate(resolve));
  authority.revoke(credential.opaqueHandle);
  resolving.resolve(secret);
  await rejected; await authority.close();
  const second = createProviderAuthority(state, instance.namespace, [{ ...installation,
    authentication: { ...installation.authentication, revision: 'revision-2' } }]);
  const next = second.issue('service', instance).credential;
  const entered = Promise.withResolvers(), finish = Promise.withResolvers();
  const running = second.credentials.use({ credential: next, service }, async () => { entered.resolve(); return finish.promise; });
  const late = assert.rejects(running, /^Error: Provider credential use refused$/);
  await entered.promise;
  let closed = false;
  const closing = second.close().then(() => { closed = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(closed, false);
  await assert.rejects(second.credentials.use({ credential: next, service }, async () => assert.fail('closed action')), /credential use refused/);
  finish.resolve('late result');
  await late; await closing;
  assert.equal(state.database.prepare('SELECT 1 AS value').get().value, 1, 'authority does not close borrowed database');
});

test('resolver and callback failures never expose private exception text', async t => {
  const { state } = database(t);
  t.after(() => state.database.close());
  for (const resolverFails of [true, false]) {
    const authority = createProviderAuthority(state, instance.namespace, [{ ...installation,
      authentication: { ...installation.authentication, async resolve() { if (resolverFails) throw new Error(secret); return secret; } } }]);
    const credential = authority.issue('service', instance).credential;
    await assert.rejects(authority.credentials.use({ credential, service }, async () => { throw new Error(secret); }), error => {
      assert.equal(error.message, 'Provider credential use refused'); assert.equal(error.cause, undefined); return true;
    });
    await authority.close();
  }
});

test('custom secret providers resolve current values only for admitted authority uses without persisting material', async t => {
  const { path, state } = database(t);
  const reference = 'production/crew/api-key';
  const values = new Map([[reference, secret]]);
  let reads = 0;
  const provider = { async resolve(key) { reads++; return values.get(key); } };
  const authority = createProviderAuthority(state, instance.namespace, [{ ...installation,
    authentication: { kind: 'secret', revision: 'provider-selection-1', resolve: secretResolver({ provider, reference }) } }]);
  const credential = authority.issue('service', instance).credential;
  assert.equal(reads, 0, 'issuing a grant does not read the backend');
  assert.equal(await authority.credentials.use({ credential, service }, async value => value), secret);
  const rotated = `${secret}_ROTATED`;
  values.set(reference, rotated);
  assert.equal(await authority.credentials.use({ credential, service }, async value => value), rotated);
  assert.equal(reads, 2, 'each admitted use reads the selected provider again');
  authority.revoke(credential.opaqueHandle);
  await assert.rejects(authority.credentials.use({ credential, service }, async () => assert.fail('revoked use reached action')), /credential use refused/);
  assert.equal(reads, 2, 'revocation prevents backend reads');
  const grant = state.database.prepare('SELECT * FROM service_provider_credentials').get();
  assert.equal(grant.revision, 'provider-selection-1', 'backend rotation does not rewrite the admitted credential revision');
  await authority.close();
  state.database.close();
  const databaseBytes = readFileSync(path);
  for (const material of [reference, secret, rotated]) assert.equal(databaseBytes.includes(Buffer.from(material)), false);
});

test('secret-provider failures and malformed material cannot reach actions or leak backend errors', async t => {
  const { state } = database(t);
  t.after(() => state.database.close());
  for (const invalid of [undefined, null, '', ' \n\t', 42, { value: secret }]) {
    let actions = 0;
    const resolve = secretResolver({ provider: { resolve: async () => invalid }, reference: 'api-key' });
    await assert.rejects(resolve(), { message: 'Secret resolution refused' });
    const authority = createProviderAuthority(state, instance.namespace, [{ ...installation,
      authentication: { ...installation.authentication, resolve } }]);
    const credential = authority.issue('service', instance).credential;
    await assert.rejects(authority.credentials.use({ credential, service }, async () => { actions++; }), /^Error: Provider credential use refused$/);
    assert.equal(actions, 0);
    await authority.close();
  }
  const resolve = secretResolver({ provider: { async resolve() { throw new Error(secret, { cause: secret }); } }, reference: 'api-key' });
  await assert.rejects(resolve(), error => {
    assert.equal(error.message, 'Secret resolution refused');
    assert.equal(error.cause, undefined);
    assert.equal(JSON.stringify(error).includes(secret), false);
    return true;
  });
  for (const reference of ['', '  ', undefined, 23]) {
    assert.throws(() => secretResolver({ provider: { resolve: async () => secret }, reference }), /^Error: Secret resolution refused$/);
  }
});

test('secret-provider reads retain authority revocation and close-drain behavior', async t => {
  const { state } = database(t);
  t.after(() => state.database.close());
  for (const closing of [false, true]) {
    const entered = Promise.withResolvers(), material = Promise.withResolvers();
    const provider = { async resolve() { entered.resolve(); return material.promise; } };
    const authority = createProviderAuthority(state, instance.namespace, [{ ...installation,
      authentication: { kind: 'secret', revision: `read-${closing}`, resolve: secretResolver({ provider, reference: 'api-key' }) } }]);
    const credential = authority.issue('service', instance).credential;
    const use = authority.credentials.use({ credential, service }, async () => assert.fail('retired read reached action'));
    const rejected = assert.rejects(use, /^Error: Provider credential use refused$/);
    await entered.promise;
    let drained = false;
    const done = closing ? authority.close().then(() => { drained = true; }) : Promise.resolve();
    if (!closing) authority.revoke(credential.opaqueHandle);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(drained, false);
    material.resolve(secret);
    await rejected;
    await done;
    assert.equal(drained, closing);
    await authority.close();
  }
});
