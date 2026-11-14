import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

test('installed host serves only its verified browser bytes after an on-disk rebuild', { timeout: 15000 }, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'agentui-installed-assets-'));
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const host = join(directory, 'apps/host/dist'), browser = join(directory, 'apps/desktop/web-dist-browser');
  cpSync(join(root, 'apps/host/dist'), host, { recursive: true });
  cpSync(join(root, 'apps/desktop/web-dist-browser'), browser, { recursive: true });
  const data = join(directory, 'data');
  const child = spawn(process.execPath, [join(host, 'main.js'), 'browser-dev', '--data-dir', data, '--port', '0'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited;
    }
    rmSync(directory, { recursive: true, force: true });
  });
  const info = await new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error(`Host startup timed out: ${stderr}`)), 5000);
    child.once('error', reject);
    child.once('exit', () => { clearTimeout(timer); reject(new Error(`Host exited: ${stderr}`)); });
    child.stdout.on('data', chunk => {
      output += chunk;
      if (output.includes('\n')) { clearTimeout(timer); resolve(JSON.parse(output.split('\n')[0])); }
    });
  });
  const manifest = JSON.parse(readFileSync(join(browser, 'artifact.json'), 'utf8'));
  const javascript = manifest.assets.find(asset => asset.path.endsWith('.js')).path;
  const expected = readFileSync(join(browser, javascript), 'utf8');
  writeFileSync(join(browser, javascript), 'throw new Error("unverified rebuild");');
  writeFileSync(join(browser, 'artifact.json'), '{}');
  writeFileSync(join(browser, 'unlisted.js'), 'unverified');
  assert.equal(await (await fetch(`${info.origin}/${javascript}`)).text(), expected);
  assert.deepEqual(await (await fetch(`${info.origin}/artifact.json`)).json(), manifest);
  assert.equal((await fetch(`${info.origin}/unlisted.js`)).status, 404);
  assert.equal(existsSync(join(dirname(host), 'node_modules')), false);
});

test('production desktop output contains neither browser entry nor browser manifest', () => {
  const desktop = fileURLToPath(new URL('../../apps/desktop/web-dist/', import.meta.url));
  assert.equal(existsSync(join(desktop, 'index.html')), true);
  assert.equal(existsSync(join(desktop, 'browser.html')), false);
  assert.equal(existsSync(join(desktop, 'artifact.json')), false);
});
