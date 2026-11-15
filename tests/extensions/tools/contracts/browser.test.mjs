import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { build } from 'esbuild';
import { chromium } from 'playwright';

test('bundled tools run under the desktop CSP', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agentui-tools-'));
  const csp = JSON.parse(await readFile('apps/desktop/src-tauri/tauri.conf.json', 'utf8')).app.security.csp;
  await build({ stdin: { contents: `import { createFrontendToolGeneration, pinFrontendTools } from '@agentui/sdk/tools';
    const g = await createFrontendToolGeneration({namespace:'demo',generation:'1',platform:'desktop',activate(t){t.add({definition:{name:'x',description:'x',parameters:{type:'object',properties:{v:{type:'string'}},required:['v']}},decodeInput(x){return x.v},async execute(x){return x}});return {dispose(){}}}});
    const p = pinFrontendTools({generations:[g],platform:'desktop',run:{conversation:{hostId:'h',conversationId:'c'},runId:'r',authority:{kind:'agentui-host',hostId:'h',binding:{namespace:'n',installationId:'i',opaqueSessionId:'s'}}},capabilities:{tools:{clientProvided:true}}});
    let blocked = false; try { new Function('return 1')(); } catch { blocked = true; } document.body.textContent = JSON.stringify({outcome: await p.invoke('demo__x',{v:'ok'}), blocked}); p.release(); await g.retire();`, resolveDir: process.cwd(), sourcefile: 'entry.js' }, bundle: true, format: 'esm', platform: 'browser', outfile: join(dir, 'bundle.js') });
  const server = createServer(async (req, res) => {
    res.setHeader('Content-Security-Policy', csp);
    if (req.url === '/bundle.js') { res.setHeader('Content-Type', 'text/javascript'); res.end(await readFile(join(dir, 'bundle.js'))); }
    else { res.setHeader('Content-Type', 'text/html'); res.end('<body><script type="module" src="/bundle.js"></script></body>'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.waitForFunction(() => document.body.textContent.includes('completed'));
    assert.deepEqual(JSON.parse(await page.locator('body').textContent()), { outcome: { kind: 'completed', output: 'ok' }, blocked: true });
  } finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); await rm(dir, { recursive: true, force: true }); }
});
