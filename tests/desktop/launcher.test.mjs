import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const launcher = fileURLToPath(new URL('../../agentui', import.meta.url));
const validator = fileURLToPath(new URL('../../scripts/desktop-launch-args.mjs', import.meta.url));
const invalid = [
  ['--host-url'], ['--other'], ['--host-url', 'bad-url'],
  ['--host-url', 'https://127.0.0.1:8123/browser.html'],
  ['--host-url', 'http://example.com:8123/browser.html'],
  ['--host-url', 'http://localhost:8123/browser.html'],
  ['--host-url', 'http://127.0.0.1:8123/other.html'],
  ['--host-url', 'http://user:pass@127.0.0.1:8123/browser.html'],
  ['--host-url', 'http://127.0.0.1:8123/browser.html?token=x'],
  ['--host-url', 'http://127.0.0.1:8123/browser.html#fragment'],
  ['--host-url', 'http://127.0.0.1:8123/browser.html?'],
  ['--host-url', 'http://127.0.0.1:8123/browser.html#'],
  ['--host-url', 'http://127.0.0.1:99999/browser.html'],
  ['--host-url', 'http://127.0.0.1:8123/browser.html', '--extra'],
];

for (const args of invalid) {
  test(`launcher validation rejects ${JSON.stringify(args)}`, () => {
    const result = spawnSync(process.execPath, [validator, ...args], { encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Cannot connect to AgentUI host:.*(?:--host-url|http:\/\/127\.0\.0\.1:PORT\/browser\.html)/);
    assert.equal(result.stdout, '');
  });
  test(`launcher rejects ${JSON.stringify(args)} before building or opening`, { skip: process.platform !== 'darwin' }, t => {
    const dir = mkdtempSync(join(tmpdir(), 'agentui-launcher-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    writeFileSync(join(dir, 'npm'), '#!/bin/sh\nprintf \'Build must not run\\n\' >&2\nexit 99\n', { mode: 0o755 });
    const result = spawnSync(launcher, args, { encoding: 'utf8', timeout: 2_000,
      env: { ...process.env, PATH: `${dir}:${dirname(process.execPath)}:${process.env.PATH}` } });
    assert.equal(result.error, undefined);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Cannot connect to AgentUI host:.*(?:--host-url|http:\/\/127\.0\.0\.1:PORT\/browser\.html)/);
    assert.equal(result.stdout, '');
    assert.doesNotMatch(result.stderr, /Build must not run/);
  });
}

for (const args of [[], ['--host-url', 'http://127.0.0.1:8123/browser.html'], ['--host-url', 'http://127.0.0.1/browser.html']]) {
  test(`launcher validation accepts ${JSON.stringify(args)} without opening the app`, () => {
    const result = spawnSync(process.execPath, [validator, ...args], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, '');
  });
}
