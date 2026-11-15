import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { delimiter, dirname, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import { CustomizationError, resolveCustomizationSources } from '@agentui/host/customization';

const execute = promisify(execFile);
const diagnostics = {
  'toolchain-mismatch': 'Customization preparation requires supported Node 24 and npm 11.19.1.',
  'install-failed': 'Could not install committed customization dependencies.',
  'input-mutation': 'Committed customization inputs changed during preparation.',
  'resource-limit': 'Customization preparation resource limit exceeded.',
  'preparation-failed': 'Could not prepare committed customization sources.',
};
const failure = code => new CustomizationError(code, diagnostics[code]);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

async function validateInstalledPackages(directory, packages, check) {
  try {
    const expected = new Map();
    const pending = ['node_modules'];
    const seen = new Set();
    for (const [path, entry] of Object.entries(packages)) {
      check();
      if (path.split('/').includes('node_modules')) expected.set(path, entry);
      else if (path) pending.push(`${path}/node_modules`);
    }
    const canonical = await realpath(directory);
    for (const location of pending) {
      check();
      const container = join(directory, location);
      const metadata = await lstat(container).catch(error => {
        if (error.code === 'ENOENT') return undefined;
        throw error;
      });
      if (!metadata) continue;
      if (!metadata.isDirectory()) throw failure('install-failed');
      const modules = location.split('/').at(-1) === 'node_modules';
      const entries = await readdir(container);
      for (const name of entries) {
        check();
        if (modules && (name === '.bin' || name === '.package-lock.json')) continue;
        const path = `${location}/${name}`;
        const destination = join(directory, path);
        const metadata = await lstat(destination);
        if (modules && name.startsWith('@')) {
          if (!metadata.isDirectory()) throw failure('install-failed');
          pending.push(path);
          continue;
        }
        const entry = expected.get(path);
        if (!entry) throw failure('install-failed');
        let identity = entry;
        if (entry.link === true) {
          if (!metadata.isSymbolicLink() || await realpath(destination) !== join(canonical, entry.resolved)) throw failure('install-failed');
          identity = packages[entry.resolved];
        } else {
          if (!metadata.isDirectory()) throw failure('install-failed');
          pending.push(`${path}/node_modules`);
        }
        const manifestPath = join(destination, 'package.json');
        if (!(await lstat(manifestPath)).isFile()) throw failure('install-failed');
        const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
        if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest) || manifest.version !== identity.version ||
          (identity.name !== undefined && manifest.name !== identity.name) || (entry.name !== undefined && manifest.name !== entry.name) ||
          [manifest.bundleDependencies, manifest.bundledDependencies].some(value => Array.isArray(value) ? value.length > 0 : Boolean(value))) {
          throw failure('install-failed');
        }
        seen.add(path);
      }
    }
    for (const [path, entry] of expected) {
      check();
      if (!seen.has(path) && entry.optional !== true) throw failure('install-failed');
    }
  } catch (error) {
    if (error.code === 'resource-limit') throw error;
    throw failure('install-failed');
  }
}

/** @typedef {import('@agentui/host/customization').ResolvedCustomizationPackage} ResolvedCustomizationPackage */
/** @typedef {{readonly root: ResolvedCustomizationPackage, dispose(): Promise<void>}} PreparedCustomizationSources */

/**
 * @param {{reference: import('@agentui/host/customization').GitExtensionReference, scratchParent: string}} input
 * @returns {Promise<PreparedCustomizationSources>}
 */
export async function prepareCustomizationSources(input) {
  let owner, sources;
  const deadline = Date.now() + 600_000;
  const check = () => {
    if (Date.now() >= deadline) throw failure('resource-limit');
  };
  const dispose = async () => { if (owner) await rm(owner, { recursive: true, force: true }); };
  try {
    const scratchParent = resolve(input.scratchParent);
    await mkdir(scratchParent, { recursive: true, mode: 0o700 });
    owner = await mkdtemp(join(scratchParent, 'agentui-prepared-'));
    await chmod(owner, 0o700);
    sources = await resolveCustomizationSources({ reference: input.reference, scratchParent: owner });
    const repositories = new Map();
    const installs = new Map();
    const nodes = new Map();
    const pending = [sources.root];
    for (const node of pending) {
      check();
      if (nodes.has(node)) continue;
      let original = node.directory;
      for (const _segment of node.subdirectory ? node.subdirectory.split('/') : []) original = dirname(original);
      if (!repositories.has(original)) {
        repositories.set(original, { original, directory: join(owner, `repository-${repositories.size}`), inputs: node.inputs });
      }
      nodes.set(node, repositories.get(original));
      if (node.npm.kind === 'locked') installs.set(node.npm.directory, { repository: repositories.get(original), npm: node.npm });
      pending.push(...node.extensions);
    }
    for (const repository of repositories.values()) {
      await mkdir(repository.directory, { mode: 0o700 });
      for (const file of repository.inputs.files) {
        check();
        if (file.path.split('/').some(segment => segment.toLowerCase() === 'node_modules')) {
          throw new CustomizationError('invalid-package', 'Committed node_modules is unsupported in customization sources.');
        }
        const source = join(repository.original, file.path);
        const metadata = await lstat(source);
        const bytes = await readFile(source);
        if (!metadata.isFile() || Boolean(metadata.mode & 0o111) !== file.executable || digest(bytes) !== file.sha256) {
          throw failure('input-mutation');
        }
        const destination = join(repository.directory, file.path);
        await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
        await writeFile(destination, bytes, { flag: 'wx', mode: file.executable ? 0o700 : 0o600 });
        await chmod(destination, file.executable ? 0o700 : 0o600);
      }
    }
    for (const [original, install] of installs) {
      check();
      install.directory = join(install.repository.directory, relative(install.repository.original, original));
      install.packages = JSON.parse(await readFile(join(install.repository.directory, install.npm.lockfile.path), 'utf8')).packages;
    }
    if (installs.size) {
      const [major, minor, patch] = process.versions.node.split('.').map(Number);
      if (major !== 24 || minor < 22 || minor === 22 && patch < 3) throw failure('toolchain-mismatch');
      const privateDirectory = join(owner, 'npm');
      const home = join(privateDirectory, 'home');
      const temporary = join(privateDirectory, 'tmp');
      await mkdir(home, { recursive: true, mode: 0o700 });
      await mkdir(temporary, { mode: 0o700 });
      const userconfig = join(privateDirectory, 'user.npmrc');
      const globalconfig = join(privateDirectory, 'global.npmrc');
      await writeFile(userconfig, '', { mode: 0o600 });
      await writeFile(globalconfig, '', { mode: 0o600 });
      const env = { PATH: dirname(process.execPath) + delimiter + (process.env.PATH ?? ''), HOME: home, TMPDIR: temporary, TMP: temporary, TEMP: temporary,
        LC_ALL: 'C', LANG: 'C', npm_config_cache: join(privateDirectory, 'cache'),
        npm_config_userconfig: userconfig, npm_config_globalconfig: globalconfig };
      let npm;
      try { npm = await realpath(join(dirname(process.execPath), 'npm')); }
      catch { throw failure('toolchain-mismatch'); }
      const run = async (args, cwd, version = false) => {
        check();
        try {
          const prefix = await realpath(cwd);
          return (await execute(process.execPath, [npm, '--prefix', prefix, ...args], { cwd: prefix, env, encoding: 'utf8',
            timeout: Math.min(version ? 10_000 : 120_000, deadline - Date.now()), maxBuffer: 1024 * 1024, killSignal: 'SIGKILL' })).stdout;
        } catch (error) {
          if (error.killed || error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') throw failure('resource-limit');
          throw failure(version ? 'toolchain-mismatch' : 'install-failed');
        }
      };
      if ((await run(['--version'], privateDirectory, true)).trim() !== '11.19.1') throw failure('toolchain-mismatch');
      const configs = [];
      try {
        for (const repository of repositories.values()) {
          for (const file of repository.inputs.files.filter(file => file.path.split('/').at(-1).toLowerCase() === '.npmrc')) {
            check();
            const path = join(repository.directory, file.path);
            const bytes = await readFile(path);
            const mode = (await lstat(path)).mode & 0o777;
            configs.push({ path, bytes, mode });
            await rm(path);
          }
        }
        for (const install of installs.values()) {
          await run(['ci', '--ignore-scripts', '--include=dev', '--include=optional', '--include=peer', '--no-audit', '--no-fund', '--no-update-notifier'], install.directory);
        }
      } finally {
        for (const config of configs) {
          await writeFile(config.path, config.bytes, { mode: config.mode });
          await chmod(config.path, config.mode);
        }
      }
    }
    for (const install of installs.values()) await validateInstalledPackages(install.directory, install.packages, check);
    for (const repository of repositories.values()) {
      for (const file of repository.inputs.files) {
        check();
        const destination = join(repository.directory, file.path);
        const metadata = await lstat(destination);
        if (!metadata.isFile() || Boolean(metadata.mode & 0o111) !== file.executable || digest(await readFile(destination)) !== file.sha256) {
          throw failure('input-mutation');
        }
      }
    }
    const remapped = new Map();
    const remap = node => {
      if (remapped.has(node)) return remapped.get(node);
      const repository = nodes.get(node);
      const result = Object.freeze({ ...node, directory: join(repository.directory, node.subdirectory),
        npm: node.npm.kind === 'locked' ? Object.freeze({ ...node.npm, directory: join(repository.directory, relative(repository.original, node.npm.directory)) }) : node.npm,
        extensions: Object.freeze(node.extensions.map(remap)) });
      remapped.set(node, result);
      return result;
    };
    const root = remap(sources.root);
    await sources.dispose();
    sources = undefined;
    return { root, dispose };
  } catch (error) {
    await sources?.dispose();
    await dispose();
    if (error instanceof CustomizationError) throw error;
    throw failure('preparation-failed');
  }
}
