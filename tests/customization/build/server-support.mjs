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
