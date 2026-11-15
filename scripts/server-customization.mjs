import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { isBuiltin } from 'node:module';
import { build, version as esbuildVersion } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { parseSync } from 'vite';
import { EXTENSION_SDK_VERSION } from '@agentui/sdk';
import { CustomizationError, serverCatalog, parseServerCustomizationArtifact, readServerCustomizationArtifact, serverCustomizationArtifactId } from '@agentui/host/customization';
import { prepareCustomizationSources } from './prepare-customization-sources.mjs';
import { serverCustomizationAbi } from './server-customization-abi.mjs';
import { qualifyServerCatalog } from './server-customization-qualifier.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const inside = (root, path) => { const part = relative(root, path); return part === '' || part !== '..' && !part.startsWith('../') && !isAbsolute(part); };
function graphNodes(root) {
  const nodes = new Map(), pending = [root];
  for (const node of pending) {
    if (nodes.has(node.identity)) continue;
    nodes.set(node.identity, node);
    pending.push(...node.extensions);
  }
  return nodes;
}
const repositoryRoot = node => resolve(node.directory, ...node.subdirectory.split('/').filter(Boolean).map(() => '..'));
function provenance(node) {
  const repository = repositoryRoot(node);
  return { identity: node.identity, commit: node.commit, subdirectory: node.subdirectory, inputs: node.inputs,
    npm: node.npm.kind === 'absent' ? node.npm : { ...node.npm, directory: relative(repository, node.npm.directory).split('\\').join('/') },
    local: node.customization?.local ? { manifest: node.customization.local.manifest,
      sources: [...node.customization.local.sources].map(([module, source]) => ({ module, source })).sort((a, b) => a.module < b.module ? -1 : 1) } : null,
    shared: node.customization?.shared ?? null, extensions: node.extensions.map(child => ({ packageIdentity: child.identity, commit: child.commit })) };
}
function rejectRuntimeLookups(text, file) {
  const parsed = parseSync(file, text, { sourceType: 'module' });
  if (parsed.errors.length) throw new Error('Unsupported server compilation input');
  const visit = node => {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'ImportExpression' && (node.source.type !== 'Literal' || typeof node.source.value !== 'string') ||
      node.type === 'CallExpression' && node.callee.type === 'Identifier' && node.callee.name === 'require' &&
        (node.arguments.length !== 1 || node.arguments[0].type !== 'Literal' || typeof node.arguments[0].value !== 'string') ||
      node.type === 'MemberExpression' && node.object.type === 'Identifier' && node.object.name === 'require') throw new Error('Unsupported server compilation input');
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === 'object') visit(value);
    }
  };
  visit(parsed.program);
}
async function compiler(nodes, entries, directory, abi) {
  try {
    const repositories = [...new Set(nodes.map(repositoryRoot))];
    const canonical = await Promise.all(repositories.map(path => realpath(path)));
    const approved = path => canonical.some(root => inside(root, path));
    const hostImport = specifier => Object.hasOwn(abi.imports, specifier) || isBuiltin(specifier);
    const plugin = { name: 'prepared-customization', setup(builder) {
      builder.onResolve({ filter: /.*/ }, async args => {
        if (args.path === 'module' || args.path === 'node:module') throw new Error('Unsupported server compilation input');
        if (hostImport(args.path)) return { path: args.path, external: true };
        if (args.path.startsWith('@agentui/') || args.path.includes(':') && !isAbsolute(args.path)) throw new Error('Unsupported server compilation input');
        if (args.pluginData?.resolving) return;
        const result = await builder.resolve(args.path, { importer: args.importer, resolveDir: args.resolveDir, kind: args.kind,
          pluginData: { resolving: true } });
        if (result.errors.length || result.external || !result.path || !approved(await realpath(result.path))) throw new Error('Unsupported server compilation input');
        return { path: await realpath(result.path) };
      });
      builder.onLoad({ filter: /\.[cm]?[jt]sx?$/ }, async args => {
        const contents = await readFile(args.path, 'utf8');
        rejectRuntimeLookups(contents, args.path);
        const extension = args.path.split('.').at(-1);
        const loader = ['ts', 'mts', 'cts'].includes(extension) ? 'ts' : ['tsx', 'jsx'].includes(extension) ? extension : 'js';
        return { contents, loader };
      });
    } };
    const contents = entries.map((entry, index) => `import entry${index} from ${JSON.stringify(join(entry.node.directory, entry.source))};`).join('\n') +
      `\nexport const entries = [${entries.map((_, index) => `entry${index}`).join(',')}];\n`;
    const result = await build({ stdin: { contents, sourcefile: 'agentui-server-catalog.mjs', resolveDir: canonical[0], loader: 'js' },
      absWorkingDir: canonical[0], outfile: join(directory, 'entries.mjs'), bundle: true, splitting: false, format: 'esm', platform: 'node',
      target: `node${process.versions.node}`, conditions: ['node'], mainFields: ['main'],
      tsconfigRaw: { compilerOptions: { experimentalDecorators: false, useDefineForClassFields: true, jsx: 'transform' } },
      jsx: 'transform', sourcemap: false, legalComments: 'none', charset: 'utf8', minify: false,
      write: false, metafile: true, logLevel: 'silent', plugins: [plugin] });
    if (result.warnings.length) throw new Error('Unsupported server compilation input');
    // Audit emitted imports as well as resolution because bundling can introduce runtime lookups.
    for (const [path, input] of Object.entries(result.metafile.inputs)) {
      if (path !== 'agentui-server-catalog.mjs' && !approved(await realpath(resolve(canonical[0], path)))) throw new Error('Unsupported server compilation input');
      if (input.imports.some(item => item.external && !hostImport(item.path))) throw new Error('Unsupported server compilation input');
    }
    for (const output of Object.values(result.metafile.outputs)) {
      if (output.imports.some(item => item.kind === 'require-call' || !item.external || !hostImport(item.path))) throw new Error('Unsupported server compilation input');
    }
    const assets = [];
    for (const output of result.outputFiles) {
      await writeFile(output.path, output.contents, { flag: 'wx', mode: 0o600 });
      assets.push({ path: relative(directory, output.path).split('\\').join('/'), sha256: hash(output.contents), size: output.contents.length });
    }
    return assets.sort((a, b) => a.path < b.path ? -1 : 1);
  } catch { throw CustomizationError.server('build-failed'); }
}

async function builderIdentity() {
  const host = new URL('.', import.meta.resolve('@agentui/host/customization'));
  const inputs = ['server-customization.mjs', 'server-customization-abi.mjs', 'server-customization-qualifier.mjs', 'server-catalog-loader.mjs',
    'qualify-server-catalog.child.mjs', 'prepare-customization-sources.mjs'].map(path => new URL(path, import.meta.url));
  for (const name of (await readdir(fileURLToPath(host))).filter(name => name.endsWith('.js')).sort()) inputs.push(new URL(name, host));
  inputs.push(new URL('../package-lock.json', import.meta.url));
  const hashes = await Promise.all(inputs.map(async url => [url.pathname.split('/').at(-1), hash(await readFile(url))]));
  return { identity: hash(JSON.stringify(['agentui-server-builder-v1', esbuildVersion, hashes])), esbuildVersion };
}

async function publishFresh(out, produce) {
  let directory = resolve(out);
  let parent = dirname(directory);
  let reserved = false, owner;
  try {
    await mkdir(parent, { recursive: true });
    parent = await realpath(parent); directory = join(parent, basename(directory));
    try { await mkdir(directory, { mode: 0o700 }); reserved = true; }
    catch (error) { if (error.code === 'EEXIST') throw CustomizationError.server('output-exists'); throw error; }
    owner = await mkdtemp(join(parent, '.agentui-server-'));
    const staged = join(owner, 'artifact');
    await mkdir(staged, { mode: 0o700 });
    const manifest = await produce(staged, owner);
    await rename(staged, directory);
    reserved = false;
    return Object.freeze({ directory, manifest });
  } catch (error) {
    if (error instanceof CustomizationError) throw error;
    throw CustomizationError.server('publication-failed');
  } finally {
    if (owner) await rm(owner, { recursive: true, force: true });
    if (reserved) await rm(directory, { recursive: true, force: true });
  }
}

export async function buildServerCustomization({ reference, out }) {
  const [major, minor, patch] = process.versions.node.split('.').map(Number);
  if (major !== 24 || minor < 22 || minor === 22 && patch < 3) throw CustomizationError.server('toolchain-mismatch');
  return publishFresh(out, async (staged, owner) => {
    const prepared = await prepareCustomizationSources({ reference, scratchParent: owner });
    try {
      const nodes = graphNodes(prepared.root);
      const catalog = serverCatalog([...nodes.values()].map(provenance), EXTENSION_SDK_VERSION);
      const entries = catalog.entries.map(entry => {
        const node = nodes.get(entry.packageIdentity);
        return { node, source: node.customization.local.sources.get(entry.module) };
      });
      const abi = await serverCustomizationAbi();
      const assets = await compiler([...nodes.values()], entries, staged, abi);
      const body = { schemaVersion: 1, kind: 'server-customization', root: prepared.root.identity, packages: catalog.packages, sdkVersion: EXTENSION_SDK_VERSION,
        builder: await builderIdentity(),
        runtime: { engine: 'node', version: process.versions.node, modules: process.versions.modules, abiIdentity: abi.identity }, catalog: 'entries.mjs',
        entries: catalog.entries, assets };
      const manifest = parseServerCustomizationArtifact({ ...body, artifactId: serverCustomizationArtifactId(body) });
      await writeFile(join(staged, 'customization.json'), JSON.stringify(manifest) + '\n', { flag: 'wx', mode: 0o600 });
      const expected = { artifactId: manifest.artifactId, sdkVersion: manifest.sdkVersion, nodeVersion: process.versions.node,
        nodeModules: process.versions.modules, abiIdentity: abi.identity };
      await qualifyServerCatalog({ directory: staged, manifest, manifests: catalog.manifests, abi });
      await readServerCustomizationArtifact({ directory: staged, expected }).catch(() => { throw CustomizationError.server('artifact-changed'); });
      return manifest;
    } finally {
      await prepared.dispose();
    }
  });
}
