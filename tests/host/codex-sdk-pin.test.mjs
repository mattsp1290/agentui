import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = new URL('../../', import.meta.url);
const json = path => JSON.parse(readFileSync(new URL(path, root), 'utf8'));
test('Codex SDK host consumes the pinned public Switchboard artifact with SDK-free declarations', () => {
  const pin = json('vendor/switchboard-codex.json');
  const host = json('packages/host/package.json');
  assert.equal(host.dependencies['@agentui/switchboard-codex'], `file:../../vendor/${pin.artifact}`);
  assert.equal(createHash('sha256').update(readFileSync(new URL(`vendor/${pin.artifact}`, root))).digest('hex'), pin.sha256);
  assert.equal(host.dependencies['@openai/codex-sdk'], pin.nativeSdk);
  const entry = fileURLToPath(import.meta.resolve('@agentui/switchboard-codex/codex'));
  const declarations = readFileSync(entry.replace(/\.js$/, '.d.ts'), 'utf8');
  assert(!declarations.includes('@openai/codex-sdk'), 'Public Codex types must not expose native SDK declarations');
  const lock = json('package-lock.json');
  assert.equal(lock.packages['packages/host'].dependencies['@agentui/switchboard-codex'], `file:../../vendor/${pin.artifact}`);
  assert.equal(pin.provider, 'chatgpt-subscription');
  assert.equal(pin.model, 'gpt-6.1-sol');
});
