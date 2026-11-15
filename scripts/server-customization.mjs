import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { build, version as esbuildVersion } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { parseSync } from 'vite';
import { EXTENSION_SDK_VERSION } from '@agentui/sdk';
import { CustomizationError, assertSupportedNode, planServerCatalog, serverCatalogFile, parseServerCustomizationArtifact, readServerCustomizationArtifact, serverCustomizationArtifactId } from '@agentui/host/customization';
import { prepareCustomizationSources } from './prepare-customization-sources.mjs';
import { classifyHostSpecifier, serverCustomizationAbi } from './server-customization-abi.mjs';
import { qualificationChild, qualifyServerCatalog } from './server-customization-qualifier.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const inside = (root, path) => { const part = relative(root, path); return part === '' || part !== '..' && !part.startsWith('../') && !isAbsolute(part); };
function rejectRuntimeLookups(text, file) {
  const parsed = parseSync(file, text, { sourceType: 'module' });
  if (parsed.errors.length) throw CustomizationError.fixed('build-failed');
  const visit = node => {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'ImportExpression' && (node.source.type !== 'Literal' || typeof node.source.value !== 'string')) throw CustomizationError.fixed('build-failed');
    if (node.type === 'CallExpression' && node.callee.type === 'Identifier' && node.callee.name === 'require' &&
      (node.arguments.length !== 1 || node.arguments[0].type !== 'Literal' || typeof node.arguments[0].value !== 'string')) throw CustomizationError.fixed('build-failed');
    if (node.type === 'MemberExpression' && node.object.type === 'Identifier' && node.object.name === 'require') throw CustomizationError.fixed('build-failed');
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === 'object') visit(value);
    }
  };
  visit(parsed.program);
}
function preparedResolutionPlugin(roots, abi) {
  const approved = path => roots.some(root => inside(root, path));
  return { name: 'prepared-customization', setup(builder) {
    builder.onResolve({ filter: /.*/ }, async args => {
      const kind = classifyHostSpecifier(abi.imports, args.path);
      if (kind === 'forbidden') throw CustomizationError.fixed('build-failed');
      if (kind === 'sdk' || kind === 'builtin') return { path: args.path, external: true };
      if (args.path.startsWith('@agentui/') || args.path.includes(':') && !isAbsolute(args.path)) throw CustomizationError.fixed('build-failed');
      if (args.pluginData?.resolving) return;
      const result = await builder.resolve(args.path, { importer: args.importer, resolveDir: args.resolveDir, kind: args.kind,
        pluginData: { resolving: true } });
      if (result.errors.length || result.external || !result.path || !approved(await realpath(result.path))) throw CustomizationError.fixed('build-failed');
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
}
async function compileCatalog({ roots, sources, directory, abi, repositoryDirectory }) {
  try {
    const canonicalRoots = await Promise.all(roots.map(path => realpath(path)));
    const root = await realpath(repositoryDirectory);
    const contents = sources.map((source, index) => `import entry${index} from ${JSON.stringify(source)};`).join('\n') +
      `\nexport const entries = [${sources.map((_, index) => `entry${index}`).join(',')}];\n`;
    const result = await build({ stdin: { contents, sourcefile: 'agentui-server-catalog.mjs', resolveDir: root, loader: 'js' },
      absWorkingDir: root, outfile: join(directory, serverCatalogFile), bundle: true, splitting: false, format: 'esm', platform: 'node',
      target: `node${process.versions.node}`, conditions: ['node'], mainFields: ['main'],
      tsconfigRaw: { compilerOptions: { experimentalDecorators: false, useDefineForClassFields: true, jsx: 'transform' } },
      jsx: 'transform', sourcemap: false, legalComments: 'none', charset: 'utf8', minify: false,
      write: false, metafile: true, logLevel: 'silent', plugins: [preparedResolutionPlugin(canonicalRoots, abi)] });
    if (result.warnings.length) throw CustomizationError.fixed('build-failed');
    // Audit emitted imports as well as resolution because bundling can introduce runtime lookups.
    for (const output of Object.values(result.metafile.outputs)) {
      if (output.imports.some(item => item.kind === 'require-call' || !item.external || !['sdk', 'builtin'].includes(classifyHostSpecifier(abi.imports, item.path)))) throw CustomizationError.fixed('build-failed');
    }
    const assets = [];
    for (const output of result.outputFiles) {
      await writeFile(output.path, output.contents, { flag: 'wx', mode: 0o600 });
      assets.push({ path: relative(directory, output.path).split('\\').join('/'), sha256: hash(output.contents), size: output.contents.length });
    }
    return assets.sort((a, b) => a.path < b.path ? -1 : 1);
  } catch { throw CustomizationError.fixed('build-failed'); }
}

async function builderIdentity() {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const result = await build({ entryPoints: [fileURLToPath(import.meta.url), fileURLToPath(qualificationChild)], outdir: 'identity',
    absWorkingDir: root, bundle: true, write: false, metafile: true, platform: 'node', format: 'esm', logLevel: 'silent',
    plugins: [{ name: 'first-party-identity', setup(builder) {
      builder.onResolve({ filter: /^[^./]/ }, args => {
        if (isAbsolute(args.path)) return;
        if (args.path.startsWith('@agentui/')) return { path: fileURLToPath(import.meta.resolve(args.path)) };
        return { path: args.path, external: true };
      });
    } }] });
  const paths = [...Object.keys(result.metafile.inputs), 'package-lock.json'].sort();
  const hashes = await Promise.all(paths.map(async path => [path, hash(await readFile(join(root, path)))]));
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
    catch (error) { if (error.code === 'EEXIST') throw CustomizationError.fixed('output-exists'); throw error; }
    owner = await mkdtemp(join(parent, '.agentui-server-'));
    const staged = join(owner, 'artifact');
    await mkdir(staged, { mode: 0o700 });
    const manifest = await produce(staged, owner);
    await rename(staged, directory);
    reserved = false;
    return Object.freeze({ directory, manifest });
  } catch (error) {
    if (error instanceof CustomizationError) throw error;
    throw CustomizationError.fixed('publication-failed');
  } finally {
    if (owner) await rm(owner, { recursive: true, force: true });
    if (reserved) await rm(directory, { recursive: true, force: true });
  }
}

export async function buildServerCustomization({ reference, out }) {
  assertSupportedNode();
  const [abi, builder] = await Promise.all([serverCustomizationAbi(), builderIdentity()]);
  return publishFresh(out, async (staged, owner) => {
    const prepared = await prepareCustomizationSources({ reference, scratchParent: owner });
    try {
      const { catalog, ...compilation } = planServerCatalog(prepared.root, EXTENSION_SDK_VERSION);
      const assets = await compileCatalog({ ...compilation, directory: staged, abi });
      const body = { schemaVersion: 1, kind: 'server-customization', root: prepared.root.identity, packages: catalog.packages, sdkVersion: EXTENSION_SDK_VERSION,
        builder,
        runtime: { engine: 'node', version: process.versions.node, modules: process.versions.modules, abiIdentity: abi.identity }, catalog: serverCatalogFile,
        entries: catalog.entries, assets };
      const manifest = parseServerCustomizationArtifact({ ...body, artifactId: serverCustomizationArtifactId(body) });
      await writeFile(join(staged, 'customization.json'), JSON.stringify(manifest) + '\n', { flag: 'wx', mode: 0o600 });
      const expected = { artifactId: manifest.artifactId, sdkVersion: manifest.sdkVersion, nodeVersion: process.versions.node,
        nodeModules: process.versions.modules, abiIdentity: abi.identity };
      await qualifyServerCatalog({ directory: staged, manifest, abi });
      await readServerCustomizationArtifact({ directory: staged, expected }).catch(() => { throw CustomizationError.fixed('artifact-changed'); });
      return manifest;
    } finally {
      await prepared.dispose();
    }
  });
}
