import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseLaunchArgs } from '../../scripts/agentui-launch.mjs';

const launcher = fileURLToPath(new URL('../../agentui', import.meta.url));
const entry = fileURLToPath(new URL('../../scripts/agentui-launch.mjs', import.meta.url));
const cases = JSON.parse(readFileSync(new URL('./host-url-cases.json', import.meta.url), 'utf8'));
const invalid = cases.filter(({ accepted }) => !accepted).map(({ args }) => args);

function launch(t, args) {
  const dir = mkdtempSync(join(tmpdir(), 'agentui-launcher-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'npm'), '#!/bin/sh\nprintf \'Build reached\\n\' >&2\nexit 99\n', { mode: 0o755 });
  return spawnSync(launcher, args, { encoding: 'utf8', timeout: 2_000,
    env: { ...process.env, PATH: `${dir}:${dirname(process.execPath)}:${process.env.PATH}` } });
}

for (const args of invalid) {
  test(`launcher validation rejects ${JSON.stringify(args)}`, () => {
    assert.throws(() => parseLaunchArgs(args), /--host-url|http:\/\/127\.0\.0\.1:PORT\/browser\.html/);
  });
  test(`launcher rejects ${JSON.stringify(args)} before building or opening`, { skip: process.platform !== 'darwin' }, t => {
    const result = launch(t, args);
    assert.equal(result.error, undefined);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Cannot connect to AgentUI host:.*(?:--host-url|http:\/\/127\.0\.0\.1:PORT\/browser\.html)/s);
    assert.equal(result.stdout, '');
    assert.doesNotMatch(result.stderr, /Build reached/);
  });
}

for (const { args, normalized } of cases.filter(({ accepted }) => accepted)) {
  test(`launcher validation accepts ${JSON.stringify(args)} without opening the app`, () => {
    const result = parseLaunchArgs(args);
    assert.equal(result.kind, args.length === 0 ? 'local' : 'existing');
    if (args.length !== 0) {
      assert.equal(result.url, args[1]);
      assert.equal(new URL(result.url).href, normalized);
    } else assert.equal(normalized, null);
  });
}

test('launcher forwards a valid host URL to its build step', { skip: process.platform !== 'darwin' }, t => {
  const result = launch(t, ['--host-url', 'http://127.0.0.1:8123/browser.html']);
  assert.equal(result.error, undefined);
  assert.equal(result.status, 99);
  assert.match(result.stderr, /Build reached/);
  assert.match(result.stderr, /npm exited with 99/);
});

test('launcher rejects an invalid host URL through a symbolic link', { skip: process.platform === 'win32' }, t => {
  const dir = mkdtempSync(join(tmpdir(), 'agentui-validator-link-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const linked = join(dir, 'validate.mjs');
  symlinkSync(entry, linked);
  const result = spawnSync(process.execPath, [linked, '--host-url', 'https://example.com/browser.html'], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Cannot connect to AgentUI host/);
});
