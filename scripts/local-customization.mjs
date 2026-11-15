import { readFile, stat } from 'node:fs/promises';
import { dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSync } from 'vite';

const selection = fileURLToPath(new URL('../apps/desktop/src/application/customization-selection.ts', import.meta.url));
const abi = new Map(['react', 'react/jsx-runtime', 'react/jsx-dev-runtime', '@agentui/sdk',
  '@agentui/sdk/react', '@agentui/ui-primitives/desktop'].map(name => [name, fileURLToPath(import.meta.resolve(name))]));
const sourceExtension = /\.(?:[jt]sx?)$/u;
const tsconfig = fileURLToPath(new URL('../apps/desktop/tsconfig.json', import.meta.url));

export async function desktopSelection(snapshot) {
  if (!snapshot.customization) return undefined;
  const input = JSON.parse(await readFile(resolve(snapshot.directory, 'package.json'), 'utf8'));
  for (const name of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies', 'workspaces', 'imports']) {
    if (input[name] && Object.keys(input[name]).length) throw new Error(`Unsupported customization package field: ${name}`);
  }
  if (snapshot.customization?.extensions.length) throw new Error('External customization references are not supported');
  const local = snapshot.customization?.local;
  const entry = local?.manifest.entries.find(entry => entry.kind === 'desktop');
  return entry ? { manifest: local.manifest, source: resolve(snapshot.directory, local.sources.get(entry.module)), module: entry.module } : undefined;
}

function checkSource(code, id) {
  const parsed = parseSync(id, code, { sourceType: 'module' });
  if (parsed.errors.length) throw new Error(`Invalid customization source: ${id}`);
  if (parsed.comments.some(comment => /<reference\b|@jsx(?:ImportSource|Runtime)?\b/u.test(comment.value))) {
    throw new Error(`Unsupported ambient reference or JSX configuration in ${id}`);
  }
  const imports = [];
  function visit(node) {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'MetaProperty' || node.type === 'TSImportEqualsDeclaration' ||
      (node.type === 'TSModuleDeclaration' && (node.kind === 'global' || node.id.type === 'Literal')) ||
      (node.type === 'ImportExpression' && (node.source.type !== 'Literal' || typeof node.source.value !== 'string' || node.options)) ||
      (['CallExpression', 'NewExpression'].includes(node.type) && node.callee.type === 'Identifier' && ['require', 'eval', 'Function'].includes(node.callee.name))) {
      throw new Error(`Unsupported computed or ambient loading in ${id}`);
    }
    if (['ImportDeclaration', 'ExportNamedDeclaration', 'ExportAllDeclaration', 'ImportExpression'].includes(node.type) && node.source) {
      if (node.attributes?.length) throw new Error(`Unsupported import attributes in ${id}`);
      imports.push(node.source.value);
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === 'object') visit(value);
    }
  }
  visit(parsed.program);
  return imports;
}

export function customizationPlugin(snapshot, selected) {
  const contained = id => {
    const path = relative(snapshot.directory, id);
    return path !== '' && path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path);
  };
  async function sourceFile(path) {
    if (!contained(path) || !sourceExtension.test(path) || path.endsWith('.d.ts')) return false;
    try { return (await stat(path)).isFile(); } catch { return false; }
  }
  return {
    name: 'agentui-committed-customization', enforce: 'pre',
    config: () => ({ tsconfig, resolve: { dedupe: ['react', 'react-dom'] }, oxc: { jsx: { runtime: 'automatic', importSource: 'react' } } }),
    async resolveId(specifier, importer) {
      if (!importer || !contained(importer)) return;
      if (abi.has(specifier)) return abi.get(specifier);
      if (!specifier.startsWith('./') && !specifier.startsWith('../') || /[?#\\:]/u.test(specifier)) {
        throw new Error(`Unsupported customization import: ${specifier}`);
      }
      const path = resolve(dirname(importer), specifier);
      const candidates = [path];
      if (extname(path) === '.js') candidates.push(path.slice(0, -3) + '.ts', path.slice(0, -3) + '.tsx');
      if (!extname(path)) candidates.push(...['.ts', '.tsx', '.js', '.jsx'].map(extension => path + extension));
      for (const candidate of candidates) if (await sourceFile(candidate)) return candidate;
      throw new Error(`Missing or unsupported contained customization source: ${specifier}`);
    },
    async load(id) {
      if (id === selection) return selected
        ? `export default { manifest: ${JSON.stringify(selected.manifest)}, load: () => import(${JSON.stringify(selected.source)}) };`
        : 'export default undefined;';
      if (!contained(id)) return;
      if (!await sourceFile(id)) throw new Error(`Unsupported customization source: ${id}`);
      const code = await readFile(id, 'utf8');
      for (const specifier of checkSource(code, id)) await this.resolve(specifier, id, { skipSelf: false });
      return code;
    },
  };
}
