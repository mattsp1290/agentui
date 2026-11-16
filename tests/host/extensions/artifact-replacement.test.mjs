import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { resigned } from '../../customization/build/server-support.mjs';
import { api, packagedHost, fixture, failed, secret, service } from './artifact-support.mjs';

function resignManifest(mutate) {
  return async (f, candidate) => {
    const manifest = resigned(f.first.manifest, mutate);
    await writeFile(join(f.first.directory, 'customization.json'), JSON.stringify(manifest));
    candidate.artifactId = manifest.artifactId;
    return [candidate];
  };
}

function failPhase(phase) {
  return (f, candidate) => {
    f.state.hooks['artifact-a'] = { [phase]() { throw new Error(secret); } };
    return [candidate];
  };
}

const artifactFailures = [
  { name: 'caller pin', classification: 'load', imported: 0,
    arrange(f, candidate) { candidate.artifactId = '0'.repeat(64); return [candidate]; } },
  { name: 'missing directory', classification: 'load', imported: 0,
    arrange(f, candidate) { candidate.directory = join(f.root, 'missing-artifact'); return [candidate]; } },
  { name: 'bytes', classification: 'load', imported: 0,
    async arrange(f, candidate) {
      await writeFile(join(f.first.directory, 'entries.mjs'), "throw new Error('PRIVATE_TAMPER');");
      return [candidate];
    } },
  { name: 'SDK', classification: 'load', imported: 0, arrange: resignManifest(value => { value.sdkVersion = '99.0.0'; }) },
  { name: 'Node', classification: 'load', imported: 0, arrange: resignManifest(value => { value.runtime.version = '0.0.0'; }) },
  { name: 'modules', classification: 'load', imported: 0, arrange: resignManifest(value => { value.runtime.modules = '0'; }) },
  { name: 'ABI', classification: 'load', imported: 0, arrange: resignManifest(value => { value.runtime.abiIdentity = '0'.repeat(64); }) },
  { name: 'duplicate namespace', classification: 'load', imported: 0, arrange(f, candidate) { return [candidate, candidate]; } },
  { name: 'grant', classification: 'authorization', imported: 0,
    arrange(f, candidate) { candidate.installations[0].service = 'invalid service'; return [candidate]; } },
  { name: 'import', classification: 'load', imported: 1, arrange: failPhase('import') },
  { name: 'activation', classification: 'activation', imported: 1, arrange: failPhase('activate') },
  { name: 'discovery', classification: 'discovery', imported: 1, arrange: failPhase('discover'),
    async assertRetired(f) {
      const bad = f.state.modules[1];
      assert.equal(f.count(bad, 'close'), 1); assert.equal(f.count(bad, 'dispose'), 1);
      await assert.rejects(bad.probe(), /./);
    } },
];

test('packaged server replaces verified artifact generations through its existing owner', { timeout: 120000 }, async t => {
  const runtime = await packagedHost(t);
  await t.test('installed, artifact, same artifact, different artifact, installed and empty selections', async t => {
    const f = await fixture(t, runtime);
    const host = await runtime.startBrowserHost({ ...f.options, providerExtensions: [f.installed] });
    try {
      const old = f.state.modules[0];
      f.state.emitter.emit('update');
      assert.deepEqual(f.state.deliveries, [old.id]);
      assert.deepEqual(await host.replaceProviderExtensions([f.selected(f.first, 'artifact-a')]), { kind: 'replaced', generation: 2 });
      const first = f.state.modules[1];
      f.state.emitter.emit('update');
      assert.deepEqual(f.state.deliveries, [old.id, first.id]);
      assert.equal(first.parser, runtime.sdk.parseExtensionManifest);
      assert.equal((await host.discoverProviders())[0].agents[0].name, 'artifact-a');
      assert.deepEqual(await host.replaceProviderExtensions([f.selected(f.first, 'artifact-a')]), { kind: 'replaced', generation: 3 });
      const same = f.state.modules[2];
      assert.notEqual(first, same);
      assert.notEqual(first.probe, same.probe);
      await assert.rejects(first.probe(), /./);
      assert.deepEqual(await host.replaceProviderExtensions([f.selected(f.second, 'artifact-b')]), { kind: 'replaced', generation: 4 });
      const second = f.state.modules[3];
      assert.equal((await host.discoverProviders())[0].agents[0].name, 'artifact-b');
      await assert.rejects(same.probe(), /./);
      assert.deepEqual(await host.replaceProviderExtensions([f.nextInstalled]), { kind: 'replaced', generation: 5 });
      await assert.rejects(second.probe(), /./);
      assert.deepEqual(await host.replaceProviderExtensions([]), { kind: 'replaced', generation: null });
      assert.deepEqual(host.extensionStatus(), { kind: 'empty' });
      assert.deepEqual(await host.discoverProviders(), []);
      for (const module of [old, first, same, second]) {
        assert.equal(f.count(module, 'import'), 1); assert.equal(f.count(module, 'activate'), 1);
        assert.equal(f.count(module, 'close'), 1); assert.equal(f.count(module, 'dispose'), 1);
        await assert.rejects(module.context.credentials.use({ credential: module.credential, service }, async () => secret), /credential use refused/);
      }
      for (let index = 1; index < f.state.modules.length; index++) {
        const previous = f.state.modules[index - 1], current = f.state.modules[index];
        assert.ok(f.state.events.indexOf(`${previous.label}:${previous.id}:dispose`) < f.state.events.indexOf(`${current.label}:${current.id}:import`));
      }
      assert.equal(f.state.maximum, 1); assert.equal(f.state.emitter.listenerCount('update'), 0);
      assert.deepEqual(f.state.commands, []);
      assert.deepEqual(await host.replaceProviderExtensions([f.selected(f.second, 'artifact-b')]), { kind: 'replaced', generation: 6 });
      const last = f.state.modules.at(-1);
      assert.deepEqual(await host.replaceProviderExtensions([]), { kind: 'replaced', generation: null });
      await assert.rejects(last.probe(), /./);
      assert.equal(f.count(last, 'close'), 1); assert.equal(f.count(last, 'dispose'), 1);
    } finally { await host.close(); }
  });

  await t.test('admitted artifact discovery defers before candidate access and preserves its outcome', async t => {
    const f = await fixture(t, runtime), entered = Promise.withResolvers(), finish = Promise.withResolvers();
    const host = await runtime.startBrowserHost({ ...f.options, providerExtensions: [f.selected(f.first, 'artifact-a')] });
    f.state.hooks['artifact-a'] = { async discover() { entered.resolve(); await finish.promise; } };
    const discovery = host.discoverProviders();
    try {
      await entered.promise;
      let inspected = 0;
      const candidate = f.selected(f.second, 'artifact-b'), installations = candidate.installations;
      Object.defineProperty(candidate, 'installations', { get() { inspected++; return installations; } });
      const before = f.provisioned;
      assert.deepEqual(await host.replaceProviderExtensions([candidate]), { kind: 'deferred', reason: 'active-work' });
      assert.equal(inspected, 0); assert.equal(f.provisioned, before); assert.equal(f.state.modules.length, 1);
      finish.resolve();
      assert.equal((await discovery)[0].agents[0].name, 'artifact-a');
      assert.deepEqual(await host.replaceProviderExtensions([candidate]), { kind: 'replaced', generation: 2 });
      assert.equal((await host.discoverProviders())[0].agents[0].name, 'artifact-b');
      assert.equal(f.count(f.state.modules[0], 'dispose'), 1); assert.deepEqual(f.state.commands, []);
    } finally { finish.resolve(); await discovery; await host.close(); }
  });

  await t.test('admitted artifact command keeps its receipt and identity across explicit retry', async t => {
    const f = await fixture(t, runtime), entered = Promise.withResolvers(), finish = Promise.withResolvers();
    const host = await runtime.startBrowserHost({ ...f.options, providerExtensions: [f.selected(f.first, 'artifact-a')] });
    const call = api(host);
    try {
      const metadata = (await call({ op: 'metadata' })).value;
      const scope = { hostId: host.hostId, conversationId: 'artifact-command' };
      assert.deepEqual((await call({ op: 'create', scope, agentId: metadata.defaultAgentId })).value, scope);
      f.state.hooks['artifact-a'] = { async submit() { entered.resolve(); await finish.promise; } };
      const command = { version: 1, scope, clientCommandId: 'original-send', body: { kind: 'send', text: 'one' } };
      const sending = call({ op: 'submit', command });
      await entered.promise;
      const before = f.provisioned;
      assert.deepEqual(await host.replaceProviderExtensions([f.selected(f.second, 'artifact-b')]), { kind: 'deferred', reason: 'active-work' });
      assert.equal(f.state.modules.length, 1); assert.equal(f.provisioned, before);
      finish.resolve();
      const sent = await sending;
      assert.equal(sent.ok, true); assert.equal(sent.value.kind, 'receipt');
      assert.deepEqual(await host.replaceProviderExtensions([f.selected(f.second, 'artifact-b')]), { kind: 'replaced', generation: 2 });
      assert.deepEqual(await call({ op: 'submit', command }), sent);
      assert.equal(f.state.commands.length, 2);
      assert.equal(f.state.commands[1].kind, 'send');
      assert.equal(sent.value.receipt.clientCommandId, 'original-send');
      assert.equal(f.state.commands[1].operationId, sent.value.receipt.hostOperationId);
      assert.equal(f.state.commands[1].binding.creation.scope.conversationId, scope.conversationId);
    } finally { finish.resolve(); await host.close(); }
  });

  await t.test('admitted artifact observation acquisition defers candidate preparation', async t => {
    const f = await fixture(t, runtime), entered = Promise.withResolvers(), finish = Promise.withResolvers();
    const host = await runtime.startBrowserHost({ ...f.options, providerExtensions: [f.selected(f.first, 'artifact-a')] });
    const call = api(host);
    const metadata = (await call({ op: 'metadata' })).value;
    f.state.hooks['artifact-a'] = { async snapshot() { entered.resolve(); await finish.promise; } };
    const scope = { hostId: host.hostId, conversationId: 'artifact-observation' };
    const creating = call({ op: 'create', scope, agentId: metadata.defaultAgentId });
    try {
      await entered.promise;
      const before = f.provisioned;
      assert.equal(host.extensionStatus().pending, 1);
      assert.deepEqual(await host.replaceProviderExtensions([f.selected(f.second, 'artifact-b')]), { kind: 'deferred', reason: 'active-work' });
      assert.equal(f.state.modules.length, 1); assert.equal(f.provisioned, before);
      finish.resolve();
      assert.deepEqual((await creating).value, scope);
      assert.equal((await host.replaceProviderExtensions([f.selected(f.second, 'artifact-b')])).kind, 'replaced');
      assert.equal(f.state.commands.length, 1); assert.equal(f.state.commands[0].kind, 'create');
      assert.equal(f.count(f.state.modules[0], 'close'), 1); assert.equal(f.count(f.state.modules[0], 'dispose'), 1);
    } finally { finish.resolve(); await creating; await host.close(); }
  });

  await t.test('verified retained catalog survives disk mutation and same bytes import a fresh generation', async t => {
    const f = await fixture(t, runtime);
    const host = await runtime.startBrowserHost({ ...f.options, providerExtensions: [f.installed] });
    const original = await readFile(join(f.first.directory, 'entries.mjs'));
    const lazy = await readFile(join(f.first.directory, 'probe.mjs'));
    const candidate = f.selected(f.first, 'artifact-a'), installations = candidate.installations;
    Object.defineProperty(candidate, 'installations', { get() {
      writeFileSync(join(f.first.directory, 'entries.mjs'), "throw new Error('PRIVATE_CHANGED_CATALOG');");
      writeFileSync(join(f.first.directory, 'probe.mjs'), "throw new Error('PRIVATE_CHANGED_LAZY');");
      return installations;
    } });
    try {
      assert.deepEqual(await host.replaceProviderExtensions([candidate]), { kind: 'replaced', generation: 2 });
      assert.equal((await f.state.modules[1].probe()).retained, 17);
      assert.equal((await host.discoverProviders())[0].agents[0].name, 'artifact-a');
      await writeFile(join(f.first.directory, 'entries.mjs'), original);
      await writeFile(join(f.first.directory, 'probe.mjs'), lazy);
      assert.deepEqual(await host.replaceProviderExtensions([f.selected(f.first, 'artifact-a')]), { kind: 'replaced', generation: 3 });
      assert.equal(f.state.modules.length, 3);
      assert.equal(f.state.modules[2].parser, runtime.sdk.parseExtensionManifest);
      assert.equal(f.count(f.state.modules[1], 'dispose'), 1);
    } finally { await host.close(); }
  });

  for (const failure of artifactFailures) {
    await t.test(`artifact ${failure.name} failure retires old code, classifies recovery and permits explicit replacement`, async t => {
      const f = await fixture(t, runtime);
      const host = await runtime.startBrowserHost({ ...f.options, providerExtensions: [f.installed] });
      try {
        const selection = await failure.arrange(f, f.selected(f.first, 'artifact-a'));
        assert.deepEqual(await host.replaceProviderExtensions(selection), failed(failure.classification));
        assert.deepEqual(host.extensionStatus(), failed(failure.classification));
        await assert.rejects(host.discoverProviders(), /unavailable/);
        assert.equal(f.count(f.state.modules[0], 'close'), 1); assert.equal(f.count(f.state.modules[0], 'dispose'), 1);
        assert.equal(f.state.modules.length, 1 + failure.imported);
        await failure.assertRetired?.(f);
        assert.equal((await host.replaceProviderExtensions([f.selected(f.second, 'artifact-b')])).kind, 'replaced');
        assert.equal((await host.discoverProviders())[0].agents[0].name, 'artifact-b');
        assert.equal(f.state.maximum, 1); assert.deepEqual(f.state.commands, []);
        assert.doesNotMatch(JSON.stringify(host.extensionStatus()), /PRIVATE/);
      } finally { await host.close(); }
    });
  }

  for (const phase of ['import', 'activate', 'discover']) {
    await t.test(`close during artifact ${phase} never publishes the candidate and disposes acquired resources once`, async t => {
      const f = await fixture(t, runtime), entered = Promise.withResolvers(), finish = Promise.withResolvers();
      const host = await runtime.startBrowserHost({ ...f.options, providerExtensions: [f.installed] });
      f.state.hooks['artifact-a'] = { async [phase]() { entered.resolve(); await finish.promise; } };
      const replacing = host.replaceProviderExtensions([f.selected(f.first, 'artifact-a')]);
      await entered.promise;
      const closing = host.close();
      try {
        assert.equal(host.extensionStatus().kind, 'closing');
        assert.deepEqual(await host.replaceProviderExtensions([]), { kind: 'unavailable' });
        finish.resolve();
        assert.deepEqual(await replacing, { kind: 'unavailable' }); await closing;
        const next = f.state.modules[1];
        assert.equal(f.count(f.state.modules[0], 'dispose'), 1);
        assert.equal(f.count(next, 'import'), 1);
        assert.equal(f.count(next, 'activate'), phase === 'import' ? 0 : 1);
        assert.equal(f.count(next, 'dispose'), phase === 'import' ? 0 : 1);
        assert.equal(f.count(next, 'close'), phase === 'discover' ? 1 : 0);
        await assert.rejects(next.probe(), /./);
        assert.equal(f.state.emitter.listenerCount('update'), 0); assert.equal(f.state.maximum, 1);
        assert.deepEqual(host.extensionStatus(), { kind: 'closed' });
      } finally { finish.resolve(); await Promise.allSettled([replacing, closing]); }
    });
  }

  await t.test('artifact cleanup failure retains restart recovery and releases the catalog hook once', async t => {
    const f = await fixture(t, runtime);
    const host = await runtime.startBrowserHost({ ...f.options, providerExtensions: [f.selected(f.first, 'artifact-a')] });
    const old = f.state.modules[0];
    f.state.hooks['artifact-a'] = { dispose() { throw new Error(secret); } };
    assert.deepEqual(await host.replaceProviderExtensions([f.selected(f.second, 'artifact-b')]), failed('cleanup', 'restart'));
    assert.equal(f.state.modules.length, 1);
    assert.deepEqual(await host.replaceProviderExtensions([]), failed('cleanup', 'restart'));
    await assert.rejects(old.probe(), /./);
    await assert.rejects(host.close(), /Host shutdown failed/);
    await assert.rejects(host.close(), /Host shutdown failed/);
    assert.equal(f.count(old, 'close'), 1); assert.equal(f.count(old, 'dispose'), 1);
    assert.deepEqual(host.extensionStatus(), failed('cleanup', 'restart'));
  });
});
