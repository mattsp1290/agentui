import assert from 'node:assert/strict';
import test from 'node:test';
import { checkCustomizationSource, sourcePolicies } from '../../../scripts/lib/customization-source-policy.mjs';

const check = (source, target) => checkCustomizationSource(source, 'entry.ts', sourcePolicies[target], rule => new Error(rule));
for (const [rule, source] of [
  ['computedImport', 'import(name)'],
  ['computedRequire', 'require(name)'],
  ['computedRequire', "require('./a.js', extra)"],
  ['requireMember', "require.resolve('./a.js')"],
  ['requireMember', "require['cache']"],
  ['syntax', 'export const ='],
]) test(`both targets reject ${rule} in ${source}`, () => {
  for (const target of ['desktop', 'server']) assert.throws(() => check(source, target), { message: rule });
});
for (const [rule, source] of [
  ['absoluteSpecifier', "import '/absolute.js'"],
  ['absoluteSpecifier', "export * from '/absolute.js'"],
  ['absoluteSpecifier', "import('./a\\0.js')"],
  ['absoluteSpecifier', "require('/absolute.js')"],
  ['importOptions', "import('./a.js', {with: {type: 'json'}})"],
  ['requireCallForm', "require?.('./a.js')"],
  ['requireCallForm', "new require('./a.js')"],
  ['computedAssetUrl', 'new URL(name, import.meta.url)'],
  ['computedAssetUrl', 'new URL(`./${name}.png`, import.meta.url)'],
  ['computedAssetUrl', 'new URL("./a.png", import.meta.url, extra)'],
  ['unsupportedAssetUrl', 'new URL("/a.png", import.meta.url)'],
  ['unsupportedAssetUrl', 'new URL("a.png", import.meta.url)'],
  ['unsupportedAssetUrl', 'new URL("./a\\u002epng", import.meta.url)'],
  ['unsupportedAssetUrl', 'new URL(`./a\\u002epng`, import.meta.url)'],
  ['unsupportedWorker', 'import Worker from "./worker.js?worker"'],
  ['unsupportedWorker', 'import("./worker.js?inline&sharedworker")'],
  ['unsupportedWorker', 'new Worker(new URL("./worker.js", import.meta.url))'],
  ['unsupportedWorker', 'new SharedWorker(new URL("./worker.js", import.meta.url) as URL)'],
  ['importMetaOtherThanUrl', 'import.meta.glob("*.ts")'],
  ['importMetaOtherThanUrl', 'import.meta["url"]'],
  ['ambientModule', 'import x = require("x")'],
  ['ambientModule', 'declare module "x" {}'],
  ['ambientModule', 'declare global {}'],
  ['ambientReference', '/// <reference path="ambient.d.ts" />\nexport {}'],
  ['ambientReference', '/** @jsxImportSource alternate */\nexport {}'],
]) test(`desktop rejects ${rule} while server retains its source policy for ${source}`, () => {
  assert.throws(() => check(source, 'desktop'), { message: rule });
  assert.doesNotThrow(() => check(source, 'server'));
});
for (const source of ["import './a.js'", "export {x} from './a.js'", "export * from './a.js'", "import('./a.js')",
  "require('./a.cjs')", 'new URL("./a.png", import.meta.url)', 'new URL(`./a.png`, import.meta.url)',
  'new URL(style)', 'new Worker(address)', 'service.Worker()', "eval('1')", "new Function('return 1')", 'function f() { return new.target; }']) {
  test(`both targets allow static source ${source}`, () => {
    for (const target of ['desktop', 'server']) assert.doesNotThrow(() => check(source, target));
  });
}
test('source inspection returns static URL references from the existing traversal', () => {
  assert.deepEqual(check('new URL("./a.png?no-inline#part", import.meta.url); new URL(`../b.png`, import.meta.url); new URL(style);', 'desktop'),
    { assetUrls: ['./a.png?no-inline#part', '../b.png'] });
});
test('URL inspection follows TypeScript expression wrappers removed before Vite asset compilation', () => {
  assert.deepEqual(check('new (URL as any)("./a.png" as string, import.meta.url!);', 'desktop'), { assetUrls: ['./a.png'] });
});
