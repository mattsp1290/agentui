import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import test from 'node:test';
import { ownDirectory } from '../../../apps/host/build/tsc/ownership.js';
import { entry, listenerLog, options, secret, service, settledStatus, startBrowserHost, turn } from './fixtures.mjs';

function credentialCount(directory) {
  const database = new DatabaseSync(join(directory, 'host.sqlite'));
  try { return database.prepare('SELECT count(*) AS count FROM service_provider_credentials').get().count; }
  finally { database.close(); }
}
const failed = (failure, recovery = 'replace') => ({ kind: 'failed', failure, recovery });

test('real host defers credential-backed discovery, imports only on retry, and disables without remote commands', { timeout: 5000 }, async t => {
  const entered = Promise.withResolvers(), finish = Promise.withResolvers(), listeners = listenerLog();
  const old = entry(t, { label: 'old', listeners, async discover(fixture) {
    if (fixture.calls.discover > 1) { entered.resolve(); await finish.promise; }
  } });
  const next = entry(t, { label: 'next', listeners }), configured = options(t);
  let provisioned = 0;
  const installations = next.value.installations;
  Object.defineProperty(next.value, 'installations', { get() { provisioned++; return installations; } });
  const host = await startBrowserHost({ agentStartup: { kind: 'recorded' }, ...configured, providerExtensions: [old.value] });
  try {
    assert.deepEqual(host.extensionStatus(), { kind: 'active', generation: 1, pending: 0 });
    listeners.emitter.emit('update');
    const discovery = host.discoverProviders(); await entered.promise;
    assert.equal(host.extensionStatus().pending, 1);
    assert.deepEqual(await host.replaceProviderExtensions([next.value]), { kind: 'deferred', reason: 'active-work' });
    assert.equal(next.calls.import, 0); assert.equal(old.calls.dispose, 0); assert.equal(old.calls.close, 0);
    assert.equal(credentialCount(configured.directory), 1); assert.equal(provisioned, 0);
    const overlapping = host.discoverProviders();
    assert.equal(host.extensionStatus().pending, 2);
    finish.resolve();
    for (const result of await Promise.all([discovery, overlapping])) assert.equal(result[0].agents[0].name, 'old');
    assert.deepEqual(await host.replaceProviderExtensions([next.value]), { kind: 'replaced', generation: 2 });
    assert.equal((await host.discoverProviders())[0].agents[0].name, 'next');
    assert.equal(next.calls.import, 1); assert.equal(next.calls.activate, 1); assert.equal(old.calls.dispose, 1);
    listeners.emitter.emit('update');
    assert.deepEqual(listeners.deliveries, ['old', 'next']);
    assert.equal(listeners.emitter.listenerCount('update'), 1);
    assert.ok(listeners.events.indexOf('old:dispose-end') < listeners.events.indexOf('next:import'));
    assert.equal(listeners.maximum, 1);
    assert.deepEqual(await host.replaceProviderExtensions([]), { kind: 'replaced', generation: null });
    assert.deepEqual(host.extensionStatus(), { kind: 'empty' });
    assert.deepEqual(await host.discoverProviders(), []);
    assert.equal(listeners.active, 0); assert.equal(next.calls.dispose, 1);
    await assert.rejects(next.context.credentials.use({ credential: next.credential, service }, async () => secret), /credential use refused/);
    listeners.emitter.emit('update'); assert.deepEqual(listeners.deliveries, ['old', 'next']);
    assert.equal(old.calls.commands + next.calls.commands, 0);
  } finally { finish.resolve(); await host.close(); }
  assert.equal(host.close(), host.close());
  await host.close(); ownDirectory(configured.directory).close();
});

test('explicit installed kind imports its declared module even when an entry property is present', async t => {
  const fixture = entry(t);
  Object.defineProperty(fixture.value, 'entry', { get() { return assert.fail('installed entry property was inspected'); } });
  const host = await startBrowserHost({ agentStartup: { kind: 'recorded' }, ...options(t), providerExtensions: [fixture.value] });
  try {
    assert.equal(fixture.calls.import, 1);
    assert.equal(fixture.calls.activate, 1);
    assert.equal((await host.discoverProviders())[0].agents[0].name, 'entry');
  } finally { await host.close(); }
  assert.equal(fixture.calls.dispose, 1);
});

test('competing replacements defer and host refresh discovery retains its activation', { timeout: 5000 }, async t => {
  const entered = Promise.withResolvers(), finish = Promise.withResolvers(), listeners = listenerLog();
  const old = entry(t, { label: 'old', listeners, async dispose() { entered.resolve(); await finish.promise; } });
  const next = entry(t, { label: 'next', listeners }), stale = entry(t, { label: 'stale', listeners });
  const host = await startBrowserHost({ agentStartup: { kind: 'recorded' }, ...options(t), providerExtensions: [old.importedValue] });
  try {
    await host.discoverProviders(); await host.discoverProviders();
    assert.equal(old.calls.activate, 1); assert.equal(old.calls.connect, 1);
    const replacing = host.replaceProviderExtensions([next.value]);
    await entered.promise;
    assert.equal(host.extensionStatus().kind, 'changing');
    await assert.rejects(host.discoverProviders(), /discovery unavailable/);
    assert.deepEqual(await host.replaceProviderExtensions([stale.value]), { kind: 'deferred', reason: 'changing' });
    assert.equal(next.calls.import + stale.calls.import, 0);
    finish.resolve(); assert.equal((await replacing).kind, 'replaced');
    assert.equal(stale.calls.import, 0); assert.equal(listeners.maximum, 1);
  } finally { finish.resolve(); await host.close(); }
});

for (const phase of ['dispose', 'import', 'activate', 'discover']) {
  test(`close during replacement ${phase} never publishes the candidate and cleans acquired lifetimes once`, { timeout: 5000 }, async t => {
    const entered = Promise.withResolvers(), finish = Promise.withResolvers(), listeners = listenerLog();
    const blocked = async () => { entered.resolve(); await finish.promise; };
    const old = entry(t, { label: 'old', listeners, ...(phase === 'dispose' ? { dispose: blocked } : {}) });
    const next = entry(t, { label: 'next', listeners, ...(phase === 'dispose' ? {} : { [phase]: blocked }) });
    const configured = options(t), host = await startBrowserHost({ agentStartup: { kind: 'recorded' }, ...configured, providerExtensions: [old.value] });
    const replacing = host.replaceProviderExtensions([next.value]); await entered.promise;
    const closing = host.close(); assert.equal(host.close(), closing);
    assert.equal(host.extensionStatus().kind, 'closing');
    assert.deepEqual(await host.replaceProviderExtensions([next.value]), { kind: 'unavailable' });
    finish.resolve(); assert.deepEqual(await replacing, { kind: 'unavailable' }); await closing;
    assert.deepEqual(host.extensionStatus(), { kind: 'closed' });
    assert.equal(old.calls.dispose, 1); assert.equal(old.calls.close, 1);
    assert.equal(next.calls.import, phase === 'dispose' ? 0 : 1);
    assert.equal(next.calls.activate, ['dispose', 'import'].includes(phase) ? 0 : 1);
    assert.equal(next.calls.dispose, next.calls.activate); assert.equal(listeners.active, 0); assert.equal(listeners.maximum, 1);
    ownDirectory(configured.directory).close();
  });
}

for (const cleanupFails of [false, true]) {
  test(`shutdown freezes a blocked candidate before discovery settles with ${cleanupFails ? 'failed' : 'successful'} cleanup`, { timeout: 5000 }, async t => {
    const entered = Promise.withResolvers(), finish = Promise.withResolvers(), configured = options(t);
    const old = entry(t, { label: 'old' });
    const next = entry(t, { label: 'next', async discover() { entered.resolve(); await finish.promise; },
      ...(cleanupFails ? { dispose() { throw new Error(secret); } } : {}) });
    const host = await startBrowserHost({ agentStartup: { kind: 'recorded' }, ...configured, providerExtensions: [old.value] });
    const replacing = host.replaceProviderExtensions([next.value]); await entered.promise;
    const closing = host.close(); assert.equal(host.close(), closing);
    const closed = closing.then(() => null, error => error);
    let actionCalls = 0;
    try {
      await turn();
      assert.deepEqual(host.extensionStatus(), { kind: 'closing' });
      await assert.rejects(next.context.credentials.use({ credential: next.credential, service }, async () => {
        actionCalls++; return secret;
      }), /credential use refused/);
      assert.equal(actionCalls, 0);
      assert.equal(next.calls.close, 0); assert.equal(next.calls.dispose, 0);
    } finally {
      finish.resolve(); await Promise.allSettled([replacing, closed]);
    }
    assert.deepEqual(await replacing, cleanupFails ? failed('cleanup', 'restart') : { kind: 'unavailable' });
    assert.equal(old.calls.close, 1); assert.equal(old.calls.dispose, 1);
    assert.equal(next.calls.close, 1); assert.equal(next.calls.dispose, 1);
    if (cleanupFails) {
      const error = await closed;
      assert.equal(error.message, 'Host shutdown failed'); assert.equal(error.cause.message, 'Provider cleanup failed');
      assert.doesNotMatch(JSON.stringify(error), /PRIVATE_EXTENSION/);
      assert.deepEqual(host.extensionStatus(), failed('cleanup', 'restart'));
      assert.deepEqual(await host.replaceProviderExtensions([]), failed('cleanup', 'restart'));
      await assert.rejects(host.close(), /Host shutdown failed/);
      assert.equal(next.calls.close, 1); assert.equal(next.calls.dispose, 1);
      assert.throws(() => ownDirectory(configured.directory), /Another host owns/);
    } else {
      assert.equal(await closed, null);
      assert.deepEqual(host.extensionStatus(), { kind: 'closed' });
      ownDirectory(configured.directory).close();
    }
  });
}

test('shutdown still freezes credentials and rejects an admitted late discovery', { timeout: 5000 }, async t => {
  const entered = Promise.withResolvers(), finish = Promise.withResolvers();
  const fixture = entry(t, { async discover(value) { if (value.calls.discover > 1) { entered.resolve(); await finish.promise; } } });
  const host = await startBrowserHost({ agentStartup: { kind: 'recorded' }, ...options(t), providerExtensions: [fixture.value] });
  const discovery = assert.rejects(host.discoverProviders(), /^Error: Provider discovery failed$/); await entered.promise;
  const closing = host.close(); await turn();
  await assert.rejects(fixture.context.credentials.use({ credential: fixture.credential, service }, async () => secret), /credential use refused/);
  assert.equal(fixture.calls.close, 0); finish.resolve(); await discovery; await closing;
  assert.equal(fixture.calls.dispose, 1); assert.equal(fixture.calls.close, 1);
});

for (const phase of ['load', 'authorization', 'activation', 'discovery']) {
  test(`explicit replacement recovers from ${phase} failure after cleanup`, { timeout: 5000 }, async t => {
    const listeners = listenerLog(), old = entry(t, { label: 'old', listeners });
    const bad = entry(t, { label: 'bad', listeners, ...(phase === 'activation' ? { activate() { throw new Error(secret); } }
      : phase === 'discovery' ? { discover() { throw new Error(secret); } } : {}) });
    if (phase === 'load') bad.value.manifest.sdkVersion = 'incompatible';
    if (phase === 'authorization') bad.value.installations[0].service = 'invalid service';
    const next = entry(t, { label: 'next', listeners });
    const host = await startBrowserHost({ agentStartup: { kind: 'recorded' }, ...options(t), providerExtensions: [old.value] });
    try {
      assert.deepEqual(await host.replaceProviderExtensions([bad.value]), failed(phase));
      assert.deepEqual(host.extensionStatus(), failed(phase));
      await assert.rejects(host.discoverProviders(), /unavailable/);
      assert.equal(next.calls.import, 0); assert.equal(old.calls.dispose, 1);
      assert.deepEqual(await host.replaceProviderExtensions([next.value]), { kind: 'replaced', generation: phase === 'activation' || phase === 'discovery' ? 3 : 2 });
      assert.equal((await host.discoverProviders())[0].agents[0].name, 'next');
      assert.equal(listeners.maximum, 1);
    } finally { await host.close(); }
  });
}

test('discovery failure observes background cleanup without deadlock and refuses retry until cleanup settles', { timeout: 5000 }, async t => {
  const entered = Promise.withResolvers(), finish = Promise.withResolvers();
  const old = entry(t, { discover(fixture) { if (fixture.calls.discover > 1) throw new Error(secret); },
    async dispose() { entered.resolve(); await finish.promise; } });
  const next = entry(t, { label: 'next' });
  const host = await startBrowserHost({ agentStartup: { kind: 'recorded' }, ...options(t), providerExtensions: [old.value] });
  try {
    await Promise.all([assert.rejects(host.discoverProviders(), /discovery failed/), assert.rejects(host.discoverProviders(), /discovery failed/)]);
    await entered.promise;
    assert.deepEqual(await host.replaceProviderExtensions([next.value]), { kind: 'deferred', reason: 'changing' });
    assert.equal(next.calls.import, 0); finish.resolve();
    assert.deepEqual(await settledStatus(host), failed('discovery'));
    assert.equal((await host.replaceProviderExtensions([next.value])).kind, 'replaced');
    assert.equal(old.calls.dispose, 1); assert.equal(old.calls.close, 1);
  } finally { finish.resolve(); await host.close(); }
});

for (const trigger of ['replacement', 'discovery', 'candidate']) {
  test(`${trigger} cleanup failure requires restart and shutdown retains its failure and directory ownership`, { timeout: 5000 }, async t => {
    const configured = options(t);
    const old = entry(t, { label: 'old',
      ...(trigger === 'candidate' ? {} : { dispose() { throw new Error(secret); } }),
      ...(trigger === 'discovery' ? { discover(value) { if (value.calls.discover > 1) throw new Error(secret); } } : {}) });
    const bad = entry(t, { label: 'bad', discover() { throw new Error(secret); }, dispose() { throw new Error(secret); } });
    const next = entry(t, { label: 'next' });
    const host = await startBrowserHost({ agentStartup: { kind: 'recorded' }, ...configured, providerExtensions: [old.value] });
    if (trigger === 'discovery') {
      await assert.rejects(host.discoverProviders(), /discovery failed/);
      assert.deepEqual(await settledStatus(host), failed('cleanup', 'restart'));
    } else {
      assert.deepEqual(await host.replaceProviderExtensions([trigger === 'candidate' ? bad.value : next.value]), failed('cleanup', 'restart'));
    }
    assert.deepEqual(host.extensionStatus(), failed('cleanup', 'restart'));
    assert.deepEqual(await host.replaceProviderExtensions([next.value]), failed('cleanup', 'restart'));
    assert.equal(next.calls.import, 0);
    const closing = host.close(); assert.equal(host.close(), closing);
    await assert.rejects(closing, error => {
      assert.equal(error.message, 'Host shutdown failed'); assert.equal(error.cause.message, 'Provider cleanup failed');
      assert.doesNotMatch(JSON.stringify(error), /PRIVATE_EXTENSION/); return true;
    });
    await assert.rejects(host.close(), /Host shutdown failed/);
    assert.equal(old.calls.dispose, 1); assert.equal(bad.calls.dispose, trigger === 'candidate' ? 1 : 0);
    assert.deepEqual(host.extensionStatus(), failed('cleanup', 'restart'));
    assert.throws(() => ownDirectory(configured.directory), /Another host owns/);
  });
}

test('mutating replacement results cannot clear cleanup failure while shutdown observes replacement', { timeout: 5000 }, async t => {
  const entered = Promise.withResolvers(), finish = Promise.withResolvers(), configured = options(t);
  const old = entry(t, { async dispose() { entered.resolve(); await finish.promise; throw new Error(secret); } });
  const next = entry(t, { label: 'next' });
  const host = await startBrowserHost({ agentStartup: { kind: 'recorded' }, ...configured, providerExtensions: [old.value] });
  const replacing = host.replaceProviderExtensions([next.value]).then(result => {
    assert.deepEqual(result, failed('cleanup', 'restart'));
    result.failure = 'load'; result.recovery = 'replace';
  });
  await entered.promise;
  const closing = assert.rejects(host.close(), /Host shutdown failed/);
  finish.resolve(); await replacing; await closing;
  const status = host.extensionStatus(); status.failure = 'load'; status.recovery = 'replace';
  assert.deepEqual(await host.replaceProviderExtensions([]), failed('cleanup', 'restart'));
  await assert.rejects(host.close(), /Host shutdown failed/);
  assert.equal(old.calls.dispose, 1); assert.equal(next.calls.import, 0);
  assert.throws(() => ownDirectory(configured.directory), /Another host owns/);
});

test('invalid artifact replacement retires the active generation and reports load failure', async t => {
  const fixture = entry(t), configured = options(t);
  const host = await startBrowserHost({ agentStartup: { kind: 'recorded' }, ...configured, providerExtensions: [fixture.value] });
  try {
    assert.deepEqual(await host.replaceProviderExtensions([{ kind: 'artifact', directory: '/missing', artifactId: '0'.repeat(64), installations: [] }]), failed('load'));
    assert.deepEqual(host.extensionStatus(), failed('load'));
    await assert.rejects(host.discoverProviders(), /unavailable/);
    assert.equal(fixture.calls.close, 1); assert.equal(fixture.calls.dispose, 1);
  } finally { await host.close(); }
});
