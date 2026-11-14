import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
const urls = new Set();
const hook = registerHooks({ resolve(specifier, context, next) {
  const value = next(specifier, context); urls.add(value.url); return value;
} });
await import('../../../scripts/protocol-conformance.mjs');
hook.deregister();
const testRoot = new URL('../../', import.meta.url).href;
const allowed = ['../coverage.mjs', '../evidence.mjs'].map((path) => new URL(path, import.meta.url).href).sort();
assert.deepEqual([...urls].filter((url) => url.startsWith(testRoot)).sort(), allowed);
assert.ok([...urls].every((url) => !url.includes('/node_modules/ajv/') && !url.includes('/node_modules/typescript/') && !url.endsWith('/support/compile.mjs')));
