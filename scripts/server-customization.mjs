import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { build, version as esbuildVersion } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { parseSync } from 'vite';
import { EXTENSION_SDK_VERSION } from '@agentui/sdk';
import { parseServerCustomizationArtifact, readServerCustomizationArtifact, serverCustomizationArtifactId } from '@agentui/host/customization';
import { prepareCustomizationSources } from './prepare-customization-sources.mjs';
import { isNodeBuiltin, qualifyServerCatalog, serverCustomizationAbi } from './server-customization-abi.mjs';

const failure = code => Object.assign(new Error({
  'output-exists': 'Server customization output must be a fresh directory.',
  'invalid-graph': 'Server customization requires unique namespaces and compatible server entries.',
  'build-failed': 'Could not compile server customization sources.',
  'artifact-changed': 'Server customization output changed during validation.',
  'publication-failed': 'Could not publish server customization artifact.',
}[code]), { code });
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const inside = (root, path) => { const part = relative(root, path); return part === '' || part !== '..' && !part.startsWith('../') && !isAbsolute(part); };
function graph(root) {
  const nodes = new Map();
  const visit = node => { if (nodes.has(node.identity)) return; nodes.set(node.identity, node); node.extensions.forEach(visit); };
  visit(root);
  return [...nodes.values()];
}
function provenance(node) {
  const repository = resolve(node.directory, ...node.subdirectory.split('/').filter(Boolean).map(() => '..'));
  return { identity: node.identity, commit: node.commit, subdirectory: node.subdirectory, inputs: node.inputs,
    npm: node.npm.kind === 'absent' ? node.npm : { ...node.npm, directory: relative(repository, node.npm.directory).split('\\').join('/') },
    local: node.customization?.local ? { manifest: node.customization.local.manifest,
      sources: [...node.customization.local.sources].map(([module, source]) => ({ module, source })).sort((a, b) => a.module < b.module ? -1 : 1) } : null,
    shared: node.customization?.shared ?? null, extensions: node.extensions.map(child => child.identity) };
}
function rejectRuntimeLookups(text, file) {
  const parsed = parseSync(file, text, { sourceType: 'module' });
  if (parsed.errors.length) throw failure('build-failed');
  const visit = node => {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'ImportExpression' && (node.source.type !== 'Literal' || typeof node.source.value !== 'string') ||
      node.type === 'CallExpression' && node.callee.type === 'Identifier' && node.callee.name === 'require' &&
        (node.arguments.length !== 1 || node.arguments[0].type !== 'Literal' || typeof node.arguments[0].value !== 'string') ||
      node.type === 'MemberExpression' && node.object.type === 'Identifier' && node.object.name === 'require') throw failure('build-failed');
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === 'object') visit(value);
    }
  };
  visit(parsed.program);
}
async function compiler(nodes, entries, directory, abi) {
  const repositories = [...new Set(nodes.map(node => resolve(node.directory, ...node.subdirectory.split('/').filter(Boolean).map(() => '..'))))];
  const canonical = await Promise.all(repositories.map(path => realpath(path)));
  const approved = path => canonical.some(root => inside(root, path));
  const plugin = { name: 'prepared-customization', setup(builder) {
    builder.onResolve({ filter: /.*/ }, async args => {
      if (Object.hasOwn(abi.imports, args.path) || isNodeBuiltin(args.path)) return { path: args.path, external: true };
      if (args.path.startsWith('@agentui/') || args.path.includes(':') && !isAbsolute(args.path)) throw failure('build-failed');
      if (args.pluginData?.resolving) return;
      const result = await builder.resolve(args.path, { importer: args.importer, resolveDir: args.resolveDir, kind: args.kind,
        pluginData: { resolving: true } });
      if (result.errors.length || result.external || !result.path || !approved(await realpath(result.path))) throw failure('build-failed');
      return { path: await realpath(result.path) };
    });
    builder.onLoad({ filter: /\.[cm]?[jt]sx?$/ }, async args => {
      if (!approved(await realpath(args.path))) throw failure('build-failed');
      const contents = await readFile(args.path, 'utf8');
      rejectRuntimeLookups(contents, args.path);
      const extension = args.path.split('.').at(-1);
      return { contents, loader: ['ts', 'tsx', 'jsx'].includes(extension) ? extension : 'js' };
    });
  } };
  const contents = entries.map((entry, index) => `import entry${index} from ${JSON.stringify(join(entry.node.directory, entry.source))};`).join('\n') +
    `\nexport const entries = [${entries.map((_, index) => `entry${index}`).join(',')}];\n`;
  try {
    const result = await build({ stdin: { contents, sourcefile: 'agentui-server-catalog.mjs', resolveDir: canonical[0], loader: 'js' },
      absWorkingDir: canonical[0], outfile: join(directory, 'entries.mjs'), bundle: true, splitting: false, format: 'esm', platform: 'node',
      target: `node${process.versions.node}`, conditions: ['node', 'import'], mainFields: ['module', 'main'],
      tsconfigRaw: { compilerOptions: { experimentalDecorators: false, useDefineForClassFields: true, jsx: 'transform' } },
      jsx: 'transform', sourcemap: false, legalComments: 'none', charset: 'utf8', minify: false,
      write: false, metafile: true, logLevel: 'silent', plugins: [plugin] });
    if (result.warnings.length) throw failure('build-failed');
    for (const [path, input] of Object.entries(result.metafile.inputs)) {
      if (path !== 'agentui-server-catalog.mjs' && !approved(await realpath(resolve(canonical[0], path)))) throw failure('build-failed');
      if (input.imports.some(item => item.external && !Object.hasOwn(abi.imports, item.path) && !isNodeBuiltin(item.path))) throw failure('build-failed');
    }
    for (const output of Object.values(result.metafile.outputs)) {
      if (output.imports.some(item => item.kind === 'require-call' || !item.external || !Object.hasOwn(abi.imports, item.path) && !isNodeBuiltin(item.path))) throw failure('build-failed');
    }
    for (const output of result.outputFiles) await writeFile(output.path, output.contents, { flag: 'wx', mode: 0o600 });
  } catch { throw failure('build-failed'); }
}
async function inventory(directory) {
  const assets = [];
  const walk = async parent => {
    for (const name of await readdir(join(directory, parent))) {
      const path = parent ? `${parent}/${name}` : name;
      const metadata = await lstat(join(directory, path));
      if (metadata.isDirectory()) await walk(path);
      else {
        if (!metadata.isFile()) throw failure('artifact-changed');
        const bytes = await readFile(join(directory, path));
        assets.push({ path, sha256: hash(bytes), size: bytes.length });
      }
    }
  };
  await walk('');
  return assets.sort((a, b) => a.path < b.path ? -1 : 1);
}

async function builderIdentity() {
  const host = new URL('.', import.meta.resolve('@agentui/host/customization'));
  const inputs = ['server-customization.mjs', 'server-customization-abi.mjs', 'prepare-customization-sources.mjs'].map(path => new URL(path, import.meta.url));
  for (const name of (await readdir(fileURLToPath(host))).filter(name => name.endsWith('.js')).sort()) inputs.push(new URL(name, host));
  inputs.push(new URL('../package-lock.json', import.meta.url));
  const hashes = await Promise.all(inputs.map(async url => [url.pathname.split('/').at(-1), hash(await readFile(url))]));
  return { identity: hash(JSON.stringify(['agentui-server-builder-v1', esbuildVersion, hashes])), esbuildVersion };
}

export async function buildServerCustomization({ reference, out }) {
  let directory = resolve(out);
  let parent = dirname(directory);
  let reserved = false, owner, prepared;
  try {
    await mkdir(parent, { recursive: true });
    parent = await realpath(parent); directory = join(parent, basename(directory));
    try { await mkdir(directory, { mode: 0o700 }); reserved = true; }
    catch (error) { if (error.code === 'EEXIST') throw failure('output-exists'); throw error; }
    owner = await mkdtemp(join(parent, '.agentui-server-'));
    const staged = join(owner, 'artifact');
    await mkdir(staged, { mode: 0o700 });
    prepared = await prepareCustomizationSources({ reference, scratchParent: owner });
    const nodes = graph(prepared.root), namespaces = new Set(), entries = [];
    for (const node of nodes) {
      const local = node.customization?.local;
      if (!local) continue;
      if (local.manifest.sdkVersion !== EXTENSION_SDK_VERSION || namespaces.has(local.manifest.namespace)) throw failure('invalid-graph');
      namespaces.add(local.manifest.namespace);
      for (const entry of local.manifest.entries.filter(entry => entry.kind === 'server')) entries.push({ node, module: entry.module, source: local.sources.get(entry.module) });
    }
    if (!entries.length) throw failure('invalid-graph');
    const abi = await serverCustomizationAbi();
    await compiler(nodes, entries, staged, abi);
    const assets = await inventory(staged);
    const body = { schemaVersion: 1, kind: 'server-customization', root: prepared.root.identity, packages: nodes.map(provenance), sdkVersion: EXTENSION_SDK_VERSION,
      builder: await builderIdentity(),
      runtime: { engine: 'node', version: process.versions.node, modules: process.versions.modules, abiIdentity: abi.identity }, catalog: 'entries.mjs',
      entries: entries.map((entry, index) => ({ packageIdentity: entry.node.identity, module: entry.module, index })), assets };
    const manifest = parseServerCustomizationArtifact({ ...body, artifactId: serverCustomizationArtifactId(body) });
    await writeFile(join(staged, 'customization.json'), JSON.stringify(manifest) + '\n', { flag: 'wx', mode: 0o600 });
    const expected = { artifactId: manifest.artifactId, sdkVersion: manifest.sdkVersion, nodeVersion: process.versions.node,
      nodeModules: process.versions.modules, abiIdentity: abi.identity };
    const before = await readServerCustomizationArtifact({ directory: staged, expected });
    await qualifyServerCatalog({ directory: staged, manifest, abi });
    const after = await readServerCustomizationArtifact({ directory: staged, expected });
    if ((await readFile(join(staged, 'customization.json'), 'utf8')) !== JSON.stringify(manifest) + '\n' ||
      assets.some(asset => !before.readAsset(asset.path).equals(after.readAsset(asset.path)))) throw failure('artifact-changed');
    await prepared.dispose(); prepared = undefined;
    await rename(staged, directory);
    reserved = false;
    return Object.freeze({ directory, manifest });
  } catch (error) {
    if (error.code && ['output-exists', 'invalid-graph', 'build-failed', 'entry-validation', 'artifact-changed', 'install-failed', 'resource-limit', 'toolchain-mismatch'].includes(error.code)) throw error;
    throw failure('publication-failed');
  } finally {
    await prepared?.dispose();
    if (owner) await rm(owner, { recursive: true, force: true });
    if (reserved) await rm(directory, { recursive: true, force: true });
  }
}
