import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { resolveHostDependency } from '../../../host/test-support/dependencies.mjs';
const urls = [];
const schemas = resolveHostDependency('@ag-ui/core/schemas');
const schemaModules = new Set([schemas]);
const hook = registerHooks({ resolve(specifier, context, next) {
  const value = next(specifier, context);
  if (context.parentURL === schemas && value.url.startsWith(new URL('./', schemas).href) && /\/version-[A-Za-z0-9_-]+\.mjs$/u.test(value.url)) schemaModules.add(value.url);
  urls.push(value.url); return value;
} });
const core = await import('@agentui/host');
hook.deregister();
assert.equal(core.hostRuntime, 'node');
assert.ok(urls.includes(resolveHostDependency('@mattsp1290/switchboard')), 'hook observed Switchboard core');
assert.ok(urls.includes(schemas), 'host validates offered input with the pinned AG-UI schemas');
const forbidden = ['@mattsp1290/switchboard/agui', '@agentui/host/agui'].map(specifier => resolveHostDependency(specifier));
assert.ok(urls.every(url => !forbidden.includes(url) && (!url.includes('/@ag-ui/') || schemaModules.has(url))), urls.join('\n'));

assert.ok(urls.every(url => !url.includes('/host/dist/frontend-tools/')), urls.join('\n'));
