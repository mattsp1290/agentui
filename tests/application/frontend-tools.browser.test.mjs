import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { build } from 'esbuild';
import { EXTENSION_SDK_VERSION } from '@agentui/sdk';
import { chromium } from 'playwright';
import { repository, buildCustom } from '../customization/build/support.mjs';
import { root, fixture, connected, draft, revealRecovery, customRuntime, wait } from './browser-support.mjs';

const tool = `{ definition: { name: 'echo', description: 'Echo' }, decodeInput: x => x, async execute() { return 'ok'; } }`;
const entry = body => `load: async () => ({ default: { kind: 'desktop', sdkVersion: '${EXTENSION_SDK_VERSION}', activate({frontendTools}) { ${body} } } })`;
const sibling = `, { manifest: { ...manifest, namespace: 'sibling' }, ${entry(`return { modules: [{ id: 'healthy', label: 'Healthy', component() { return <p>Healthy namespace</p>; },
  actions: [{ id: 'send', label: 'Send sibling', run: ({commands}) => commands.send('Sibling command') }] }], dispose() {} };`)} }`;
const editor = page => page.getByRole('textbox', { name: 'Message', exact: true });
async function open(t) {
  const host = await fixture(t), page = await host.page();
  await page.getByRole('button', { name: 'New recorded conversation' }).click(); await connected(page);
  return { host, page };
}
async function unchanged(page, previous) {
  assert.equal(await editor(page).evaluate((node, old) => node === old, previous), true);
  assert.equal(await editor(page).inputValue(), 'Keep tool draft');
}

test('committed tool and module artifact loads in the actual application alongside sibling actions and composer', { timeout: 90_000 }, async t => {
  const custom = repository(), child = repository();
  t.after(() => Promise.all([custom, child].map(value => rm(value.directory, { recursive: true, force: true }))));
  const childManifest = JSON.parse(await readFile(join(child.repo, 'package.json'), 'utf8'));
  childManifest.agentui.extension.namespace = 'tools'; child.write('package.json', JSON.stringify(childManifest));
  child.write('desktop/index.tsx', await readFile(join(root, 'tests/application/fixtures/frontend-tools.tsx'), 'utf8'));
  const parentManifest = JSON.parse(await readFile(join(custom.repo, 'package.json'), 'utf8'));
  parentManifest.agentui.extensions = [{ repository: child.repo, commit: child.commit() }];
  custom.write('package.json', JSON.stringify(parentManifest)); const commit = custom.commit();
  child.write('desktop/index.tsx', 'throw new Error("Dirty source must not load");'); buildCustom(custom, commit);
  const host = await fixture(t, join(custom.directory, 'browser')), page = await host.page(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.getByRole('button', { name: 'New recorded conversation' }).click(); await connected(page);
  await page.getByRole('button', { name: 'Committed tool module 0', exact: true }).click();
  await page.getByRole('button', { name: 'Committed tool module 1', exact: true }).waitFor();
  await draft(page, 'Keep tool draft'); const previous = await editor(page).elementHandle();
  await page.getByRole('button', { name: 'Review the plan', exact: true }).click();
  await page.getByRole('heading', { name: 'Approval required', exact: true }).waitFor();
  await unchanged(page, previous); assert.equal((await host.entries()).length, 1);
  await revealRecovery(page); await page.getByRole('button', { name: 'Restore default view', exact: true }).click();
  assert.equal(await page.getByRole('button', { name: 'Committed tool module 1', exact: true }).count(), 0);
  await unchanged(page, previous); assert.deepEqual(errors, []);
});

for (const [label, registration] of [
  ['malformed', `try { frontendTools.add({...${tool}, definition:{name:'bad.name',description:''}}); } catch {}`],
  ['duplicate', `frontendTools.add(${tool}); try { frontendTools.add(${tool}); } catch {}`],
  ['presentation getter', `frontendTools.add(${tool});`],
]) test(`${label} activation failure stays local, captures once and observes rejected cleanup`, { timeout: 45_000 }, async t => {
  const { host, page } = await open(t); const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await customRuntime(page, host, entry(`return new Promise(resolve => { window.finish = () => {
    ${registration}
    resolve({ get modules() { window.moduleReads = (window.moduleReads || 0) + 1; ${label === 'presentation getter' ? "throw new Error('Presentation getter failed');" : 'return [];'} },
      get dispose() { window.disposeReads = (window.disposeReads || 0) + 1; return () => { window.disposals = (window.disposals || 0) + 1; return Promise.reject(new Error('Cleanup rejected')); }; } });
  }; });`), false, sibling);
  await page.getByText('Healthy namespace', { exact: true }).waitFor();
  await draft(page, 'Keep tool draft'); const previous = await editor(page).elementHandle();
  await page.evaluate(() => window.finish());
  await page.getByRole('alert').filter({ hasText: 'Custom tools could not load.' }).waitFor();
  await wait(() => page.evaluate(() => window.disposals === 1), 'failed activation cleanup');
  assert.deepEqual(await page.evaluate(() => [window.disposeReads, window.moduleReads ?? 0]), [1, label === 'presentation getter' ? 1 : 0]);
  await unchanged(page, previous);
  await page.getByRole('button', { name: 'Send sibling', exact: true }).click();
  await page.getByRole('heading', { name: 'Approval required', exact: true }).waitFor();
  await revealRecovery(page); await page.getByRole('button', { name: 'Restore default view', exact: true }).click();
  assert.equal(await page.evaluate(() => window.disposals), 1); await unchanged(page, previous); assert.deepEqual(errors, []);
});

const transcriptSibling = sibling.replace('dispose() {}', 'overrides: { transcript() { return <p>Healthy sibling transcript</p>; } }, dispose() {}');
for (const [label, registration, modules, message] of [
  ['invalid presentation', `frontendTools.add(${tool});`, 'null', 'Expected module array'],
  ['swallowed malformed', `try { frontendTools.add({...${tool}, definition:{name:'bad.name',description:''}}); } catch {}`, "[{id:'rejected',label:'Rejected',component(){return <p>Rejected tool module</p>}}]", 'Invalid tool name'],
  ['swallowed duplicate', `frontendTools.add(${tool}); try { frontendTools.add(${tool}); } catch {}`, "[{id:'rejected',label:'Rejected',component(){return <p>Rejected tool module</p>}}]", 'Duplicate tool name'],
]) for (const settlement of ['resolve', 'reject', 'remove then reject']) test(`${label} publishes failure before pending cleanup can ${settlement}`, { timeout: 45_000 }, async t => {
  const { host, page } = await open(t), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => { window.unhandled = []; window.addEventListener('unhandledrejection', event => window.unhandled.push(String(event.reason))); });
  await customRuntime(page, host, entry(`return new Promise(resolve => { window.finish = () => {
    ${registration}
    resolve({ get modules() { window.moduleReads = (window.moduleReads || 0) + 1; return ${modules}; },
      get dispose() { window.disposeReads = (window.disposeReads || 0) + 1; return () => {
        window.disposals = (window.disposals || 0) + 1;
        return new Promise((resolve, reject) => { window.resolveCleanup = resolve; window.rejectCleanup = () => reject(new Error('Deferred cleanup rejected')); });
      }; } });
  }; });`), false, transcriptSibling);
  await page.getByText('Healthy namespace', { exact: true }).waitFor();
  await draft(page, 'Keep tool draft'); const previous = await editor(page).elementHandle();
  assert.equal(await page.getByText('Healthy sibling transcript', { exact: true }).count(), 0);
  await page.evaluate(() => window.finish());
  await wait(() => page.evaluate(() => window.disposals === 1), 'pending failed cleanup');
  await page.getByRole('alert').filter({ hasText: message }).waitFor();
  await page.getByText('Healthy sibling transcript', { exact: true }).waitFor();
  assert.equal(await page.getByText('Rejected tool module', { exact: true }).count(), 0);
  assert.deepEqual(await page.evaluate(() => [window.disposeReads, window.moduleReads ?? 0]), [1, label === 'invalid presentation' ? 1 : 0]);
  await unchanged(page, previous);
  await page.getByRole('button', { name: 'Send sibling', exact: true }).click();
  await wait(async () => (await host.entries()).length === 1, 'sibling command during failed cleanup');
  await unchanged(page, previous);
  if (settlement === 'remove then reject') {
    await revealRecovery(page); await page.getByRole('button', { name: 'Restore default view', exact: true }).click();
  }
  await page.evaluate(settlement => settlement === 'resolve' ? window.resolveCleanup() : window.rejectCleanup(), settlement);
  await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 0)));
  if (settlement === 'remove then reject') {
    assert.equal(await page.getByRole('alert').filter({ hasText: 'Custom tools could not load.' }).count(), 0);
    await page.getByLabel('Messages', { exact: true }).waitFor();
  } else {
    const alert = page.getByRole('alert').filter({ hasText: settlement === 'resolve' ? message : 'Tool activation failed and its disposal also failed' });
    await alert.waitFor();
    const finalMessage = await alert.innerText();
    assert.ok(finalMessage.includes(message), `Final alert preserves primary failure: ${finalMessage}`);
    if (settlement === 'reject') assert.ok(finalMessage.includes('Deferred cleanup rejected'), `Final alert includes cleanup failure: ${finalMessage}`);
    await page.getByText('Healthy sibling transcript', { exact: true }).waitFor();
    await revealRecovery(page); await page.getByRole('button', { name: 'Restore default view', exact: true }).click();
  }
  await unchanged(page, previous); assert.equal(await page.evaluate(() => window.disposals), 1);
  assert.deepEqual(await page.evaluate(() => window.unhandled), []); assert.deepEqual(errors, []);
});

test('late tool activation after disable is never published and rejected retirement is observed', { timeout: 45_000 }, async t => {
  const { host, page } = await open(t); const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await customRuntime(page, host, entry(`frontendTools.add(${tool}); return new Promise(resolve => { window.finish = () => resolve({
    modules:[{id:'late',label:'Late',component(){return <p>Late tool module</p>}}],
    dispose(){window.disposals=(window.disposals||0)+1; return Promise.reject(new Error('Late cleanup rejected'));}
  }); });`));
  await wait(() => page.evaluate(() => typeof window.finish === 'function'), 'pending activation');
  await draft(page, 'Keep tool draft'); const previous = await editor(page).elementHandle();
  await revealRecovery(page); await page.getByRole('button', { name: 'Restore default view', exact: true }).click();
  await page.evaluate(() => window.finish()); await wait(() => page.evaluate(() => window.disposals === 1), 'late tool disposal');
  assert.equal(await page.getByText('Late tool module').count(), 0); await unchanged(page, previous); assert.deepEqual(errors, []);
});

test('in-process only: actual hook retirement retains original A pin and slow call across disable and fresh B activation', { timeout: 45_000 }, async t => {
  const bundle = await build({ stdin: { resolveDir: root, loader: 'jsx', contents: `
    import React from 'react'; import {createRoot} from 'react-dom/client'; import {flushSync} from 'react-dom';
    import {useDesktopCustomizations} from './apps/desktop/src/application/DesktopCustomizations.tsx';
    import {pinFrontendTools} from '@agentui/sdk/tools';
    window.activations=0; window.disposals=[];
    const customizations=[{manifest:{namespace:'fixture',sdkVersion:'${EXTENSION_SDK_VERSION}',entries:[{kind:'desktop',module:'./desktop.js'}]},
      async load(){return {default:{kind:'desktop',sdkVersion:'${EXTENSION_SDK_VERSION}',activate({frontendTools}){
        const id=++window.activations;
        frontendTools.add({definition:{name:'echo',description:'Echo'},decodeInput:x=>x,async execute(input){
          if(input.slow) await new Promise(resolve=>{window.finishSlow=resolve}); return 'activation '+id;
        }});
        return {modules:[],dispose(){window.disposals.push(id);if(id===2)return Promise.reject(new Error('B cleanup rejected'))}};
      }}}} }];
    const run={conversation:{hostId:'host',conversationId:'conversation'},runId:'run',authority:{kind:'remote-provider',binding:{namespace:'provider',installationId:'i',opaqueSessionId:'s'}}};
    const pin=generations=>pinFrontendTools({generations,platform:'desktop',run,capabilities:{tools:{clientProvided:true}}});
    function App(){const [enabled,setEnabled]=React.useState(true); const custom=useDesktopCustomizations({customizations,enabled});
      window.custom=custom; const owner=custom.namespaces.find(owner=>owner.kind==='ready'); if(owner)window.failOwner=owner.fail; window.disable=()=>flushSync(()=>setEnabled(false)); window.enable=()=>flushSync(()=>setEnabled(true));
      window.pinCurrent=()=>pin(custom.generations); window.pinStale=()=>pin([window.oldGeneration]);
      return <><input aria-label="Persistent draft" defaultValue="Keep tool draft"/><p>In-process activation and pin fixture</p><p>Eligible {custom.generations.length}</p></>;
    }
    createRoot(document.getElementById('root')).render(<App/>);` }, bundle: true, write: false, jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' } });
  const browser = await chromium.launch(); t.after(() => browser.close()); const page = await browser.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('http://localhost/fixture', route => route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' }));
  await page.goto('http://localhost/fixture'); await page.addScriptTag({ content: bundle.outputFiles[0].text });
  await page.getByText('Eligible 1', { exact: true }).waitFor();
  const previous = await page.getByRole('textbox', { name: 'Persistent draft' }).elementHandle();
  const a = await page.evaluate(() => {
    window.oldGeneration=window.custom.generations[0]; window.a=window.pinCurrent(); const binding=window.a.bindings[0];
    window.slow=window.a.invoke(binding.name,{slow:true},binding.activationId); return binding.activationId;
  });
  await wait(() => page.evaluate(() => typeof window.finishSlow === 'function'), 'original slow handler');
  await page.evaluate(() => window.disable()); await page.getByText('Eligible 0', { exact: true }).waitFor();
  assert.deepEqual(await page.evaluate(() => window.disposals), []);
  assert.equal(await page.evaluate(() => {try {window.pinStale(); return false;} catch(error) {return /retired/.test(error.message);}}), true);
  assert.deepEqual(await page.evaluate(async () => {const b=window.a.bindings[0]; return window.a.invoke(b.name,{},b.activationId);}), {kind:'completed',output:'activation 1'});
  await page.evaluate(() => window.enable()); await page.getByText('Eligible 1', { exact: true }).waitFor();
  const b = await page.evaluate(() => {window.b=window.pinCurrent(); return window.b.bindings[0].activationId;}); assert.notEqual(b,a);
  assert.equal(await page.evaluate(() => window.custom.generations.some(g=>g===window.oldGeneration)), false);
  assert.deepEqual(await page.evaluate(async () => {const binding=window.b.bindings[0];return window.b.invoke(binding.name,{},binding.activationId);}), {kind:'completed',output:'activation 2'});
  await page.evaluate(() => window.a.release()); assert.deepEqual(await page.evaluate(() => window.disposals), []);
  assert.deepEqual(await page.evaluate(async () => {window.finishSlow();return window.slow;}), {kind:'completed',output:'activation 1'});
  await wait(() => page.evaluate(() => window.disposals.length === 1), 'A drains after slow call and pin');
  await page.evaluate(() => {window.failedGeneration=window.custom.generations[0];window.failOwner(new Error('B render failed'));window.failOwner(new Error('Repeated failure'));});
  await page.getByText('Eligible 0', { exact: true }).waitFor();
  assert.deepEqual(await page.evaluate(() => window.disposals), [1]);
  assert.equal(await page.evaluate(() => {window.oldGeneration=window.failedGeneration;try {window.pinStale();return false;}catch(error){return /retired/.test(error.message);}}),true);
  await page.evaluate(() => window.b.release());
  await wait(() => page.evaluate(() => window.custom.namespaces.some(owner=>owner.kind==='failed' && /B cleanup rejected/.test(owner.message))), 'observed B retirement rejection');
  await page.evaluate(() => {window.disable();window.disable();});
  await wait(() => page.evaluate(() => window.disposals.length === 2), 'B retirement');
  assert.deepEqual(await page.evaluate(() => window.disposals), [1,2]);
  assert.equal(await page.getByRole('textbox', { name: 'Persistent draft' }).evaluate((node,old)=>node===old,previous),true);
  assert.equal(await page.getByRole('textbox', { name: 'Persistent draft' }).inputValue(),'Keep tool draft'); assert.deepEqual(errors,[]);
});

for (const failure of ['presentation', 'malformed', 'duplicate']) for (const replace of [false, true]) {
  test(`in-process only: rejected ${failure} is never eligible and late cleanup ${replace ? 'cannot overwrite replacement' : 'keeps sibling eligible'}`, { timeout: 45_000 }, async t => {
    const bundle = await build({ stdin: { resolveDir: root, loader: 'jsx', contents: `
      import React from 'react'; import {createRoot} from 'react-dom/client'; import {flushSync} from 'react-dom';
      import {useDesktopCustomizations} from './apps/desktop/src/application/DesktopCustomizations.tsx';
      const manifest={namespace:'fixture',sdkVersion:'${EXTENSION_SDK_VERSION}',entries:[{kind:'desktop',module:'./desktop.js'}]};
      const sibling={manifest:{...manifest,namespace:'sibling'},${entry("return {modules:[],dispose(){}};")}};
      const rejected={manifest,${entry(`return new Promise(resolve=>{window.finish=()=>{
        if('${failure}'!=='presentation')try{
          if('${failure}'==='duplicate')frontendTools.add(${tool});
          frontendTools.add('${failure}'==='duplicate'?${tool}:{...${tool},definition:{name:'bad.name',description:''}});
        }catch{}
        resolve({modules:'${failure}'==='presentation'?null:[],dispose(){window.disposals=(window.disposals||0)+1;
          return new Promise((resolve,reject)=>{window.resolveCleanup=resolve;window.rejectCleanup=()=>reject(new Error('Old cleanup rejected'));});}});
      };});`)}};
      const replacement={manifest,${entry(`frontendTools.add(${tool});return {modules:[],dispose(){window.replacementDisposals=(window.replacementDisposals||0)+1;}};`)}};
      const initial=[sibling,rejected]; window.eligibility=[];
      function App(){const [customizations,setCustomizations]=React.useState(initial);
        const custom=useDesktopCustomizations({customizations,enabled:true});window.custom=custom;
        window.eligibility.push(custom.generations.map(g=>({namespace:g.namespace,activationId:g.activationId})));
        window.replace=()=>flushSync(()=>setCustomizations([sibling,replacement]));
        return <input aria-label="Persistent draft" defaultValue="Keep tool draft"/>;
      }
      createRoot(document.getElementById('root')).render(<App/>);` }, bundle: true, write: false, jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' } });
    const browser = await chromium.launch(); t.after(() => browser.close()); const page = await browser.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => { window.unhandled = []; window.addEventListener('unhandledrejection', event => window.unhandled.push(String(event.reason))); });
    await page.route('http://localhost/fixture', route => route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' }));
    await page.goto('http://localhost/fixture'); await page.addScriptTag({ content: bundle.outputFiles[0].text });
    await wait(() => page.evaluate(() => window.custom?.generations.length === 1 && typeof window.finish === 'function'), 'healthy sibling before rejected activation settles');
    const previous = await page.getByRole('textbox', { name: 'Persistent draft' }).elementHandle();
    await page.evaluate(() => window.finish());
    await wait(() => page.evaluate(() => window.custom.namespaces.some(owner => owner.namespace === 'fixture' && owner.kind === 'failed') && window.disposals === 1), 'failed namespace during pending cleanup');
    assert.deepEqual(await page.evaluate(() => window.custom.generations.map(g => g.namespace)), ['sibling']);
    assert.equal(await page.evaluate(() => window.eligibility.some(snapshot => snapshot.some(g => g.namespace === 'fixture'))), false);
    let replacementId;
    if (replace) {
      await page.evaluate(() => window.replace());
      await wait(() => page.evaluate(() => window.custom.generations.length === 2), 'ready replacement');
      replacementId = await page.evaluate(() => window.custom.generations.find(g => g.namespace === 'fixture').activationId);
      await page.evaluate(() => window.rejectCleanup());
    } else await page.evaluate(() => window.resolveCleanup());
    await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 0)));
    assert.deepEqual(await page.evaluate(() => window.custom.generations.map(g => g.namespace)), replace ? ['sibling', 'fixture'] : ['sibling']);
    if (replace) {
      assert.equal(await page.evaluate(() => window.custom.namespaces.find(owner => owner.namespace === 'fixture').kind), 'ready');
      assert.equal(await page.evaluate(() => window.custom.generations.find(g => g.namespace === 'fixture').activationId), replacementId);
      assert.equal(await page.evaluate(() => window.replacementDisposals || 0), 0);
    } else assert.equal(await page.evaluate(() => window.eligibility.some(snapshot => snapshot.some(g => g.namespace === 'fixture'))), false);
    assert.equal(await page.evaluate(() => window.disposals), 1);
    assert.equal(await page.getByRole('textbox', { name: 'Persistent draft' }).evaluate((node, old) => node === old, previous), true);
    assert.equal(await page.getByRole('textbox', { name: 'Persistent draft' }).inputValue(), 'Keep tool draft');
    assert.deepEqual(await page.evaluate(() => window.unhandled), []); assert.deepEqual(errors, []);
  });
}
