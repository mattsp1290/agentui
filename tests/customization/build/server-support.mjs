import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { access, readdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { serverCustomizationAbi } from '../../../scripts/server-customization-abi.mjs';
import { join } from 'node:path';
import { EXTENSION_SDK_VERSION } from '@agentui/sdk';
import { buildServerCustomization } from '../../../scripts/server-customization.mjs';
import { fixture, write } from './preparation-support.mjs';
export { write };
export const validSource = `import { EXTENSION_SDK_VERSION } from '@agentui/sdk'; export default {kind:'server', sdkVersion:EXTENSION_SDK_VERSION, activate() {return {dispose(){}}}};`;
export const extension = (namespace, extra = {}) => ({ extension: { namespace, trust: 'full', sdkVersion: EXTENSION_SDK_VERSION, entries: [{ kind: 'server', module: './server.mjs' }] }, sources: { './server.mjs': './index.ts' }, ...extra });
export async function setup(t, source = validSource) {
  const f = await fixture(t);
  const repo = await f.repository('source');
  await write(repo.directory, 'package.json', { type: 'module', agentui: extension('fixture') });
  await write(repo.directory, 'index.ts', source);
  const build = (commit = repo.commit(), name = 'artifact') => buildServerCustomization({ reference: repo.reference(commit), out: join(f.root, name) });
  return { ...f, repo, build };
}
export const expectation = manifest => ({ artifactId: manifest.artifactId, sdkVersion: manifest.sdkVersion, nodeVersion: manifest.runtime.version,
  nodeModules: manifest.runtime.modules, abiIdentity: manifest.runtime.abiIdentity });

export async function clean(f, output = 'bad') {
  await assert.rejects(access(join(f.root, output)), { code: 'ENOENT' });
  assert.deepEqual((await readdir(f.root)).filter(name => name.startsWith('.agentui-server-')), []);
}
export async function valueFromCatalog(built) {
  const abi = await serverCustomizationAbi();
  const hook = new URL('../../../scripts/server-catalog-loader.mjs', import.meta.url).href;
  const catalog = pathToFileURL(join(built.directory, built.manifest.catalog)).href;
  const allowed = [...abi.files, ...built.manifest.assets.map(asset => pathToFileURL(join(built.directory, asset.path)).href)];
  const program = `import {registerServerCatalogHooks} from ${JSON.stringify(hook)};
    registerServerCatalogHooks(${JSON.stringify({ imports: abi.imports, allowed })});
    const {entries}=await import(${JSON.stringify(catalog)});
    process.stdout.write(JSON.stringify(entries[0].activate().value));`;
  return JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', program], { cwd: built.directory, encoding: 'utf8' }));
}
