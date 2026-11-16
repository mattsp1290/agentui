import assert from 'node:assert/strict';
import { test } from 'node:test';
import { forwardRef, lazy, memo } from 'react';
import { parseConversationModules, parseUiExtensionContributions, parseUiExtensionPresentation, validateConversationModules, validateUiExtensionContributions } from '@agentui/sdk/react';

const View = () => null;
const module = { id: 'notes', label: 'Notes', component: View };
const rejected = { kind: 'rejected', reason: 'disabled' };

function onceFields(fields) {
  return Object.defineProperties({}, Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, {
    get() { Object.defineProperty(this, key, { get() { throw new Error(`Reread ${key}`); } }); return value; }, configurable: true,
  }])));
}

test('capture validates the first observation and copies every nested presentation record and array', async () => {
  let disposals = 0;
  const action = onceFields({ id: 'send', label: 'Send', run: async () => rejected });
  const child = onceFields({ ...module, actions: [action], children: undefined });
  const root = onceFields({ ...module, actions: undefined, children: [child] });
  const overrides = onceFields({ transcript: View });
  const source = onceFields({ modules: [root], overrides, contentLayout: View, dispose() { disposals++; } });
  const result = parseUiExtensionContributions(source);
  assert.equal(result.kind, 'ready');
  const captured = result.presentation.modules[0];
  assert.equal(result.presentation.transcript, View);
  assert.equal(captured.children[0].label, 'Notes');
  assert.equal(await captured.children[0].actions[0].run({}), rejected);
  assert.notEqual(captured, root); assert.notEqual(captured.children[0], child); assert.notEqual(captured.children[0].actions[0], action);
  await result.dispose(); assert.equal(disposals, 1);
  const wrongFirst = parseUiExtensionContributions({ modules: [], dispose() {}, get overrides() {
    Object.defineProperty(this, 'overrides', { value: { transcript: View } }); return { transcript: {} };
  } });
  assert.equal(wrongFirst.kind, 'invalid-presentation');
});

test('mutating author objects cannot replace captured modules, children, actions, functions or transcript', async () => {
  const action = { id: 'send', label: 'Send', async run() { return rejected; } };
  const children = [{ ...module, actions: [action] }], modules = [{ ...module, children }];
  const source = { modules, overrides: { transcript: View }, dispose() {} };
  const captured = parseUiExtensionContributions(source);
  assert.equal(captured.kind, 'ready');
  source.modules = []; source.overrides.transcript = () => 'changed';
  modules[0].label = 'Changed'; children[0].component = () => 'changed'; action.label = 'Changed'; action.run = () => { throw new Error('Changed'); };
  children[0].actions.push({ ...action, id: 'other' }); children.push({ ...module, id: 'other' }); modules.push({ ...module, id: 'other' });
  assert.equal(captured.presentation.modules.length, 1);
  const root = captured.presentation.modules[0], child = root.children[0];
  assert.equal(root.label, 'Notes'); assert.equal(root.children.length, 1); assert.equal(child.component, View);
  assert.equal(child.actions.length, 1); assert.equal(child.actions[0].label, 'Send');
  assert.equal(await child.actions[0].run({}), rejected); assert.equal(captured.presentation.transcript, View);
});

test('capture preserves private-field action and disposal receivers and caches completion before invoking cleanup', async () => {
  class Action {
    #result = rejected;
    id = 'send'; label = 'Send';
    async run() { return this.#result; }
  }
  let repeated;
  class Contribution {
    #disposals = 0;
    modules = [{ ...module, actions: [new Action()] }];
    dispose() { this.#disposals++; repeated = captured.dispose(); }
    get disposals() { return this.#disposals; }
  }
  const source = new Contribution(), captured = parseUiExtensionContributions(source);
  assert.equal(captured.kind, 'ready');
  assert.equal(await captured.presentation.modules[0].actions[0].run({}), rejected);
  const completion = captured.dispose(); await completion;
  assert.equal(repeated, completion); assert.equal(captured.dispose(), completion); assert.equal(source.disposals, 1);
});

test('each failure retains exactly the cleanup authority acquired before it', async () => {
  const failure = new Error('Getter failed');
  for (const source of [null, {}, { dispose: false }, { get dispose() { throw failure; } }]) {
    const result = parseUiExtensionContributions(source);
    assert.equal(result.kind, 'invalid-lifetime'); assert.equal('dispose' in result, false);
  }
  for (const fields of [
    { get modules() { throw failure; } },
    { modules: [], get overrides() { throw failure; } },
    { modules: [], overrides: { get transcript() { throw failure; } } },
    { modules: [{ ...module, get actions() { throw failure; } }] },
    { modules: [{ ...module, children: [{ ...module, get label() { throw failure; } }] }] },
    { modules: [{ ...module, actions: [{ id: 'send', label: 'Send', get run() { throw failure; } }] }] },
  ]) {
    let disposals = 0;
    const source = Object.defineProperties({ dispose() { disposals++; } }, Object.getOwnPropertyDescriptors(fields));
    const result = parseUiExtensionContributions(source);
    assert.equal(result.kind, 'invalid-presentation'); assert.equal(result.error, failure); assert.equal(disposals, 0);
    assert.throws(() => validateUiExtensionContributions(source), error => error === failure); assert.equal(disposals, 0);
    await result.dispose(); await result.dispose(); assert.equal(disposals, 1);
  }
});

for (const asynchronous of [false, true]) test(`cleanup rejection is retained and never reinvoked (async ${asynchronous})`, async () => {
  let calls = 0; const failure = new Error('Cleanup failed');
  const captured = parseUiExtensionContributions({ modules: [], dispose() { calls++; if (asynchronous) return Promise.reject(failure); throw failure; } });
  assert.equal(captured.kind, 'ready');
  const completion = captured.dispose(); assert.equal(captured.dispose(), completion);
  await assert.rejects(completion, error => error === failure);
  assert.equal(captured.dispose(), completion); await assert.rejects(captured.dispose(), error => error === failure); assert.equal(calls, 1);
});

test('array traversal reads selected indices once without using author iteration and allows shared children but rejects cycles and duplicate siblings', () => {
  let reads = 0, lengths = 0;
  const source = new Proxy([module], { get(target, key) {
    if (key === 'length') { lengths++; return 1; }
    if (key === '0') { reads++; if (reads > 1) throw new Error('Index reread'); return module; }
    if (key === Symbol.iterator || key === 'map') throw new Error('Author iteration');
    return Reflect.get(target, key);
  } });
  assert.equal(parseConversationModules(source)[0].component, View); assert.equal(reads, 1); assert.equal(lengths, 1);
  const shared = [module];
  const captured = parseConversationModules([{ ...module, children: shared }, { ...module, id: 'other', children: shared }]);
  assert.notEqual(captured[0].children, captured[1].children);
  const cycle = { ...module, children: [] }; cycle.children.push(cycle);
  for (const value of [[cycle], [module, module]]) {
    assert.throws(() => parseConversationModules(value)); assert.throws(() => validateConversationModules(value));
  }
});

test('class transcript accessors retain wrappers; inherited unknown slots reject without evaluation', () => {
  for (const component of [memo(View), forwardRef(View), lazy(async () => ({ default: View }))]) {
    class Overrides { get transcript() { return component; } }
    const result = parseUiExtensionContributions({ modules: [{ ...module, component }], overrides: new Overrides(), dispose() {} });
    assert.equal(result.kind, 'ready'); assert.equal(result.presentation.transcript, component); assert.equal(result.presentation.modules[0].component, component);
  }
  for (const key of ['composer', Symbol('unknown'), 'constructor']) {
    let reads = 0;
    const prototype = Object.defineProperty({}, key, { get() { reads++; throw new Error('Unknown getter evaluated'); } });
    const result = parseUiExtensionContributions({ modules: [], overrides: Object.create(prototype), dispose() {} });
    assert.equal(result.kind, 'invalid-presentation'); assert.match(result.error.message, /Unknown override slot/); assert.equal(reads, 0);
  }
  assert.equal(parseUiExtensionContributions({ modules: [], overrides: { constructor() {} }, dispose() {} }).kind, 'invalid-presentation');
  let tags = 0;
  const wrapper = { get $$typeof() { if (++tags > 1) throw new Error('Tag reread'); return Symbol.for('react.memo'); }, type: View };
  assert.equal(parseConversationModules([{ ...module, component: wrapper }])[0].component, wrapper); assert.equal(tags, 1);
});

test('successful assertion wrappers never invoke disposal', () => {
  let disposals = 0;
  const source = { modules: [module], dispose() { disposals++; } };
  validateConversationModules(source.modules); validateUiExtensionContributions(source); assert.equal(disposals, 0);
});

for (const callable of [false, true]) test(`presentation-only parser never inspects disposal (callable ${callable})`, () => {
  const reads = {};
  const fields = onceFields({ modules: [module], overrides: { transcript: View }, contentLayout: View });
  const source = callable ? Object.setPrototypeOf(function contribution() {}, fields) : Object.create(fields);
  Object.defineProperty(source, 'dispose', { get() { reads.dispose = (reads.dispose ?? 0) + 1; throw new Error('Unexpected disposal lookup'); } });
  const presentation = parseUiExtensionPresentation(source);
  assert.deepEqual(Object.keys(presentation).sort(), ['contentLayout', 'modules', 'transcript']);
  assert.equal(presentation.modules[0].component, View); assert.equal(presentation.transcript, View);
  assert.deepEqual(reads, {});
});

test('content layout capture observes the first getter once, retains wrappers and resists author replacement', async () => {
  for (const component of [View, memo(View), forwardRef(View), lazy(async () => ({ default: View }))]) {
    const fields = onceFields({ modules: [], contentLayout: component });
    const source = Object.assign(Object.create(fields), { dispose() {} });
    const captured = parseUiExtensionContributions(source);
    assert.equal(captured.kind, 'ready'); assert.equal(captured.presentation.contentLayout, component);
    assert.equal(captured.presentation.contentLayout, component); await captured.dispose();
  }
  const mutable = { modules: [], contentLayout: View };
  const presentation = parseUiExtensionPresentation(mutable); mutable.contentLayout = () => 'changed';
  assert.equal(presentation.contentLayout, View);
  assert.equal(parseUiExtensionPresentation({ modules: [] }).contentLayout, undefined);
  for (const contentLayout of [null, {}, 'layout', 1]) {
    let disposed = 0;
    const captured = parseUiExtensionContributions({ modules: [], contentLayout, dispose() { disposed++; } });
    assert.equal(captured.kind, 'invalid-presentation'); await captured.dispose(); await captured.dispose(); assert.equal(disposed, 1);
  }
  let disposed = 0;
  const malformed = parseUiExtensionContributions({ modules: [], get contentLayout() {
    Object.defineProperty(this, 'contentLayout', { value: View }); return {};
  }, dispose() { disposed++; } });
  assert.equal(malformed.kind, 'invalid-presentation'); await malformed.dispose(); assert.equal(disposed, 1);
  const failure = new Error('Layout getter failed');
  const throwing = parseUiExtensionContributions({ modules: [], get contentLayout() { throw failure; }, dispose() { disposed++; } });
  assert.equal(throwing.kind, 'invalid-presentation'); assert.equal(throwing.error, failure); await throwing.dispose(); assert.equal(disposed, 2);
  assert.equal(parseUiExtensionContributions({ modules: [], overrides: { contentLayout: View }, dispose() {} }).kind, 'invalid-presentation');
});
