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
  assert.deepEqual(await page.evaluate(() => [window.disposeReads, window.moduleReads]), [1, 1]);
  await unchanged(page, previous);
  await page.getByRole('button', { name: 'Send sibling', exact: true }).click();
  await page.getByRole('heading', { name: 'Approval required', exact: true }).waitFor();
  await revealRecovery(page); await page.getByRole('button', { name: 'Restore default view', exact: true }).click();
  assert.equal(await page.evaluate(() => window.disposals), 1); await unchanged(page, previous); assert.deepEqual(errors, []);
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
