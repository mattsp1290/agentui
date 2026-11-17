import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement, forwardRef, lazy, memo } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ThemeScope } from '@agentui/ui-primitives/desktop';
import { EXTENSION_SDK_VERSION, checkExtensionEntrypoint, parseExtensionManifest, validateExtensionLifetime } from '@agentui/sdk';
import { validateConversationModules, validateUiExtensionContributions } from '@agentui/sdk/react';
import { callableEntry, createNotesFixture, manifest, ServerEntry, textTool, UiEntry } from './fixture.ts';
import { crew, crewPresentation } from '../providers/contracts/crew.ts';

const entry = { kind: 'desktop', sdkVersion: EXTENSION_SDK_VERSION, activate() {} };
const module = { id: 'notes', label: 'Notes', component: () => null };

test('provider-free nested module activates, renders changing activity and preserves scoped command results', async () => {
  let disposals = 0;
  assert.equal(EXTENSION_SDK_VERSION, '0.7.0');
  const fixture = createNotesFixture(() => { disposals++; });
  const metadata = parseExtensionManifest(manifest);
  assert.deepEqual(checkExtensionEntrypoint(metadata, 'desktop', fixture), { kind: 'compatible' });
  const active = await fixture.activate({ namespace: metadata.namespace, frontendTools: { add() {} } });
  validateUiExtensionContributions(active);
  const calls = [];
  const conversation = { hostId: 'host-A', conversationId: 'conversation-A' };
  const result = { kind: 'receipt', receipt: { scope: conversation, clientCommandId: 'existing-client-command',
    hostOperationId: 'existing-host-operation', sequence: 1, state: { kind: 'uncertain', reason: 'lost acknowledgement' } } };
  const props = { conversation, activity: { domain: { messages: [], currentRun: null }, decisions: {}, receipts: {} },
    commands: { async send(text) { calls.push({ conversation, text }); return result; },
      async approve() { throw new Error('Unexpected approval'); }, async cancel() { throw new Error('Unexpected cancel'); } } };
  const notes = active.modules[0];
  const render = (component, props) => renderToStaticMarkup(createElement(ThemeScope, null, createElement(component, props)));
  assert.match(render(notes.component, props), /conversation-A: 0 messages/u);
  const updated = { ...props, conversation: { hostId: 'host-B', conversationId: 'conversation-B' },
    activity: { ...props.activity, domain: { messages: [{ messageId: 'm', revision: 1, role: 'user', text: 'hello', complete: true }], currentRun: null } } };
  assert.match(render(notes.component, updated), /conversation-B: 1 messages/u);
  assert.match(render(notes.children[0].component, updated), /hello/u);
  assert.equal(await notes.actions[0].run(props), result);
  assert.deepEqual(calls, [{ conversation, text: 'Summarize this conversation.' }]);
  const rejection = { kind: 'rejected', reason: 'conversation-capacity' };
  assert.equal(await notes.actions[0].run({ ...props, commands: { ...props.commands, async send() { return rejection; } } }), rejection);
  await active.dispose();
  assert.equal(disposals, 1);
});

test('server provider and frontend tool registration preserve concrete contributions', async () => {
  const providers = [];
  const server = { kind: 'server', sdkVersion: EXTENSION_SDK_VERSION,
    async activate({ providers }) { providers.add('crew', crew, crewPresentation); return { async dispose() {} }; } };
  const metadata = parseExtensionManifest({ ...manifest, entries: [{ kind: 'server', module: './server.js' }] });
  assert.equal(checkExtensionEntrypoint(metadata, 'server', server).kind, 'compatible');
  const lifetime = await server.activate({ namespace: metadata.namespace, credentials: { async use() { throw new Error('Unexpected credential use'); } }, providers: { add(id, provider, presentation) { providers.push({ id, provider, presentation }); } } });
  validateExtensionLifetime(lifetime);
  assert.deepEqual(providers, [{ id: 'crew', provider: crew, presentation: crewPresentation }]);
  const tools = [];
  const context = { namespace: 'notes', frontendTools: { add(tool) { tools.push(tool); } } };
  context.frontendTools.add(textTool);
  assert.equal(tools[0], textTool);
  assert.equal(await tools[0].execute(tools[0].decodeInput({ text: 'hello' }), { conversation: { hostId: 'h', conversationId: 'c' } }), '5');
  assert.throws(() => tools[0].decodeInput({ text: 4 }), /Expected text/u);
  await lifetime.dispose();
});

test('manifest parsing rejects malformed metadata and paths, leaving version compatibility explicit', () => {
  for (const invalid of [null, {}, { ...manifest, namespace: ' ' }, { ...manifest, trust: 'sandbox' },
    { ...manifest, sdkVersion: undefined }, { ...manifest, entries: [] }, { ...manifest, entries: [...manifest.entries, ...manifest.entries] },
    ...['/absolute.js', '../outside.js', './a/../outside.js', './a//entry.js', './a/./entry.js', './', './a\\entry.js', './%2e%2e/entry.js', 'https://example.com/e.js'].map(module => ({ ...manifest, entries: [{ kind: 'desktop', module }] })),
    { ...manifest, entries: [{ kind: 'web', module: './web.js' }] }]) assert.throws(() => parseExtensionManifest(invalid));
  assert.equal(parseExtensionManifest({ ...manifest, sdkVersion: 'future' }).sdkVersion, 'future');
});

test('compatibility rejects undeclared targets and invalid exports before activation', () => {
  let activations = 0;
  const valid = { ...entry, activate() { activations++; } };
  for (const [metadata, target, loaded, code] of [
    [{ ...manifest, sdkVersion: 'future' }, 'desktop', valid, 'sdk-version'],
    [{ ...manifest, sdkVersion: '0.6.0' }, 'desktop', valid, 'sdk-version'],
    [manifest, 'desktop', { ...valid, sdkVersion: '0.6.0' }, 'sdk-version'],
    [{ ...manifest, sdkVersion: '0.5.0' }, 'desktop', valid, 'sdk-version'],
    [manifest, 'desktop', { ...valid, sdkVersion: '0.5.0' }, 'sdk-version'],
    [{ ...manifest, sdkVersion: '0.4.0' }, 'desktop', valid, 'sdk-version'],
    [manifest, 'desktop', { ...valid, sdkVersion: '0.4.0' }, 'sdk-version'],
    [{ ...manifest, sdkVersion: '0.2.0' }, 'desktop', valid, 'sdk-version'],
    [manifest, 'desktop', { ...valid, sdkVersion: '0.2.0' }, 'sdk-version'],
    [manifest, 'ios', valid, 'entry-kind'], [manifest, 'desktop', { ...valid, kind: 'server' }, 'entry-kind'],
    [manifest, 'desktop', { ...valid, sdkVersion: 'future' }, 'sdk-version'],
    [manifest, 'desktop', { ...valid, sdkVersion: undefined }, 'sdk-version'],
    [manifest, 'desktop', null, 'entry-export'], [manifest, 'desktop', { ...valid, activate: true }, 'entry-export'],
  ]) {
    const result = checkExtensionEntrypoint(parseExtensionManifest(metadata), target, loaded);
    assert.equal(result.kind, 'incompatible');
    assert.equal(result.code, code);
  }
  assert.equal(activations, 0);
});

test('contribution boundary rejects malformed trees and cycles but allows IDs under different parents', () => {
  const cyclic = { ...module, children: [] };
  cyclic.children.push(cyclic);
  const action = { id: 'send', label: 'Send', async run() { return { kind: 'rejected', reason: 'disabled' }; } };
  for (const value of [null, {}, [null], [{ ...module, id: '' }], [{ ...module, label: ' ' }], [module, module],
    [{ ...module, component: {} }], [{ ...module, children: {} }], [{ ...module, actions: {} }],
    [{ ...module, actions: [action, action] }], [{ ...module, actions: [{ ...action, run: false }] }],
    [{ ...module, actions: [{ ...action, label: '' }] }], [cyclic]]) assert.throws(() => validateConversationModules(value));
  validateConversationModules([{ ...module, children: [module] }, { ...module, id: 'other', children: [module], actions: [action] }]);
  for (const value of [{ modules: [] }, { dispose() {}, modules: [cyclic] }, { dispose: false, modules: [] }]) {
    assert.throws(() => validateUiExtensionContributions(value));
  }
  assert.throws(() => validateExtensionLifetime({}), /disposal/u);
});

test('module validation accepts React component wrappers supported by the public component type', () => {
  for (const component of [memo(() => 'memo'), forwardRef(() => 'ref'), lazy(async () => ({ default: () => 'lazy' }))]) {
    validateConversationModules([{ ...module, component }]);
  }
  assert.match(renderToStaticMarkup(createElement(memo(() => 'memo'))), /memo/u);
  assert.match(renderToStaticMarkup(createElement(forwardRef(() => 'ref'))), /ref/u);
});

test('in-process contracts accept class instances, getters and callable objects', async () => {
  const metadata = parseExtensionManifest(manifest);
  const server = new ServerEntry();
  const serverMetadata = parseExtensionManifest({ ...manifest, entries: [{ kind: 'server', module: './server.js' }] });
  assert.equal(checkExtensionEntrypoint(serverMetadata, 'server', server).kind, 'compatible');
  validateExtensionLifetime(server.activate());
  const result = { kind: 'rejected', reason: 'disabled' };
  const sent = [];
  for (const loaded of [new UiEntry(), callableEntry]) {
    assert.equal(checkExtensionEntrypoint(metadata, 'desktop', loaded).kind, 'compatible');
    const active = loaded.activate();
    validateExtensionLifetime(active);
    validateUiExtensionContributions(active);
    assert.equal(active.modules[0].label, 'Notes');
    assert.equal(active.modules[0].actions[0].label, 'Summarize');
    assert.equal(await active.modules[0].actions[0].run({ commands: {
      async send(text) { sent.push(text); return result; },
    } }), result);
    await active.dispose();
  }
  assert.deepEqual(sent, ['Summarize', 'Summarize']);
});

test('manifest metadata remains plain exact data while behavior values allow prototypes', () => {
  class Metadata { constructor() { Object.assign(this, manifest); } }
  for (const value of [new Metadata(), { ...manifest, get namespace() { return 'notes'; } },
    { ...manifest, extra: true }, { ...manifest, [Symbol('extra')]: true },
    { ...manifest, entries: [{ ...manifest.entries[0], extra: true }] }]) {
    assert.throws(() => parseExtensionManifest(value));
  }
  for (const value of [null, [], false, 1, 'entry']) {
    assert.equal(checkExtensionEntrypoint(parseExtensionManifest(manifest), 'desktop', value).code, 'entry-export');
    assert.throws(() => validateExtensionLifetime(value));
    assert.throws(() => validateUiExtensionContributions(value));
    assert.throws(() => validateConversationModules([value]));
  }
});

test('manifest namespaces use the shared bounded grammar', () => {
  for (const namespace of ['Notes', 'acme.notes', 'my_ext', 'a'.repeat(33)]) assert.throws(() => parseExtensionManifest({ ...manifest, namespace }));
  assert.equal(parseExtensionManifest({ ...manifest, namespace: 'a'.repeat(32) }).namespace, 'a'.repeat(32));
});

test('transcript slot validates known override shapes and shares module component wrapper support', () => {
  for (const component of [() => null, memo(() => null), forwardRef(() => null), lazy(async () => ({ default: () => null }))]) {
    validateUiExtensionContributions({ modules: [], overrides: { transcript: component }, dispose() {}, future: true });
  }
  for (const overrides of [null, [], false, { transcript: null }, { transcript: {} }, { transcript: 'div' }, { composer: () => null }, { [Symbol('unknown')]: true }]) {
    assert.throws(() => validateUiExtensionContributions({ modules: [], overrides, dispose() {} }));
  }
  validateUiExtensionContributions({ modules: [], overrides: {}, dispose() {} });
});
