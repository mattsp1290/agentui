import { readFile, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSync } from 'vite';
import { EXTENSION_SDK_VERSION } from '@agentui/sdk';

const selection = fileURLToPath(new URL('../apps/desktop/src/application/customization-selection.ts', import.meta.url));
const tsconfig = fileURLToPath(new URL('../apps/desktop/tsconfig.json', import.meta.url));
const qualifier = '\0agentui-desktop-qualifier';
const shared = /^(?:react(?:-dom)?(?:\/|$)|@agentui\/(?:sdk|contracts|protocol|ui-primitives|theme)(?:\/|$))/u;
const scripts = /\.[cm]?[jt]sx?$/u;

export function desktopSelection(root) {
  const nodes = [], seen = new Set(), namespaces = new Set(), entries = [];
  function visit(node) {
    if (seen.has(node.identity)) return;
    seen.add(node.identity); nodes.push(node);
    const local = node.customization?.local;
    if (local) {
      if (local.manifest.sdkVersion !== EXTENSION_SDK_VERSION || namespaces.has(local.manifest.namespace)) throw new Error('Invalid desktop customization graph');
      namespaces.add(local.manifest.namespace);
      for (const entry of local.manifest.entries.filter(entry => entry.kind === 'desktop')) {
        const source = local.sources.get(entry.module);
        if (!source) throw new Error('Missing desktop customization source');
        entries.push({ packageIdentity: node.identity, module: entry.module, manifest: local.manifest, source: resolve(node.directory, source) });
      }
    }
    node.extensions.forEach(visit);
  }
  visit(root);
  const packages = nodes.map(node => {
    const { directory: _directory, ...npm } = node.npm;
    const local = node.customization?.local;
    return { identity: node.identity, commit: node.commit, subdirectory: node.subdirectory, inputs: node.inputs, npm,
      local: local ? { manifest: local.manifest, sources: [...local.sources].map(([module, source]) => ({ module, source })).sort((a, b) => a.module.localeCompare(b.module)) } : null,
      shared: node.customization?.shared ?? null, extensions: node.extensions.map(child => ({ packageIdentity: child.identity, commit: child.commit })) };
  });
  return { roots: [...new Set(nodes.map(node => node.repositoryDirectory))], entries,
    catalog: { schemaVersion: 1, root: root.identity, packages, entries: entries.map(({ source: _source, ...entry }) => entry) } };
}

function checkSource(code, id) {
  const parsed = parseSync(id, code, { sourceType: 'module' });
  if (parsed.errors.length) throw new Error('Invalid customization source');
  if (parsed.comments.some(comment => /<reference\b|@jsx(?:ImportSource|Runtime)?\b/u.test(comment.value))) throw new Error('Unsupported ambient reference or JSX configuration');
  function visit(node) {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'MetaProperty' || node.type === 'TSImportEqualsDeclaration' ||
      (node.type === 'TSModuleDeclaration' && (node.kind === 'global' || node.id.type === 'Literal')) ||
      (node.type === 'ImportExpression' && (node.source.type !== 'Literal' || typeof node.source.value !== 'string' || node.options)) ||
      (['CallExpression', 'NewExpression'].includes(node.type) && node.callee.type === 'Identifier' && ['require', 'eval', 'Function'].includes(node.callee.name))) {
      throw new Error('Unsupported computed or ambient loading');
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === 'object') visit(value);
    }
  }
  visit(parsed.program);
}

export function customizationPlugin(plan) {
  const contained = id => plan.roots.some(root => {
    const path = relative(root, id);
    return path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path);
  });
  const owners = new Map();
  async function owner(path) {
    let directory = dirname(path);
    while (contained(directory)) {
      if (owners.has(directory)) return owners.get(directory);
      try {
        const value = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
        owners.set(directory, value.name);
        return value.name;
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      const parent = dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
  }
  const source = `export default [${plan.entries.map(entry => `{manifest:${JSON.stringify(entry.manifest)},load:()=>import(${JSON.stringify(entry.source)})}`).join(',')}];`;
  return {
    name: 'agentui-committed-customization', enforce: 'pre',
    config: () => ({ tsconfig, resolve: { dedupe: ['react', 'react-dom', '@agentui/sdk', '@agentui/contracts', '@agentui/protocol'] },
      oxc: { jsx: { runtime: 'automatic', importSource: 'react' } },
      build: { rollupOptions: { input: [qualifier] } } }),
    async resolveId(specifier, importer) {
      if (specifier === qualifier) return qualifier;
      if (!importer || !contained(importer.split('?')[0])) return;
      if (shared.test(specifier)) {
        try { return fileURLToPath(import.meta.resolve(specifier)); }
        catch { throw new Error(`Unsupported shared customization import: ${specifier}`); }
      }
      if (specifier.startsWith('/') || specifier.includes('\\') || /^(?:node:|[a-z]+:|#)/iu.test(specifier)) throw new Error(`Unsupported customization import: ${specifier}`);
      const result = await this.resolve(specifier, importer, { skipSelf: true });
      if (!result || result.external || !isAbsolute(result.id.split('?')[0])) throw new Error(`Unsupported customization import: ${specifier}`);
      const path = await realpath(result.id.split('?')[0]);
      if (!contained(path)) throw new Error(`Missing or unsupported contained customization source: ${specifier}`);
      if (shared.test(await owner(path) ?? '')) throw new Error('Duplicate shared customization dependency');
      return result;
    },
    async load(id) {
      if (id === selection) return source;
      if (id === qualifier) return `import entries from ${JSON.stringify(selection)}; import {checkExtensionEntrypoint} from '@agentui/sdk'; globalThis.__agentuiQualification=(async()=>{for(const entry of entries){const loaded=await entry.load(); const result=checkExtensionEntrypoint(entry.manifest,'desktop',loaded.default); if(result.kind!=='compatible') throw new Error(result.reason);} return entries.map(entry=>entry.manifest.namespace);})();`;
      const path = id.split('?')[0];
      if (contained(path) && scripts.test(path)) {
        if (shared.test(await owner(path) ?? '')) throw new Error('Duplicate shared customization dependency');
        checkSource(await readFile(path, 'utf8'), path);
      }
    },
  };
}
