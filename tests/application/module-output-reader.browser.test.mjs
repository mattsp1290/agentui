import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { appendFileSync } from 'node:fs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const source = `
import React, { StrictMode, useSyncExternalStore } from 'react';
import {createRoot} from 'react-dom/client';
import {flushSync} from 'react-dom';
import {parseConversationModules} from '@agentui/sdk/react';
import {CODEX_SDK_RUNTIME} from '@agentui/contracts/compatibility';
import {CustomizationModules} from './apps/desktop/src/application/CustomizationModules.tsx';
import {Reports} from './tests/application/fixtures/output-reader.tsx';
import {fixture,empty,scope} from './tests/application/controller-fixture.mjs';
const f=fixture(); f.behavior.runtime=CODEX_SDK_RUNTIME; window.control=f; f.views.set('original-view/host',{...empty(),route:scope});
const id='output-'+'a'.repeat(64), output={outputId:id,name:'fixture.txt',mediaType:'text/plain',byteLength:1,sha256:'a'.repeat(64),lifetime:'provider-retained'};
let requests=[],actionCalls=0,allowed=false,reason='Controlled SDK fixture',visible=true,strict=false,epoch=0;
const hold=(kind)=>new Promise((resolve,reject)=>requests.push({kind,resolve,reject}));
f.behavior.outputs=()=>hold('list');f.behavior.readOutput=()=>hold('read');
const root=createRoot(document.getElementById('root'));
const action={id:'review',label:'Review',availability:()=>allowed?{kind:'available'}:{kind:'disabled',reason},run(){actionCalls++;return hold('action');}};
const owner={kind:'ready',namespace:'fixture',lifetime:1,fail(error){throw error},presentation:{modules:parseConversationModules([{id:'reports',label:'Reports',component:Reports,actions:[action]}])}};
function App(){const state=useSyncExternalStore(f.app.subscribe,f.app.getSnapshot);const active=state.active;return visible&&active?<CustomizationModules owner={owner} active={active} actions={f.app.conversationActions(active)}/>:null;}
const render=()=>flushSync(()=>root.render(strict?<StrictMode key={epoch}><App/></StrictMode>:<App key={epoch}/>));
async function connect(domain={messages:[],currentRun:null}){const feed=f.feeds.at(-1);await feed.receive({kind:'snapshot',snapshot:{scope:feed.scope,projectionVersion:4,cursor:(f.app.getSnapshot().active.store.getSnapshot().cursor??-1)+1,document:{domain,decisions:{},receipts:{}}}});}
window.proof={get requests(){return requests},get calls(){return actionCalls},id,
 async ready(){await f.app.start();await connect();render()},
 async reset(automatic=false,replay=false){visible=false;render();requests=[];strict=replay;epoch++;history.replaceState({},'',automatic?'?automatic':'/proof');visible=true;render()},
 async state(label){allowed=false;reason=label;const active=f.app.getSnapshot().active;active.agent.commands=['send','approve','cancel'];active.agent.availability={kind:'ready'};await connect();
  if(label==='running')await connect({messages:[],currentRun:{kind:'running',runId:'run'}});
  if(label==='concluded'){f.behavior.observation=async()=>({kind:'concluded',cause:'exhausted'});await f.app.reconnect();await connect()}
  if(label==='no-send')active.agent.commands=[];
  if(label==='unavailable-agent')active.agent.availability={kind:'unavailable',reason:label};
  if(label==='disconnected-transcript')active.store.disconnect();
  if(label==='app-busy'){f.behavior.catalog=()=>hold('busy');void f.app.moreConversations()}
  render()},
 enable(value,live=false){allowed=value;if(!live)render()},
 async replace(){const old=f.app.getSnapshot().active;await f.app.reconnect();await connect();if(f.app.getSnapshot().active.store!==old.store)throw new Error('Different store');render()},
 unavailable(kind){if(kind==='host')f.connectionLost(new Error('Host offline'));else f.leases[0].failure(new Error('Storage failed'));render()},
 toggle(value){visible=value;render()},
 settle(index,kind='available',size=1){const request=requests[index];if(kind==='error')request.reject(new Error('obsolete transport'));else if(request.kind==='busy'){f.behavior.catalog=async()=>{};request.resolve([]);}else request.resolve(request.kind==='action'?{kind:'rejected',reason:'Current result'}:kind!=='available'?{kind,reason:kind==='missing'?'output-missing':'outputs-'+kind}:request.kind==='list'?{kind:'available',outputs:size===0?[]:[output]}:{kind:'available',output:{...output,byteLength:size},bytes:new Uint8Array(size)})},
 async shutdown(){root.unmount();await f.app.dispose()}
};
window.proof.ready();`;

test('controlled SDK states keep actual authored query controls usable and suppress obsolete owner/request/effect feedback', { timeout: 60_000 }, async t => {
  const built = await build({ stdin: { contents: source, resolveDir: root, loader: 'jsx' }, bundle: true, write: false, jsx: 'automatic', define: { 'process.env.NODE_ENV': '"development"' } });
  const browser = await chromium.launch(); t.after(() => browser.close()); const page = await browser.newPage();
  page.on('pageerror', error => t.diagnostic('Page error: ' + error.message)); page.setDefaultTimeout(10_000);
  try {
    await page.route('http://localhost/**', route => route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' }));
    await page.goto('http://localhost/proof'); await page.addScriptTag({ content: built.outputFiles[0].text });
    const status = page.getByTestId('output-status'), actionStatus = page.getByRole('status', { name: 'Review status' });
    const list = page.getByRole('button', { name: 'List outputs', exact: true }), read = page.getByRole('button', { name: 'Read output', exact: true }), action = page.getByRole('button', { name: 'Review', exact: true });
    await list.waitFor();
    const next = async (button, kind = 'available', size = 1) => {
      const index = await page.evaluate(() => window.proof.requests.length);
      await button.click(); await page.waitForFunction(index => window.proof.requests.length > index, index);
      await page.evaluate(([index, kind, size]) => window.proof.settle(index, kind, size), [index, kind, size]);
      await status.filter({ hasText: kind === 'available' ? button === list ? `${size === 0 ? 0 : 1} outputs` : `${size} bytes` : kind }).waitFor();
    };
    for (const state of ['running', 'no-send', 'unavailable-agent', 'disconnected-transcript', 'concluded', 'app-busy']) {
      t.diagnostic('Controlled state ' + state);
      await page.evaluate(state => window.proof.state(state), state);
      assert.equal(await action.isDisabled(), true);
      const inline = page.getByRole('button', { name: 'Inline send', exact: true });
      assert.equal(await inline.isDisabled(), true, `SDK send is disabled while ${state}`);
      await inline.evaluate(button => button.click());
      assert.equal(await page.evaluate(() => window.control.submitted.length), 0);
      await action.evaluate(button => button.click());
      assert.equal(await page.evaluate(() => window.proof.calls), 0);
      await next(list); await next(read);
      if (process.env.AGENTUI_OUTPUT_AUDIT_RESOURCES && ['running', 'concluded'].includes(state)) await page.screenshot({ path: process.env.AGENTUI_OUTPUT_AUDIT_RESOURCES + '.' + state + '.png' });
      if (state === 'app-busy') await page.evaluate(() => window.proof.settle(window.proof.requests.findIndex(request => request.kind === 'busy')));
    }
    t.diagnostic('Controlled outcomes');
    for (const kind of ['unsupported', 'unavailable', 'invalid']) { await next(list, kind); await next(read, kind); }
    await next(list, 'available', 0); await next(list);
    for (const size of [0, 65_536]) await next(read, 'available', size);
    await next(read, 'missing');
    t.diagnostic('Owner replacement');
    for (const error of [false, true]) {
      await page.evaluate(() => window.proof.reset()); await list.click();
      await page.waitForFunction(() => window.proof.requests.length === 1);
      const owner = await page.evaluateHandle(() => window.outputProbe.current);
      await page.evaluate(() => window.proof.replace());
      await page.waitForFunction(old => window.outputProbe.current !== old, owner);
      assert.equal(await status.textContent(), '');
      const settled = await page.evaluate(() => window.outputProbe.settlements);
      await page.evaluate(error => window.proof.settle(0, error ? 'error' : 'available'), error);
      await page.waitForFunction(count => window.outputProbe.settlements > count, settled);
      assert.equal(await status.textContent(), '');
      await page.evaluate(() => window.proof.enable(true)); await action.click();
      await actionStatus.filter({ hasText: 'Submitting…' }).waitFor();
      await page.evaluate(() => window.proof.replace());
      await actionStatus.filter({ hasText: /^$/ }).waitFor({ state: 'attached' });
      await page.evaluate(error => window.proof.settle(1, error ? 'error' : 'available'), error);
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
      assert.equal(await actionStatus.textContent(), '');
    }
    await page.evaluate(() => window.proof.reset());
    await next(list); await read.click(); await read.click();
    await page.waitForFunction(() => window.proof.requests.length === 3);
    await page.evaluate(() => window.proof.settle(1));
    await page.waitForFunction(() => window.outputProbe.results.length > 0);
    assert.equal(await status.textContent(), 'Reading…');
    await page.evaluate(() => window.proof.settle(2)); await status.filter({ hasText: '1 bytes' }).waitFor();
    await page.evaluate(() => window.proof.enable(true));
    await action.evaluate(button => { button.click(); button.click(); });
    await page.waitForFunction(() => window.proof.requests.length === 4);
    assert.equal(await page.evaluate(() => window.proof.calls), 3);
    await page.evaluate(() => window.proof.settle(3)); await actionStatus.filter({ hasText: 'Current result' }).waitFor();
    await page.evaluate(() => window.proof.enable(false, true)); await action.click();
    assert.equal(await page.evaluate(() => window.proof.requests.length), 4);
    await page.evaluate(() => window.proof.reset(true, true));
    await page.waitForFunction(() => window.proof.requests.length === 2);
    await page.evaluate(() => window.proof.settle(0));
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
    assert.equal(await status.textContent(), 'Reading…');
    await page.evaluate(() => window.proof.settle(1)); await status.filter({ hasText: '1 outputs' }).waitFor();
    await page.evaluate(() => window.outputProbe.rerender());
    await page.waitForFunction(() => document.querySelector('[data-testid="reports"]').dataset.revision === '1');
    assert.equal(await page.evaluate(() => window.proof.requests.length), 2);
    await page.evaluate(() => window.proof.reset());
    for (const state of ['host', 'storage']) {
      await page.evaluate(state => window.proof.unavailable(state), state);
      const before = await page.evaluate(() => window.proof.requests.length);
      await list.click();
      await status.filter({ hasText: state === 'host' ? 'compatible connected host' : 'Storage failed' }).waitFor();
      assert.equal(await page.evaluate(() => window.proof.requests.length), before);
      if (state === 'host') await page.evaluate(() => window.proof.replace());
    }
    if (process.env.AGENTUI_OUTPUT_AUDIT_RESOURCES) appendFileSync(process.env.AGENTUI_OUTPUT_AUDIT_RESOURCES,
      JSON.stringify({ kind: 'controlled-sdk-observations', states: ['running', 'no-send', 'unavailable-agent', 'disconnected-transcript', 'concluded', 'app-busy'], sizes: [0, 65536], hostStorageDispatches: 0, listener: 'none; fulfilled browser route', pid: process.pid }) + '\n');
    await page.evaluate(() => window.proof.shutdown());
  } finally { await page.close(); await browser.close(); }
});
