import assert from 'node:assert/strict';
import test from 'node:test';
import { createServerExtensions } from '@agentui/host/extensions';
import { join } from 'node:path';
import { openAccessDatabase } from '../../../apps/host/build/tsc/access-database.js';
import { createProviderAuthority } from '../../../apps/host/build/tsc/provider-credentials.js';
import { entry, options, service, turn } from './fixtures.mjs';

test('preparation failure and public outcomes cannot mutate retained restart recovery', async () => {
  const owner = createServerExtensions();
  const failure = { kind: 'failed', failure: 'cleanup', recovery: 'restart' };
  const result = await owner.replace({ async prepare() { return failure; } });
  failure.failure = 'load'; failure.recovery = 'replace';
  result.failure = 'load'; result.recovery = 'replace';
  assert.deepEqual(owner.status(), { kind: 'failed', failure: 'cleanup', recovery: 'restart' });
  assert.deepEqual(await owner.replace({ async prepare() { assert.fail('cleanup failure forbids preparation'); } }),
    { kind: 'failed', failure: 'cleanup', recovery: 'restart' });
  const closing = owner.close(); assert.equal(owner.close(), closing);
  await assert.rejects(closing, /^Error: Provider cleanup failed$/);
});

for (const cleanupFails of [false, true]) {
  test(`owner shutdown shares synchronous authority reentry through ${cleanupFails ? 'failed' : 'successful'} drain`, async t => {
    const fixture = entry(t), configured = options(t), database = openAccessDatabase(join(configured.directory, 'host.sqlite'));
    t.after(() => database.database.close());
    const owner = createServerExtensions(), gate = Promise.withResolvers();
    const { manifest, entry: serverEntry, installations } = fixture.importedValue;
    const authority = createProviderAuthority(database, manifest.namespace, installations), closeAuthority = authority.close;
    let nested, authorityCloses = 0, settled = false;
    authority.close = () => {
      authorityCloses++;
      const drained = closeAuthority();
      nested ??= owner.close();
      assert.throws(() => authority.issue('service', installations[0].instance), /authorization refused/);
      return drained.then(() => gate.promise).then(() => { if (cleanupFails) throw new Error('authority drain failed'); });
    };
    await owner.replace({ async prepare() { return { kind: 'ready', extensions: [{ manifest, entry: serverEntry, authority }] }; } });
    const outer = owner.close(), result = outer.then(() => { settled = true; return null; }, error => { settled = true; return error; });
    try {
      assert.equal(nested, outer);
      assert.equal(owner.close(), outer);
      assert.throws(() => authority.issue('service', installations[0].instance), /authorization refused/);
      await assert.rejects(fixture.context.credentials.use({ credential: fixture.credential, service }, async () => assert.fail('retired credential effect')));
      await turn();
      assert.equal(settled, false);
      assert.deepEqual(owner.status(), { kind: 'closing' });
      assert.equal(authorityCloses, 1); assert.equal(fixture.calls.close, 1); assert.equal(fixture.calls.dispose, 0);
    } finally { gate.resolve(); await Promise.allSettled([outer, nested]); }
    const error = await result;
    assert.equal(authorityCloses, 1); assert.equal(fixture.calls.close, 1); assert.equal(fixture.calls.dispose, 1);
    assert.equal(owner.close(), outer);
    if (cleanupFails) {
      assert.equal(error.message, 'Provider cleanup failed');
      assert.deepEqual(owner.status(), { kind: 'failed', failure: 'cleanup', recovery: 'restart' });
      assert.deepEqual(await owner.replace({ async prepare() { assert.fail('cleanup failure forbids preparation'); } }), owner.status());
      await assert.rejects(owner.close(), value => value === error);
    } else {
      assert.equal(error, null); assert.deepEqual(owner.status(), { kind: 'closed' });
      await owner.close();
    }
    assert.equal(authorityCloses, 1); assert.equal(fixture.calls.close, 1); assert.equal(fixture.calls.dispose, 1);
  });
}
