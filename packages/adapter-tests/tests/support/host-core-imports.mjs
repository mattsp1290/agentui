import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { resolveHostDependency } from '../../../host/test-support/dependencies.mjs';
const urls = [];
const hook = registerHooks({ resolve(specifier, context, next) {
  const value = next(specifier, context); urls.push(value.url); return value;
} });
const core = await import('@agentui/host');
hook.deregister();
assert.equal(core.hostRuntime, 'node');
assert.ok(urls.includes(resolveHostDependency('@mattsp1290/switchboard')), 'hook observed Switchboard core');
const forbidden = ['@mattsp1290/switchboard/agui', '@agentui/host/agui'].map(specifier => resolveHostDependency(specifier));
assert.ok(urls.every(url => !forbidden.includes(url) && !url.includes('/@ag-ui/')), urls.join('\n'));
