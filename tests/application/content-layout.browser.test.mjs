import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { repository, buildCustom } from '../customization/build/support.mjs';
import { root, fixture, connected, draft, revealRecovery, customRuntime, wait } from './browser-support.mjs';

const editor = page => page.getByRole('textbox', { name: 'Message', exact: true });
async function unchanged(page, previous, text) {
  assert.equal(await editor(page).evaluate((node, old) => node === old, previous), true);
  assert.equal(await editor(page).inputValue(), text);
}

test('committed layout arranges selected transcript and nested action with protected draft through failure and restore', { timeout: 90_000 }, async t => {
  const custom = repository(), child = repository();
  t.after(() => Promise.all([custom, child].map(value => rm(value.directory, { recursive: true, force: true }))));
  const childManifest = JSON.parse(await readFile(join(child.repo, 'package.json'), 'utf8'));
  childManifest.agentui.extension.namespace = 'transcript';
  child.write('package.json', JSON.stringify(childManifest));
  child.write('desktop/index.tsx', await readFile(join(root, 'tests/application/fixtures/transcript-override.tsx'), 'utf8'));
  const parentManifest = JSON.parse(await readFile(join(custom.repo, 'package.json'), 'utf8'));
  parentManifest.agentui.extensions = [{ repository: child.repo, commit: child.commit() }];
  custom.write('package.json', JSON.stringify(parentManifest));
  const template = await readFile(join(custom.repo, 'desktop/index.tsx'), 'utf8');
  custom.write('desktop/index.tsx', template.replace("import { createElement }", "import { createElement, useState }")
    .replace("function ReviewLayout({ transcript, modules }: ConversationContentLayoutProps) {", `function ReviewLayout({ transcript, modules }: ConversationContentLayoutProps) {
      const [broken, setBroken] = useState(false); if (broken) throw new Error('Committed layout failed');`)
    .replace("createElement('div', { className: 'review-transcript' }, transcript)", "createElement('div', { className: 'review-transcript' }, createElement('button', { onClick: () => setBroken(true) }, 'Fail committed layout'), transcript)"));
  const commit = custom.commit();
  child.write('desktop/index.tsx', 'throw new Error("Dirty source must not enter artifact");');
  buildCustom(custom, commit);
  const host = await fixture(t, join(custom.directory, 'browser')), page = await host.page();
  await page.getByRole('button', { name: 'New recorded conversation' }).click(); await connected(page);
  const transcript = page.getByRole('region', { name: 'Committed transcript' });
  await transcript.waitFor(); assert.equal(await page.getByLabel('Messages', { exact: true }).count(), 0);
  const main = await page.locator('.review-layout > .review-transcript').boundingBox(), aside = await page.locator('.review-layout > aside').boundingBox();
  assert.ok(main.x + main.width <= aside.x); assert.ok(Math.abs(main.y - aside.y) < 2);
  assert.equal(await page.locator('.review-layout > .review-transcript').evaluate(node => getComputedStyle(node).padding), '0px');
  assert.equal(await page.locator('.conversation-content [data-customization-state]').count(), 2);
  assert.equal(await page.locator('.conversation-content').evaluate(node => {
    const authored = document.createElement('main'); node.append(authored);
    const padding = getComputedStyle(authored).padding; authored.remove(); return padding;
  }), '0px');
  await page.screenshot({ path: join(root, '.audit/conversation-layout/implementation/desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 720, height: 600 });
  const narrowMain = await page.locator('.review-layout > .review-transcript').boundingBox(), narrowAside = await page.locator('.review-layout > aside').boundingBox();
  assert.ok(narrowAside.y >= narrowMain.y + narrowMain.height);
  await page.screenshot({ path: join(root, '.audit/conversation-layout/implementation/narrow.png'), fullPage: true });
  const viewport = page.locator('.conversation-content');
  const composerY = (await page.locator('.composer').boundingBox()).y;
  await page.getByRole('heading', { name: 'Review guidance', exact: true }).scrollIntoViewIfNeeded();
  assert.ok(await viewport.evaluate(node => node.scrollTop > 0));
  assert.equal((await page.locator('.composer').boundingBox()).y, composerY);
  await page.screenshot({ path: join(root, '.audit/conversation-layout/implementation/narrow-scrolled.png'), fullPage: true });
  await page.setViewportSize({ width: 1280, height: 800 });
  await draft(page, 'Artifact draft'); const previous = await editor(page).elementHandle();
  await page.getByRole('button', { name: 'Review the plan', exact: true }).click();
  await transcript.getByText('Review our current plan. Identify the next useful step and any unresolved decision.', { exact: true }).waitFor();
  await page.getByRole('heading', { name: 'Approval required', exact: true }).waitFor();
  await unchanged(page, previous, 'Artifact draft'); assert.equal((await host.entries()).length, 1);
  const approval = await page.getByRole('region', { name: 'Approval required', exact: true }).elementHandle();
  await page.getByRole('button', { name: 'Fail committed layout', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: 'Committed layout failed' }).waitFor();
  await unchanged(page, previous, 'Artifact draft');
  assert.equal(await page.getByRole('region', { name: 'Approval required', exact: true }).evaluate((node, old) => node === old, approval), true);
  await transcript.waitFor();
  await revealRecovery(page); await page.getByRole('button', { name: 'Restore default view', exact: true }).click();
  await page.getByLabel('Messages', { exact: true }).waitFor();
  assert.equal(await transcript.count(), 0); assert.equal(await page.getByRole('button', { name: 'Review the plan', exact: true }).count(), 0);
  await unchanged(page, previous, 'Artifact draft'); assert.equal((await host.entries()).length, 1);
  assert.equal(await page.getByRole('region', { name: 'Approval required', exact: true }).evaluate((node, old) => node === old, approval), true);
});

test('layout activation, initial and retained suspension preserve protected DOM and never duplicate extension trees', { timeout: 45_000 }, async t => {
  const { build } = await import('esbuild'), { chromium } = await import('playwright');
  const bundle = await build({ stdin: { contents: `import React from 'react'; import { createRoot } from 'react-dom/client'; import { flushSync } from 'react-dom';
    import './apps/desktop/src/application/application.css'; import './apps/desktop/src/shell/styles.css';
    import { DesktopShell } from './apps/desktop/src/shell/Shell.tsx';
    import { ConversationView } from './apps/desktop/src/application/ConversationView.tsx';
    import { CustomizationModules } from './apps/desktop/src/application/CustomizationModules.tsx';
    import { useDesktopCustomizations } from './apps/desktop/src/application/DesktopCustomizations.tsx';
    const scope = { hostId: 'test', conversationId: 'live' }, listeners = new Set();
    let view = { submitting: [], outbox: [], draft: 'Live draft', connection: { kind: 'connected' }, cursor: 1,
      document: { domain: { messages: [], currentRun: { kind: 'running', runId: 'original-run' } },
        decisions: { pending: { pendingId: 'pending', prompt: 'Live approval', choices: ['allow'], reserved: false } }, receipts: {} } };
    const publish = () => { for (const listener of listeners) listener(); };
    window.longContent = () => { view = { ...view, document: { ...view.document,
      domain: { ...view.document.domain, messages: Array.from({ length: 30 }, (_, i) => ({ messageId: String(i), role: 'assistant', text: 'Long response '.repeat(60), complete: true })) },
      decisions: Object.fromEntries(Array.from({ length: 8 }, (_, i) => ['pending' + i, { pendingId: 'pending' + i, prompt: 'Approval ' + i, choices: ['allow'], reserved: false }])) } }; publish(); };
    window.calls = []; window.disposals = 0; window.activations = 0;
    const store = { getSnapshot: () => view, subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
      async setDraft(draft) { view = { ...view, draft }; publish(); },
      async cancel(runId) { window.calls.push(runId); view = { ...view, outbox: [{ command: { version: 1, scope, clientCommandId: 'original-stop', body: { kind: 'cancel', runId } }, draftRevision: null }] }; publish(); },
      async approve(pendingId, choiceId) { window.calls.push([pendingId, choiceId]); }, async retry(id) { window.calls.push(id); } };
    const actions = { async submit(operation) { await operation(); }, async reconcile() {}, commands: {} };
    const active = { viewId: 'one', scope, store, agent: { commands: ['send', 'approve', 'cancel'], availability: { kind: 'ready' } } };
    window.transcriptInstances = []; window.moduleInstances = []; let identity = 0;
    function Tracked({ kind }) { const [id] = React.useState(() => ++identity); React.useEffect(() => { window[kind + 'Instances'].push(id); }, []); return <p>{kind + ' content'}</p>; }
    let suspended = true, gate; const resetGate = () => { gate = new Promise(resolve => { window.resume = () => { suspended = false; resolve(); }; }); }; resetGate();
    function Layout({ transcript, modules }) {
      const [version, refresh] = React.useReducer(x => x + 1, 0), [broken, fail] = React.useState(false);
      window.suspend = () => { suspended = true; resetGate(); refresh(); };
      if (suspended) throw gate;
      return broken ? <Broken /> : <div data-layout={version}><button onClick={() => fail(true)}>Fail live layout</button>{transcript}{modules}</div>;
    }
    function Broken() { throw new Error('Live failure'); }
    const customizations = [{ manifest: { namespace: 'live', sdkVersion: '0.5.0', entries: [{kind: 'desktop', module: './desktop.js'}] },
      load: async () => ({ default: { kind: 'desktop', sdkVersion: '0.5.0', activate() { window.activations++; return new Promise(resolve => { window.activateLayout = () => resolve({ contentLayout: Layout, modules: [{ id: 'tracked', label: 'Tracked', component() { return <Tracked kind="module" />; } }], overrides: { transcript() { return <Tracked kind="transcript" />; } }, dispose() { window.disposals++; } }); }); } } }) }];
    function App() { const [enabled, setEnabled] = React.useState(true); window.disable = () => flushSync(() => setEnabled(false)); window.enable = () => flushSync(() => setEnabled(true));
      const custom = useDesktopCustomizations({ customizations, enabled });
      return <DesktopShell protectedContent={<aside className="application-controls">Protected navigation</aside>} defaultView={<div className="chat-view"><ConversationView active={active} actions={actions} enabled storageFailure="" agent="codex" transcript={custom.transcript} contentLayout={custom.contentLayout} modules={custom.namespaces.map(owner => <CustomizationModules key={owner.namespace} owner={owner} active={active} actions={actions} enabled agent="codex" />)} /></div>} restoreMode="managed" onRestore={() => setEnabled(false)} />; }
    createRoot(document.getElementById('root')).render(<App />);`, resolveDir: root, loader: 'jsx' }, bundle: true, write: false, outfile: 'fixture.js', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' } });
  const browser = await chromium.launch(); t.after(() => browser.close()); const page = await browser.newPage();
  await page.route('http://localhost/fixture', route => route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' }));
  await page.goto('http://localhost/fixture'); await page.addStyleTag({ content: bundle.outputFiles.find(file => file.path.endsWith('.css')).text }); await page.addScriptTag({ content: bundle.outputFiles.find(file => file.path.endsWith('.js')).text });
  await page.getByLabel('Messages', { exact: true }).waitFor();
  const previous = await editor(page).elementHandle(), stop = await page.getByRole('button', { name: 'Stop', exact: true }).elementHandle();
  const approval = await page.getByRole('region', { name: 'Approval required', exact: true }).elementHandle();
  const stable = async () => {
    await unchanged(page, previous, 'Live draft');
    assert.equal(await page.getByRole('button', { name: 'Stop', exact: true }).evaluate((node, old) => node === old, stop), true);
    assert.equal(await page.getByRole('region', { name: 'Approval required', exact: true }).evaluate((node, old) => node === old, approval), true);
  };
  await wait(() => page.evaluate(() => typeof window.activateLayout === 'function'), 'layout activation gate');
  await page.evaluate(() => window.activateLayout());
  await page.getByRole('status').filter({ hasText: 'Content layout is loading' }).waitFor();
  assert.deepEqual(await page.evaluate(() => [window.transcriptInstances, window.moduleInstances]), [[], []]); await stable();
  await page.evaluate(() => window.resume()); await page.getByText('module content', { exact: true }).waitFor();
  await wait(() => page.evaluate(() => window.moduleInstances.length === 1 && window.transcriptInstances.length === 1), 'first extension mounts');
  const instances = await page.evaluate(() => [window.transcriptInstances, window.moduleInstances]); await stable();
  await page.evaluate(() => window.suspend()); await page.getByRole('status').filter({ hasText: 'Content layout is loading' }).waitFor();
  await page.getByLabel('Messages', { exact: true }).waitFor();
  assert.deepEqual(await page.evaluate(() => [window.transcriptInstances, window.moduleInstances]), instances); await stable();
  assert.equal(await page.evaluate(() => window.disposals), 0);
  await page.evaluate(() => window.resume()); await page.getByRole('button', { name: 'Fail live layout', exact: true }).waitFor();
  assert.deepEqual(await page.evaluate(() => [window.transcriptInstances, window.moduleInstances]), instances); await stable();
  await page.getByRole('button', { name: 'Fail live layout', exact: true }).click(); await page.getByLabel('Messages', { exact: true }).waitFor();
  await wait(() => page.evaluate(() => window.disposals === 1), 'layout failure cleanup'); await stable();
  await page.evaluate(() => window.disable()); await stable();
  assert.equal(await page.evaluate(() => window.disposals), 1); assert.deepEqual(await page.evaluate(() => window.calls), []);
  await page.evaluate(() => window.longContent());
  await page.setViewportSize({ width: 1280, height: 800 });
  const viewport = page.locator('.conversation-content'), panel = page.locator('.conversation-panel');
  assert.ok(await viewport.evaluate(node => node.scrollHeight > node.clientHeight));
  const position = (await page.locator('.composer').boundingBox()).y;
  await viewport.evaluate(node => { node.scrollTop = node.scrollHeight; });
  assert.equal((await page.locator('.composer').boundingBox()).y, position);
  for (const size of [{ width: 1280, height: 800 }, { width: 720, height: 600 }, { width: 520, height: 320 }]) {
    await page.setViewportSize(size);
    await page.getByRole('region', { name: 'Approval required', exact: true }).last().scrollIntoViewIfNeeded();
    assert.ok(await page.getByText('Approval 7', { exact: true }).isVisible());
    await editor(page).scrollIntoViewIfNeeded();
    const box = await editor(page).boundingBox(); assert.ok(box.y >= 0 && box.y + box.height <= size.height);
    await page.getByRole('button', { name: 'Stop', exact: true }).scrollIntoViewIfNeeded();
    const stopBox = await page.getByRole('button', { name: 'Stop', exact: true }).boundingBox(); assert.ok(stopBox.y >= 0 && stopBox.y + stopBox.height <= size.height);
    assert.ok(await panel.evaluate(node => node.scrollHeight > node.clientHeight));
  }
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  const retry = page.getByRole('button', { name: 'Retry original command', exact: true });
  await retry.scrollIntoViewIfNeeded();
  assert.equal(await retry.evaluate(node => node.closest('.conversation-content') === null), true);
  const retryBox = await retry.boundingBox(); assert.ok(retryBox.y >= 0 && retryBox.y + retryBox.height <= 320);
  const recovery = page.locator('.recovery-menu'); await recovery.locator('summary').click();
  assert.ok(await recovery.getByRole('button', { name: 'Restore default view', exact: true }).isVisible());
  await recovery.locator('summary').click();
  await page.screenshot({ path: join(root, '.audit/conversation-layout/implementation/short-controls.png'), fullPage: false });
});

const entry = body => `load: async () => ({ default: { kind: 'desktop', sdkVersion: '0.5.0', activate() { ${body} } } })`;
const arranged = `function Layout({ transcript, modules }) { return <section aria-label="Selected layout"><main>{transcript}</main><aside>{modules}</aside></section>; }`;
async function open(t) {
  const host = await fixture(t), page = await host.page();
  await page.getByRole('button', { name: 'New recorded conversation' }).click(); await connected(page);
  return { host, page };
}
for (const order of [['fixture', 'alpha'], ['alpha', 'fixture']]) test(`layout conflicts wait for all owners and sort diagnostics after ${order.join(' then ')}`, { timeout: 45_000 }, async t => {
  const { host, page } = await open(t);
  const activation = name => entry(`${arranged} return new Promise(resolve => { window['finish_' + '${name}'] = () => resolve({ modules: [], contentLayout: Layout, dispose() {} }); });`);
  await customRuntime(page, host, activation('fixture'), false, `, { manifest: { ...manifest, namespace: 'alpha' }, ${activation('alpha')} }`);
  await wait(() => page.evaluate(() => typeof window.finish_alpha === 'function'), 'conflicting activations');
  await draft(page, 'Conflict draft'); const previous = await editor(page).elementHandle();
  await page.evaluate(name => window['finish_' + name](), order[0]);
  await page.getByLabel('Messages', { exact: true }).waitFor();
  assert.equal(await page.getByRole('region', { name: 'Selected layout' }).count(), 0);
  await page.evaluate(name => window['finish_' + name](), order[1]);
  await page.getByRole('alert').filter({ hasText: 'alpha, fixture claim the layout' }).waitFor();
  assert.equal(await page.locator('.conversation-content [data-customization-state="ready"]').count(), 2);
  await unchanged(page, previous, 'Conflict draft'); assert.deepEqual(await host.entries(), []);
});
for (const shared of [false, true]) test(`nested module failure ${shared ? 'retires shared layout' : 'preserves unrelated layout'}`, { timeout: 45_000 }, async t => {
  const { host, page } = await open(t);
  const module = `{ id: 'bad', label: 'Bad', component() { const [broken, fail] = React.useState(false); if (broken) throw new Error('Module descendant failed'); return <button onClick={() => fail(true)}>Fail module</button>; } }`;
  await customRuntime(page, host, entry(`${arranged} return { contentLayout: Layout, modules: ${shared ? '[' + module + ']' : '[]'}, dispose() { window.layoutDisposals = (window.layoutDisposals || 0) + 1; } };`), false,
    shared ? '' : `, { manifest: { ...manifest, namespace: 'module-owner' }, ${entry(`return { modules: [${module}], dispose() { window.moduleDisposals = (window.moduleDisposals || 0) + 1; } };`)} }`);
  await page.getByRole('region', { name: 'Selected layout' }).waitFor();
  await draft(page, 'Module failure draft'); const previous = await editor(page).elementHandle();
  await page.getByRole('button', { name: 'Fail module', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: 'Module descendant failed' }).waitFor();
  await wait(() => page.evaluate(shared => shared ? window.layoutDisposals === 1 : window.moduleDisposals === 1, shared), 'failed namespace cleanup');
  assert.equal(await page.getByRole('region', { name: 'Selected layout' }).count(), shared ? 0 : 1);
  assert.equal(await page.evaluate(() => window.layoutDisposals || 0), shared ? 1 : 0);
  await unchanged(page, previous, 'Module failure draft'); assert.deepEqual(await host.entries(), []);
});
for (const shared of [false, true]) test(`transcript failure ${shared ? 'retires shared layout' : 'preserves unrelated layout'}`, { timeout: 45_000 }, async t => {
  const { host, page } = await open(t);
  const broken = `function Transcript() { const [broken, fail] = React.useState(false); if (broken) throw new Error('Selected transcript failed'); return <button onClick={() => fail(true)}>Fail selected transcript</button>; }`;
  await customRuntime(page, host, entry(`${arranged} ${broken} return { contentLayout: Layout, modules: [], ${shared ? 'overrides: { transcript: Transcript },' : ''} dispose() { window.layoutDisposals = (window.layoutDisposals || 0) + 1; } };`), false,
    shared ? '' : `, { manifest: { ...manifest, namespace: 'transcript-owner' }, ${entry(`${broken} return { modules: [], overrides: { transcript: Transcript }, dispose() { window.transcriptDisposals = (window.transcriptDisposals || 0) + 1; } };`)} }`);
  await page.getByRole('region', { name: 'Selected layout' }).waitFor();
  await draft(page, 'Transcript failure draft'); const previous = await editor(page).elementHandle();
  await page.getByRole('button', { name: 'Fail selected transcript', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: 'Selected transcript failed' }).waitFor();
  await page.getByLabel('Messages', { exact: true }).waitFor();
  await wait(() => page.evaluate(shared => shared ? window.layoutDisposals === 1 : window.transcriptDisposals === 1, shared), 'transcript namespace cleanup');
  assert.equal(await page.getByRole('region', { name: 'Selected layout' }).count(), shared ? 0 : 1);
  await unchanged(page, previous, 'Transcript failure draft'); assert.deepEqual(await host.entries(), []);
});

for (const reject of [false, true]) test(`lazy layout ${reject ? 'rejection releases its owner' : 'resolution supplies both nodes'} without changing editor`, { timeout: 45_000 }, async t => {
  const { host, page } = await open(t);
  await customRuntime(page, host, entry(`${arranged} const Lazy = React.lazy(() => new Promise((resolve, reject) => { window.finishLazy = () => ${reject ? "reject(new Error('Lazy layout rejected'))" : 'resolve({ default: Layout })'}; }));
    return { contentLayout: Lazy, modules: [{ id: 'lazy', label: 'Lazy module', component() { return <p>Lazy module ready</p>; } }], dispose() { window.disposals = (window.disposals || 0) + 1; } };`));
  await page.getByRole('status').filter({ hasText: 'Content layout is loading' }).waitFor();
  await draft(page, 'Lazy layout draft'); const previous = await editor(page).elementHandle();
  assert.equal(await page.getByText('Lazy module ready', { exact: true }).count(), 0);
  await page.evaluate(() => window.finishLazy());
  if (reject) {
    await page.getByRole('alert').filter({ hasText: 'Lazy layout rejected' }).waitFor();
    await wait(() => page.evaluate(() => window.disposals === 1), 'lazy rejection cleanup');
  } else {
    await page.getByRole('region', { name: 'Selected layout' }).waitFor();
    await page.getByText('Lazy module ready', { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => window.disposals || 0), 0);
  }
  await unchanged(page, previous, 'Lazy layout draft'); assert.deepEqual(await host.entries(), []);
});
for (const suspended of [false, true]) test(`restore during ${suspended ? 'layout suspension' : 'activation'} refuses late layout publication and retires once`, { timeout: 45_000 }, async t => {
  const { host, page } = await open(t);
  const value = `{ contentLayout: Layout, modules: [], dispose() { window.disposals = (window.disposals || 0) + 1; return Promise.reject(new Error('Late layout cleanup')); } }`;
  await customRuntime(page, host, entry(`${arranged} ${suspended ? `const Lazy = React.lazy(() => new Promise(resolve => { window.finish = () => resolve({ default: Layout }); })); return { ...${value}, contentLayout: Lazy };` : `return new Promise(resolve => { window.finish = () => resolve(${value}); });`}`));
  await wait(() => page.evaluate(() => typeof window.finish === 'function'), 'pending layout');
  await draft(page, 'Late layout draft'); const previous = await editor(page).elementHandle(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await revealRecovery(page); await page.getByRole('button', { name: 'Restore default view', exact: true }).click();
  await page.evaluate(() => window.finish());
  await wait(() => page.evaluate(() => window.disposals === 1), 'late layout cleanup');
  assert.equal(await page.getByRole('region', { name: 'Selected layout' }).count(), 0);
  await unchanged(page, previous, 'Late layout draft'); assert.deepEqual(errors, []); assert.deepEqual(await host.entries(), []);
});

const status = (page, label) => page.getByRole('status', { name: `${label} status`, exact: true });
test('layout navigation preserves scope fencing while nested action is pending', { timeout: 45_000 }, async t => {
  const host = await fixture(t), page = await host.page();
  await page.getByRole('button', { name: 'New recorded conversation' }).click();
  await connected(page);
  await customRuntime(page, host, entry(`${arranged} window.contexts = []; return { contentLayout: Layout, modules: [{ id: 'context', label: 'Context', component() { return null; },
    actions: [{ id: 'run', label: 'Context action', run(context) { window.contexts.push(context);
      if (window.sendNow) return context.commands.send('New conversation action');
      return new Promise(resolve => { window.finishOld = resolve; }); } }] }], dispose() {} };`));
  const first = await page.locator('.scope-label').textContent();
  await page.getByRole('button', { name: 'Context action', exact: true }).click();
  await status(page, 'Context action').filter({ hasText: 'Submitting…' }).waitFor();
  await page.getByRole('button', { name: 'New recorded conversation' }).click();
  await wait(async () => await page.locator('.scope-label').textContent() !== first, 'next action context');
  await connected(page);
  const second = await page.locator('.scope-label').textContent();
  await draft(page, 'New conversation draft');
  await page.evaluate(() => window.finishOld({ kind: 'rejected', reason: 'OLD CONVERSATION RESULT' }));
  const refused = await page.evaluate(async () => {
    try { await window.contexts[0].commands.send('Old captured action'); return ''; } catch (error) { return error.message; }
  });
  assert.match(refused, /Open the command’s conversation/);
  assert.equal(await status(page, 'Context action').textContent(), '');
  await page.evaluate(() => { window.sendNow = true; });
  await page.getByRole('button', { name: 'Context action', exact: true }).click();
  await status(page, 'Context action').filter({ hasText: /^(Submitted|Submission pending|Command completed)\./ }).waitFor();
  await page.locator('.message-user p').filter({ hasText: 'New conversation action' }).waitFor();
  assert.deepEqual(await page.evaluate(() => window.contexts.map(context => context.conversation.conversationId)), [first, second]);
  assert.equal((await host.entries()).length, 1);
  assert.equal(await page.getByRole('textbox', { name: 'Message', exact: true }).inputValue(), 'New conversation draft');
});

test('StrictMode delayed same-array reactivation never remounts an obsolete layout and disposes late malformed results', { timeout: 45_000 }, async t => {
  const { build } = await import('esbuild'), { chromium } = await import('playwright');
  const bundle = await build({ stdin: { contents: `import React from 'react'; import { createRoot } from 'react-dom/client'; import { flushSync } from 'react-dom';
    import { CustomizationContent } from './apps/desktop/src/application/CustomizationContent.tsx';
    import { useDesktopCustomizations } from './apps/desktop/src/application/DesktopCustomizations.tsx';
    window.activations = 0; window.loads = 0; window.disposals = []; window.mounts = []; window.finish = {};
    const customizations = [{ manifest: { namespace: 'strict', sdkVersion: '0.5.0', entries: [{ kind: 'desktop', module: './desktop.js' }] },
      load: async () => { window.loads++; return { default: { kind: 'desktop', sdkVersion: '0.5.0', activate() {
        const id = ++window.activations; let disposed = false;
        function Layout() { React.useLayoutEffect(() => { window.mounts.push({ id, disposed }); }, []); return <p>Owner {id}</p>; }
        return new Promise(resolve => { window.finish[id] = malformed => resolve({ modules: [],
          get contentLayout() { if (malformed) throw new Error('Late malformed presentation'); return Layout; },
          dispose() { disposed = true; window.disposals.push(id); if (id === 3) return Promise.reject(new Error('Late cleanup rejection')); } }); });
      } } }; } }];
    function App() { const [enabled, setEnabled] = React.useState(true);
      window.disable = () => flushSync(() => setEnabled(false)); window.enable = () => flushSync(() => setEnabled(true));
      const custom = useDesktopCustomizations({ customizations, enabled });
      return <><input aria-label="Persistent draft" defaultValue="Strict draft" />
        {custom.namespaces.filter(owner => owner.kind === 'failed').map(owner => <p role="alert" key={owner.namespace}>{owner.message}</p>)}
        <CustomizationContent selection={custom.contentLayout} conversationKey="strict" transcript={<p>Default transcript</p>} nativeTranscript={<p>Native transcript</p>} modules={null} /></>;
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

test('layout render failure retains healthy modules and rejected cleanup once', { timeout: 45_000 }, async t => {
  const { host, page } = await open(t);
  await customRuntime(page, host, entry(`function Layout({ transcript, modules }) { const [broken, fail] = React.useState(false); if (broken) throw new Error('Layout descendant failed'); return <div><button onClick={() => fail(true)}>Fail layout</button>{transcript}{modules}</div>; }
    return { modules: [], contentLayout: Layout, dispose() { window.disposals = (window.disposals || 0) + 1; return Promise.reject(new Error('Layout cleanup rejected')); } };`), false,
    `, { manifest: { ...manifest, namespace: 'healthy' }, ${entry(`return { modules: [{ id: 'healthy', label: 'Healthy', component() { return <p>Healthy layout sibling</p>; } }], dispose() {} };`)} }`);
  await draft(page, 'Rejected cleanup draft'); const previous = await editor(page).elementHandle();
  await page.getByRole('button', { name: 'Fail layout', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: 'Layout cleanup rejected' }).waitFor();
  await page.getByText('Healthy layout sibling', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.disposals), 1); await unchanged(page, previous, 'Rejected cleanup draft');
  await revealRecovery(page); await page.getByRole('button', { name: 'Restore default view', exact: true }).click();
  assert.equal(await page.evaluate(() => window.disposals), 1); await unchanged(page, previous, 'Rejected cleanup draft');
  assert.deepEqual(await host.entries(), []);
});
