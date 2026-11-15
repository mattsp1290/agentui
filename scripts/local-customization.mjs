import { readFile, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXTENSION_SDK_VERSION } from '@agentui/sdk';
import { planCustomizationCatalog } from '@agentui/host/customization';
import { checkCustomizationSource, isWorkerRequest, sourcePolicies } from './lib/customization-source-policy.mjs';
import { checkCustomizationAsset, customizationCssPolicy, within } from './lib/customization-asset-policy.mjs';

const selection = fileURLToPath(new URL('../apps/desktop/src/application/customization-selection.ts', import.meta.url));
const tsconfig = fileURLToPath(new URL('../apps/desktop/tsconfig.json', import.meta.url));
const SHARED = Object.freeze({
  react: ['', '/jsx-runtime', '/jsx-dev-runtime'], 'react-dom': ['', '/client'],
  '@agentui/sdk': ['', '/react', '/tools'], '@agentui/contracts': ['*'], '@agentui/protocol': [''],
  '@agentui/ui-primitives': ['/desktop'], '@agentui/theme': ['', '/react'],
});
const sharedPackage = specifier => Object.keys(SHARED).find(name => specifier === name || specifier.startsWith(`${name}/`));
function sharedImport(specifier) {
  const name = sharedPackage(specifier);
  return name && (SHARED[name].includes('*') || SHARED[name].includes(specifier.slice(name.length)));
}
const scripts = /\.[cm]?[jt]sx?$/u;

export function desktopPlan(root) {
  const plan = planCustomizationCatalog(root, EXTENSION_SDK_VERSION, 'desktop');
  return { roots: plan.roots, entries: plan.entries.map((entry, index) => ({ ...entry, source: plan.sources[index] })),
    catalog: { schemaVersion: 1, root: root.identity, packages: plan.packages, entries: plan.entries } };
}

function checkSource(code, id, label) {
  return checkCustomizationSource(code, id, sourcePolicies.desktop, rule => {
    if (rule === 'syntax') return new Error(`Invalid customization source in ${label}`);
    if (rule === 'ambientReference') return new Error(`Unsupported ambient reference or JSX configuration (${rule}) in ${label}`);
    if (rule === 'absoluteSpecifier') return new Error(`Unsupported customization import (${rule}) in ${label}`);
    return new Error(`Unsupported computed or ambient loading (${rule}) in ${label}`);
  });
}

export function customizationPlugin(plan) {
  const contained = id => plan.roots.some(root => within(root, id));
  const reserved = name => (name ?? '').startsWith('@agentui/') || Object.hasOwn(SHARED, name);
  const owners = new Map();
  async function owner(path) {
    let directory = dirname(path);
    while (contained(directory)) {
      if (owners.has(directory)) return owners.get(directory);
      try {
        const value = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
        if (typeof value.name === 'string') { owners.set(directory, value.name); return value.name; }
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      const parent = dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
  }
  const source = `export default [${plan.entries.map(entry => `{manifest:${JSON.stringify(entry.manifest)},load:()=>import(${JSON.stringify(entry.source)})}`).join(',')}];`;
  return {
    name: 'agentui-committed-customization', enforce: 'pre',
    config: () => ({ tsconfig, resolve: { dedupe: Object.keys(SHARED) }, css: { postcss: { plugins: [customizationCssPolicy(plan.roots)] } },
      oxc: { jsx: { runtime: 'automatic', importSource: 'react' } } }),
    async resolveId(specifier, importer, options) {
      if (!importer || !contained(importer.split('?')[0])) return;
      if (specifier.startsWith('\0')) return;
      if (sharedImport(specifier)) {
        const result = await this.resolve(specifier, selection, { skipSelf: true, kind: 'import-statement' });
        if (!result || result.external) throw new Error(`Unsupported shared customization import: ${specifier}`);
        return result;
      }
      if (sharedPackage(specifier) || specifier.startsWith('@agentui/') || specifier.includes('\\') || /^(?:node:|[a-z]+:|#)/iu.test(specifier)) throw new Error(`Unsupported customization import: ${specifier}`);
      const result = await this.resolve(specifier, importer, { skipSelf: true, kind: options.kind });
      if (result && isWorkerRequest(result.id)) throw new Error(`Unsupported customization import (unsupportedWorker): ${specifier}`);
      if (result?.id.startsWith('\0') && !result.external) return result;
      if (!result || result.external || !isAbsolute(result.id.split('?')[0])) throw new Error(`Unsupported customization import: ${specifier}`);
      const path = await realpath(result.id.split('?')[0]);
      if (!contained(path)) throw new Error(`Missing or unsupported contained customization source: ${specifier}`);
      if (reserved(await owner(path))) throw new Error('Duplicate shared customization dependency');
      return result;
    },
    async load(id) {
      if (id === selection) return source;
      const path = id.split('?')[0];
      if (contained(path) && /\.module\.(?:css|less|sass|scss|styl|stylus|pcss|postcss|sss)$/u.test(path)) throw new Error('Unsupported customization CSS modules');
      if (contained(path) && scripts.test(path)) {
        if (reserved(await owner(path))) throw new Error('Duplicate shared customization dependency');
        const root = plan.roots.find(root => within(root, path));
        const { assetUrls } = checkSource(await readFile(path, 'utf8'), path, relative(root, path));
        for (const reference of assetUrls) await checkCustomizationAsset(reference, path, plan.roots);
      }
    },
  };
}
