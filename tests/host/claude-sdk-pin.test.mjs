import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { resolveHostDependency } from '../../packages/host/test-support/dependencies.mjs';

const root = new URL('../../', import.meta.url);
const json = path => JSON.parse(readFileSync(new URL(path, root), 'utf8'));

test('Claude host consumes the pinned public Switchboard artifact with SDK-free declarations', () => {
  const pin = json('vendor/switchboard-claude.json');
  const artifact = json(`vendor/${pin.qualificationRecord}`);
  const host = json('packages/host/package.json');
  const dependency = `file:../../vendor/${artifact.artifact}`;
  assert.equal(host.dependencies['@agentui/switchboard-claude'], dependency);
  assert.equal(createHash('sha256').update(readFileSync(new URL(`vendor/${artifact.artifact}`, root))).digest('hex'), artifact.sha256);
  assert.equal(host.dependencies['@anthropic-ai/claude-agent-sdk'], pin.nativeSdk);
  const entry = fileURLToPath(resolveHostDependency('@agentui/switchboard-claude/claude'));
  assert.doesNotMatch(readFileSync(entry.replace(/\.js$/, '.d.ts'), 'utf8'), /@anthropic-ai/);
  const lock = json('package-lock.json');
  assert.equal(lock.packages['packages/host'].dependencies['@agentui/switchboard-claude'], dependency);
  assert.equal(lock.packages['node_modules/@anthropic-ai/claude-agent-sdk'].version, pin.nativeSdk);
  assert.equal(pin.provider, 'anthropic-api-key');
  assert.deepEqual(pin.models, ['opus', 'sonnet']);
});


test('Claude native peer pins describe the packages resolved by the SDK', () => {
  const pin = json('vendor/switchboard-claude.json');
  const fromSdk = createRequire(import.meta.resolve('@anthropic-ai/claude-agent-sdk'));
  for (const [name, entry] of [
    ['@anthropic-ai/sdk', '@anthropic-ai/sdk'],
    ['@modelcontextprotocol/sdk', '@modelcontextprotocol/sdk/client/index.js'],
    ['zod', 'zod'],
  ]) {
    let directory = dirname(fromSdk.resolve(entry));
    for (;;) {
      const file = join(directory, 'package.json');
      if (existsSync(file)) {
        const manifest = JSON.parse(readFileSync(file, 'utf8'));
        if (manifest.name === name) {
          assert.equal(manifest.version, pin.nativePeers[name]);
          break;
        }
      }
      const parent = dirname(directory);
      assert.notEqual(parent, directory, `${name} must have a package manifest`);
      directory = parent;
    }
  }
});
