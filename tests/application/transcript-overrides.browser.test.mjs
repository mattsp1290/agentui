import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { repository, buildCustom } from '../customization/build/support.mjs';
import { root, fixture, connected, draft, revealRecovery, customRuntime, wait } from './browser-support.mjs';

const entry = body => `load: async () => ({ default: { kind: 'desktop', sdkVersion: '0.2.0', activate() { ${body} } } })`;
const override = `function Transcript(context) {
  const [broken, setBroken] = React.useState(false);
  window.contexts ??= []; if (!window.contexts.some(previous => previous.conversation.conversationId === context.conversation.conversationId)) window.contexts.push(context);
  if (broken) return <Broken />;
  return <section aria-label="Fixture transcript"><p>{context.conversation.conversationId + ' messages ' + context.activity.domain.messages.length}</p>
    <button onClick={() => setBroken(true)}>Break transcript</button></section>;
}
function Broken() { throw new Error('Transcript descendant failed'); }`;
const ready = (body = '') => `${override} return { modules: [], overrides: { transcript: Transcript }, dispose() { window.disposals = (window.disposals || 0) + 1; ${body} } };`;
const editor = page => page.getByRole('textbox', { name: 'Message', exact: true });
async function unchanged(page, previous, text) {
  assert.equal(await editor(page).evaluate((node, old) => node === old, previous), true);
  assert.equal(await editor(page).inputValue(), text);
}
async function open(t) {
  const host = await fixture(t), page = await host.page();
  await page.getByRole('button', { name: 'New recorded conversation' }).click(); await connected(page);
  return { host, page };
}
const sibling = `, { manifest: { ...manifest, namespace: 'sibling' }, ${entry(`return { modules: [{ id: 'healthy', label: 'Healthy', component() { return <p>Healthy namespace</p>; },
  actions: [{ id: 'send', label: 'Send sibling', run: ({ commands }) => commands.send('Sibling command') }] }], dispose() { window.siblingDisposals = (window.siblingDisposals || 0) + 1; } };`)} }`;

test('committed artifact replaces transcript, updates activity and retains independent additive actions and composer', { timeout: 90_000 }, async t => {
  const custom = repository(), child = repository();
  t.after(() => Promise.all([custom, child].map(value => rm(value.directory, { recursive: true, force: true }))));
  const childManifest = JSON.parse(await readFile(join(child.repo, 'package.json'), 'utf8'));
  childManifest.agentui.extension.namespace = 'transcript';
  child.write('package.json', JSON.stringify(childManifest));
  child.write('desktop/index.tsx', await readFile(join(root, 'tests/application/fixtures/transcript-override.tsx'), 'utf8'));
  const parentManifest = JSON.parse(await readFile(join(custom.repo, 'package.json'), 'utf8'));
  parentManifest.agentui.extensions = [{ repository: child.repo, commit: child.commit() }];
  custom.write('package.json', JSON.stringify(parentManifest));
  const commit = custom.commit();
  child.write('desktop/index.tsx', 'throw new Error("Dirty source must not enter artifact");');
  buildCustom(custom, commit);
  const host = await fixture(t, join(custom.directory, 'browser')), page = await host.page();
  await page.getByRole('button', { name: 'New recorded conversation' }).click(); await connected(page);
  const transcript = page.getByRole('region', { name: 'Committed transcript' });
  await transcript.waitFor(); assert.equal(await page.getByLabel('Messages', { exact: true }).count(), 0);
  await draft(page, 'Artifact draft'); const previous = await editor(page).elementHandle();
  await page.getByRole('button', { name: 'Review the plan', exact: true }).click();
  await transcript.getByText('Review our current plan. Identify the next useful step and any unresolved decision.', { exact: true }).waitFor();
  await page.getByRole('heading', { name: 'Approval required', exact: true }).waitFor();
  await unchanged(page, previous, 'Artifact draft'); assert.equal((await host.entries()).length, 1);
  await revealRecovery(page); await page.getByRole('button', { name: 'Restore default view', exact: true }).click();
  await page.getByLabel('Messages', { exact: true }).waitFor();
  assert.equal(await transcript.count(), 0); assert.equal(await page.getByRole('button', { name: 'Review the plan', exact: true }).count(), 0);
  await unchanged(page, previous, 'Artifact draft'); assert.equal((await host.entries()).length, 1);
});

test('delayed override preserves draft and DOM through activation, descendant failure and restore; siblings survive once-only rejected cleanup', { timeout: 45_000 }, async t => {
  const { host, page } = await open(t);
  await customRuntime(page, host, entry(`return new Promise(resolve => { window.activate = () => { ${override}
    resolve({ modules: [], overrides: { transcript: Transcript }, dispose() { window.disposals = (window.disposals || 0) + 1; return Promise.reject(new Error('Cleanup rejected')); } }); }; });`), false, sibling);
  await page.getByLabel('Messages', { exact: true }).waitFor();
  await draft(page, 'Stable draft'); const previous = await editor(page).elementHandle();
  await page.evaluate(() => window.activate());
  await page.getByRole('region', { name: 'Fixture transcript' }).waitFor(); await unchanged(page, previous, 'Stable draft');
  await page.getByRole('button', { name: 'Break transcript', exact: true }).click();
  await page.getByLabel('Messages', { exact: true }).waitFor();
  await page.getByRole('alert').filter({ hasText: /Transcript descendant failed|Cleanup rejected/ }).waitFor();
  await wait(() => page.evaluate(() => window.disposals === 1), 'failed override disposal');
  await page.getByText('Healthy namespace', { exact: true }).waitFor(); await unchanged(page, previous, 'Stable draft');
  await page.getByRole('button', { name: 'Send sibling', exact: true }).click();
  await page.getByRole('heading', { name: 'Approval required', exact: true }).waitFor();
  await revealRecovery(page); await page.getByRole('button', { name: 'Restore default view', exact: true }).click();
  await unchanged(page, previous, 'Stable draft');
  assert.equal(await page.evaluate(() => window.disposals), 1); assert.equal(await page.evaluate(() => window.siblingDisposals), 1);
});

test('override getter failure during capture releases only its namespace and preserves default transcript and composer', { timeout: 45_000 }, async t => {
  const { host, page } = await open(t), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await customRuntime(page, host, entry(`return new Promise(resolve => { window.finishGetter = () => resolve({ modules: [],
    get overrides() { throw new Error('Override capture failed'); },
    dispose() { window.disposals = (window.disposals || 0) + 1; } }); });`), false, sibling);
  await wait(() => page.evaluate(() => typeof window.finishGetter === 'function'), 'pending getter activation');
  await draft(page, 'Getter failure draft'); const previous = await editor(page).elementHandle();
  await page.evaluate(() => window.finishGetter());
  await page.getByRole('alert').filter({ hasText: 'Override capture failed' }).waitFor();
  await wait(() => page.evaluate(() => window.disposals === 1), 'getter failure disposal');
  await page.getByLabel('Messages', { exact: true }).waitFor();
  assert.equal(await page.getByText('Uncaptured transcript', { exact: true }).count(), 0);
  await page.getByText('Healthy namespace', { exact: true }).waitFor(); await unchanged(page, previous, 'Getter failure draft');
  await page.getByRole('button', { name: 'Send sibling', exact: true }).click();
  await page.getByRole('heading', { name: 'Approval required', exact: true }).waitFor();
  await unchanged(page, previous, 'Getter failure draft');
  assert.equal((await host.entries()).length, 1);
  await revealRecovery(page); await page.getByRole('button', { name: 'Restore default view', exact: true }).click();
  await page.getByLabel('Messages', { exact: true }).waitFor(); await unchanged(page, previous, 'Getter failure draft');
  assert.equal(await page.evaluate(() => window.disposals), 1);
  assert.equal(await page.evaluate(() => window.siblingDisposals), 1); assert.deepEqual(errors, []);
});

test('captured override never rereads extension getters through shell changes, sibling actions and restore', { timeout: 45_000 }, async t => {
  const { host, page } = await open(t), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await customRuntime(page, host, entry(`const overrides = { get transcript() {
    window.transcriptReads = (window.transcriptReads || 0) + 1;
    if (window.rejectGetterReads) throw new Error('Transcript getter reread');
    return Transcript; } };
    function Transcript() { return <p>Captured getter transcript</p>; }
    return { modules: [], get overrides() { window.overrideReads = (window.overrideReads || 0) + 1;
      if (window.rejectGetterReads) throw new Error('Overrides getter reread'); return overrides; },
      dispose() { window.disposals = (window.disposals || 0) + 1; } };`), false, sibling);
  await page.getByText('Captured getter transcript', { exact: true }).waitFor();
  await draft(page, 'Captured getter draft'); const previous = await editor(page).elementHandle();
  const reads = await page.evaluate(() => { window.rejectGetterReads = true; return [window.overrideReads, window.transcriptReads]; });
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('heading', { name: 'Settings', exact: true, level: 1 }).waitFor();
  await page.getByRole('button', { name: 'Chats', exact: true }).click();
  await page.getByText('Captured getter transcript', { exact: true }).waitFor();
  await unchanged(page, previous, 'Captured getter draft');
  await page.getByText('Healthy namespace', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Send sibling', exact: true }).click();
  await page.getByRole('heading', { name: 'Approval required', exact: true }).waitFor();
  await page.getByText('Captured getter transcript', { exact: true }).waitFor();
  await unchanged(page, previous, 'Captured getter draft'); assert.equal((await host.entries()).length, 1);
  assert.deepEqual(await page.evaluate(() => [window.overrideReads, window.transcriptReads]), reads);
  assert.equal(await page.evaluate(() => window.disposals || 0), 0);
  await revealRecovery(page); await page.getByRole('button', { name: 'Restore default view', exact: true }).click();
  await page.getByLabel('Messages', { exact: true }).waitFor(); await unchanged(page, previous, 'Captured getter draft');
  await wait(() => page.evaluate(() => window.disposals === 1 && window.siblingDisposals === 1), 'captured override restore disposal');
  assert.deepEqual(await page.evaluate(() => [window.overrideReads, window.transcriptReads]), reads); assert.deepEqual(errors, []);
});

for (const order of [[0, 1], [1, 0]]) test(`conflicts wait for every selected lifetime with completion order ${order}`, { timeout: 45_000 }, async t => {
  const { host, page } = await open(t);
  const pending = index => entry(`return new Promise(resolve => { (window.finish ??= [])[${index}] = () => resolve({ modules: [{ id: 'alive', label: 'Alive ${index}', component() { return <p>Alive ${index}</p>; } }],
    overrides: { transcript() { return <p>Early winner ${index}</p>; } }, dispose() {} }); });`);
  await customRuntime(page, host, pending(0), false, `, { manifest: { ...manifest, namespace: 'alpha' }, ${pending(1)} }`);
  await wait(() => page.evaluate(() => window.finish?.length === 2), 'two pending activations');
  await page.evaluate(index => window.finish[index](), order[0]); await page.getByText(`Alive ${order[0]}`, { exact: true }).waitFor();
  assert.equal(await page.getByText(/Early winner/).count(), 0); await page.getByLabel('Messages', { exact: true }).waitFor();
  await page.evaluate(index => window.finish[index](), order[1]);
  await page.getByRole('alert').filter({ hasText: 'Transcript override conflict. alpha, fixture' }).waitFor();
  await page.getByText('Alive 0', { exact: true }).waitFor(); await page.getByText('Alive 1', { exact: true }).waitFor();
  assert.equal(await page.getByText(/Early winner/).count(), 0); await page.getByLabel('Messages', { exact: true }).waitFor();
});

test('override receives each conversation and refuses retained commands after navigation without reactivation', { timeout: 45_000 }, async t => {
  const { host, page } = await open(t);
  await customRuntime(page, host, entry(`window.activations = (window.activations || 0) + 1; ${ready()}`));
  await page.getByRole('region', { name: 'Fixture transcript' }).waitFor(); const first = await page.locator('.scope-label').textContent();
  await page.getByRole('button', { name: 'New recorded conversation' }).click();
  await wait(async () => await page.locator('.scope-label').textContent() !== first, 'new override conversation'); await connected(page);
  const second = await page.locator('.scope-label').textContent();
  await page.getByRole('region', { name: 'Fixture transcript' }).getByText(`${second} messages 0`, { exact: true }).waitFor();
  const reason = await page.evaluate(async () => { try { await window.contexts[0].commands.send('Old scope'); return ''; } catch (error) { return error.message; } });
  assert.match(reason, /Open the command’s conversation/); assert.equal(await page.evaluate(() => window.activations), 1);
  await draft(page, 'Next conversation'); await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page.getByRole('region', { name: 'Fixture transcript' }).getByText(new RegExp(`${second} messages [1-9]`)).waitFor();
  assert.equal((await host.entries()).length, 1);
});

test('restore before activation takes a late override disposer once and never mounts its transcript', { timeout: 45_000 }, async t => {
  const { host, page } = await open(t);
  await customRuntime(page, host, entry(`return new Promise(resolve => { window.finish = () => { ${override}
    resolve({ modules: [], overrides: { transcript: Transcript }, dispose() { window.disposals = (window.disposals || 0) + 1; return Promise.reject(new Error('Late rejected cleanup')); } }); }; });`));
  await wait(() => page.evaluate(() => typeof window.finish === 'function'), 'late override activation');
  await draft(page, 'Late draft'); const previous = await editor(page).elementHandle(), errors = []; page.on('pageerror', error => errors.push(error.message));
  await revealRecovery(page); await page.getByRole('button', { name: 'Restore default view', exact: true }).click();
  await page.evaluate(() => window.finish()); await wait(() => page.evaluate(() => window.disposals === 1), 'late override cleanup');
  assert.equal(await page.getByRole('region', { name: 'Fixture transcript' }).count(), 0); await unchanged(page, previous, 'Late draft'); assert.deepEqual(errors, []);
});

for (const [label, body] of [
  ['malformed override', "return { modules: [], overrides: { transcript: {} }, dispose() { window.disposals = (window.disposals || 0) + 1; } };"],
  ['unknown slot', "return { modules: [], overrides: { composer() { return null; } }, dispose() { window.disposals = (window.disposals || 0) + 1; } };"],
]) test(`${label} releases the validated lifetime and leaves sibling modules and default transcript usable`, { timeout: 45_000 }, async t => {
  const { host, page } = await open(t);
  await customRuntime(page, host, entry(body), false, sibling);
  await page.getByRole('alert').filter({ hasText: 'Custom tools could not load.' }).waitFor();
  await page.getByLabel('Messages', { exact: true }).waitFor(); await page.getByText('Healthy namespace', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.disposals), 1);
  await draft(page, 'Invalid override draft'); await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page.getByRole('heading', { name: 'Approval required', exact: true }).waitFor();
  await revealRecovery(page); await page.getByRole('button', { name: 'Restore default view', exact: true }).click();
  assert.equal(await page.evaluate(() => window.disposals), 1);
});

test('lazy transcript suspends locally, then replaces messages without replacing composer or draft', { timeout: 45_000 }, async t => {
  const { host, page } = await open(t);
  await customRuntime(page, host, entry(`const Transcript = React.lazy(() => new Promise(resolve => { window.finishLazy = () => resolve({ default() { return <p>Lazy transcript ready</p>; } }); }));
    return { modules: [], overrides: { transcript: Transcript }, dispose() {} };`));
  await wait(() => page.evaluate(() => typeof window.finishLazy === 'function'), 'lazy import'); await page.getByLabel('Messages', { exact: true }).waitFor();
  await draft(page, 'Lazy draft'); const previous = await editor(page).elementHandle();
  await page.evaluate(() => window.finishLazy()); await page.getByText('Lazy transcript ready', { exact: true }).waitFor();
  await unchanged(page, previous, 'Lazy draft'); assert.equal(await page.getByLabel('Messages', { exact: true }).count(), 0);
});

test('overridden live conversation retains approval, Stop and uncertain recovery controls through failure and immediate disable', { timeout: 45_000 }, async t => {
  const { build } = await import('esbuild'), { chromium } = await import('playwright');
  const bundle = await build({ stdin: { contents: `import React from 'react'; import { createRoot } from 'react-dom/client'; import { flushSync } from 'react-dom';
    import { ConversationView } from './apps/desktop/src/application/ConversationView.tsx';
    import { useDesktopCustomizations } from './apps/desktop/src/application/DesktopCustomizations.tsx';
    const scope = { hostId: 'test', conversationId: 'live' }, listeners = new Set();
    let view = { submitting: [], outbox: [], draft: 'Live draft', connection: { kind: 'connected' }, cursor: 1,
      document: { domain: { messages: [], currentRun: { kind: 'running', runId: 'original-run' } },
        decisions: { pending: { pendingId: 'pending', prompt: 'Live approval', choices: ['allow'], reserved: false } }, receipts: {} } };
    const publish = () => { for (const listener of listeners) listener(); };
    window.calls = []; window.disposals = 0; window.activations = 0;
    const store = { getSnapshot: () => view, subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
      async setDraft(draft) { view = { ...view, draft }; publish(); },
      async cancel(runId) { window.calls.push(runId); view = { ...view, outbox: [{ command: { version: 1, scope, clientCommandId: 'original-stop', body: { kind: 'cancel', runId } }, draftRevision: null }] }; publish(); },
      async approve(pendingId, choiceId) { window.calls.push([pendingId, choiceId]); }, async retry(id) { window.calls.push(id); } };
    const actions = { async submit(operation) { await operation(); }, async reconcile() {}, commands: {} };
    const active = { viewId: 'one', scope, store, agent: { commands: ['send', 'approve', 'cancel'], availability: { kind: 'ready' } } };
    function Broken() { throw new Error('Live failure'); }
    function Transcript() { const [broken, setBroken] = React.useState(false); return broken ? <Broken /> : <button onClick={() => setBroken(true)}>Fail live transcript</button>; }
    const customizations = [{ manifest: { namespace: 'live', sdkVersion: '0.2.0', entries: [{kind: 'desktop', module: './desktop.js'}] },
      load: async () => ({ default: { kind: 'desktop', sdkVersion: '0.2.0', activate() { window.activations++; return { modules: [], overrides: { transcript: Transcript }, dispose() { window.disposals++; } }; } } }) }];
    function App() { const [enabled, setEnabled] = React.useState(true); window.disable = () => flushSync(() => setEnabled(false)); window.enable = () => flushSync(() => setEnabled(true));
      const custom = useDesktopCustomizations({ customizations, enabled });
      return <ConversationView active={active} actions={actions} enabled storageFailure="" agent="codex" transcript={custom.transcript} />; }
    createRoot(document.getElementById('root')).render(<App />);`, resolveDir: root, loader: 'jsx' }, bundle: true, write: false, jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' } });
  const browser = await chromium.launch(); t.after(() => browser.close()); const page = await browser.newPage();
  await page.route('http://localhost/fixture', route => route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' }));
  await page.goto('http://localhost/fixture'); await page.addScriptTag({ content: bundle.outputFiles[0].text });
  await page.getByRole('button', { name: 'Fail live transcript', exact: true }).waitFor();
  const previous = await editor(page).elementHandle(), stop = await page.getByRole('button', { name: 'Stop', exact: true }).elementHandle();
  const approval = await page.getByRole('region', { name: 'Approval required', exact: true }).elementHandle();
  await page.getByRole('button', { name: 'allow', exact: true }).click();
  await page.getByRole('button', { name: 'Stop', exact: true }).evaluate(button => { button.click(); button.click(); });
  await page.getByRole('button', { name: 'Retry original command', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Fail live transcript', exact: true }).click(); await page.getByLabel('Messages', { exact: true }).waitFor();
  await unchanged(page, previous, 'Live draft');
  assert.equal(await page.getByRole('button', { name: 'Stopping…', exact: true }).evaluate((node, old) => node === old, stop), true);
  assert.equal(await page.getByRole('region', { name: 'Approval required', exact: true }).evaluate((node, old) => node === old, approval), true);
  await page.getByRole('button', { name: 'Retry original command', exact: true }).click();
  await page.evaluate(() => window.disable()); await unchanged(page, previous, 'Live draft');
  assert.deepEqual(await page.evaluate(() => window.calls), [['pending', 'allow'], 'original-run', 'original-stop']);
  assert.equal(await page.evaluate(() => window.disposals), 1);
  await page.evaluate(() => window.enable()); await page.getByRole('button', { name: 'Fail live transcript', exact: true }).waitFor();
  await unchanged(page, previous, 'Live draft'); assert.equal(await page.evaluate(() => window.activations), 2);
  await page.evaluate(() => window.disable()); assert.equal(await page.getByRole('button', { name: 'Fail live transcript', exact: true }).count(), 0);
  assert.equal(await page.evaluate(() => window.disposals), 2);
});

test('nested module and action capture survives author mutation through real shell and conversation rerenders', { timeout: 45_000 }, async t => {
  const { host, page } = await open(t);
  await customRuntime(page, host, entry(`class Action {
    #text = 'Captured nested command'; id = 'send'; label = 'Send captured';
    run({ commands }) { return commands.send(this.#text); }
  }
  class Contribution {
    #disposed = false;
    modules = [{ id: 'root', label: 'Captured root', component() { return <p>Captured root content</p>; },
      children: [{ id: 'child', label: 'Captured child', component() { return <p>Captured child content</p>; }, actions: [new Action()] }] }];
    overrides = { transcript() { return <p>Captured mutation transcript</p>; } };
    dispose() { if (this.#disposed) throw new Error('Repeated cleanup'); this.#disposed = true; window.disposals = (window.disposals || 0) + 1; }
  }
  const contribution = new Contribution();
  window.mutate = () => {
    const root = contribution.modules[0], child = root.children[0], action = child.actions[0];
    root.label = 'Changed root'; root.component = () => <p>Changed root content</p>;
    child.label = 'Changed child'; child.component = () => <p>Changed child content</p>;
    action.label = 'Changed action'; action.run = () => { throw new Error('Changed action invoked'); };
    child.actions.length = 0; root.children.length = 0; contribution.modules.length = 0;
    contribution.overrides.transcript = () => <p>Changed transcript</p>;
  };
  return contribution;`));
  await page.getByText('Captured mutation transcript', { exact: true }).waitFor();
  await page.getByText('Captured child content', { exact: true }).waitFor();
  await draft(page, 'Mutation draft'); const previous = await editor(page).elementHandle();
  await page.evaluate(() => window.mutate());
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('heading', { name: 'Settings', exact: true, level: 1 }).waitFor();
  await page.getByRole('button', { name: 'Chats', exact: true }).click();
  await page.getByText('Captured child content', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Send captured', exact: true }).click();
  await page.getByRole('heading', { name: 'Approval required', exact: true }).waitFor();
  await page.getByText('Captured mutation transcript', { exact: true }).waitFor();
  await unchanged(page, previous, 'Mutation draft');
  assert.equal((await host.entries()).length, 1);
  assert.equal(await page.getByText(/Changed (root|child|transcript)/).count(), 0);
  await revealRecovery(page); await page.getByRole('button', { name: 'Restore default view', exact: true }).click();
  await wait(() => page.evaluate(() => window.disposals === 1), 'mutated contribution disposal');
  await unchanged(page, previous, 'Mutation draft');
});

test('StrictMode delayed same-array reactivation never remounts an obsolete transcript and disposes late malformed results', { timeout: 45_000 }, async t => {
  const { build } = await import('esbuild'), { chromium } = await import('playwright');
  const bundle = await build({ stdin: { contents: `import React from 'react'; import { createRoot } from 'react-dom/client'; import { flushSync } from 'react-dom';
    import { CustomizationTranscript, useDesktopCustomizations } from './apps/desktop/src/application/DesktopCustomizations.tsx';
    window.activations = 0; window.loads = 0; window.disposals = []; window.mounts = []; window.finish = {};
    const customizations = [{ manifest: { namespace: 'strict', sdkVersion: '0.2.0', entries: [{ kind: 'desktop', module: './desktop.js' }] },
      load: async () => { window.loads++; return { default: { kind: 'desktop', sdkVersion: '0.2.0', activate() {
        const id = ++window.activations; let disposed = false;
        function Transcript() { React.useLayoutEffect(() => { window.mounts.push({ id, disposed }); }, []); return <p>Owner {id}</p>; }
        return new Promise(resolve => { window.finish[id] = malformed => resolve({ modules: [],
          get overrides() { if (malformed) throw new Error('Late malformed presentation'); return { transcript: Transcript }; },
          dispose() { disposed = true; window.disposals.push(id); if (id === 3) return Promise.reject(new Error('Late cleanup rejection')); } }); });
      } } }; } }];
    function App() { const [enabled, setEnabled] = React.useState(true);
      window.disable = () => flushSync(() => setEnabled(false)); window.enable = () => flushSync(() => setEnabled(true));
      const custom = useDesktopCustomizations({ customizations, enabled });
      return <><input aria-label="Persistent draft" defaultValue="Strict draft" />
        {custom.namespaces.filter(owner => owner.kind === 'failed').map(owner => <p role="alert" key={owner.namespace}>{owner.message}</p>)}
        <CustomizationTranscript selection={custom.transcript} context={{}} conversationKey="strict" fallback={<p>Default transcript</p>} /></>;
    }
    createRoot(document.getElementById('root')).render(<React.StrictMode><App /></React.StrictMode>);`, resolveDir: root, loader: 'jsx' },
    bundle: true, write: false, jsx: 'automatic', define: { 'process.env.NODE_ENV': '"development"' } });
  const browser = await chromium.launch(); t.after(() => browser.close()); const page = await browser.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('http://localhost/fixture', route => route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' }));
  await page.goto('http://localhost/fixture'); await page.addScriptTag({ content: bundle.outputFiles[0].text });
  await wait(() => page.evaluate(() => window.activations === 1), 'StrictMode activation');
  assert.equal(await page.evaluate(() => window.loads), 2);
  await page.evaluate(() => window.finish[1](false)); await page.getByText('Owner 1', { exact: true }).waitFor();
  const previous = await page.getByRole('textbox', { name: 'Persistent draft' }).elementHandle();
  const mounts = await page.evaluate(() => window.mounts);
  await page.evaluate(() => { window.disable(); window.enable(); });
  await wait(() => page.evaluate(() => window.activations === 2), 'same-array delayed reactivation');
  await page.getByText('Default transcript', { exact: true }).waitFor();
  assert.deepEqual(await page.evaluate(() => window.mounts), mounts);
  assert.deepEqual(await page.evaluate(() => window.disposals), [1]);
  await page.evaluate(() => window.finish[2](false)); await page.getByText('Owner 2', { exact: true }).waitFor();
  await page.evaluate(() => { window.disable(); window.enable(); });
  await wait(() => page.evaluate(() => window.activations === 3), 'pending obsolete activation');
  await page.evaluate(() => { window.disable(); window.enable(); });
  await wait(() => page.evaluate(() => window.activations === 4), 'replacement activation');
  await page.evaluate(() => window.finish[4](false)); await page.getByText('Owner 4', { exact: true }).waitFor();
  await page.evaluate(() => window.finish[3](true));
  await wait(() => page.evaluate(() => window.disposals.includes(3)), 'late malformed cleanup');
  await page.getByText('Owner 4', { exact: true }).waitFor(); assert.equal(await page.getByRole('alert').count(), 0);
  await page.evaluate(() => window.disable()); await page.getByText('Default transcript', { exact: true }).waitFor();
  assert.deepEqual(await page.evaluate(() => window.disposals), [1, 2, 3, 4]);
  assert.equal(await page.evaluate(() => window.mounts.every(mount => !mount.disposed && mount.id !== 3)), true);
  assert.equal(await page.getByRole('textbox', { name: 'Persistent draft' }).evaluate((node, old) => node === old, previous), true);
  assert.equal(await page.getByRole('textbox', { name: 'Persistent draft' }).inputValue(), 'Strict draft'); assert.deepEqual(errors, []);
});
