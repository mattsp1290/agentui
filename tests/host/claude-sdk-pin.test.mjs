import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = new URL('../../', import.meta.url);
const json = path => JSON.parse(readFileSync(new URL(path, root), 'utf8'));

test('Claude host consumes the pinned public Switchboard artifact with SDK-free declarations', () => {
  const pin = json('vendor/switchboard-claude.json');
  const host = json('packages/host/package.json');
  const dependency = `file:../../vendor/${pin.artifact}`;
  assert.equal(host.dependencies['@agentui/switchboard-claude'], dependency);
  assert.equal(createHash('sha256').update(readFileSync(new URL(`vendor/${pin.artifact}`, root))).digest('hex'), pin.sha256);
  assert.equal(host.dependencies['@anthropic-ai/claude-agent-sdk'], pin.nativeSdk);
  const entry = fileURLToPath(import.meta.resolve('@agentui/switchboard-claude/claude'));
  assert.doesNotMatch(readFileSync(entry.replace(/\.js$/, '.d.ts'), 'utf8'), /@anthropic-ai/);
  const lock = json('package-lock.json');
  assert.equal(lock.packages['packages/host'].dependencies['@agentui/switchboard-claude'], dependency);
  assert.equal(lock.packages['node_modules/@anthropic-ai/claude-agent-sdk'].version, pin.nativeSdk);
  assert.equal(pin.provider, 'anthropic-api-key');
  assert.deepEqual(pin.models, ['opus', 'sonnet']);
});
