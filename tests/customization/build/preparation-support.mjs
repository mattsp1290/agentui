import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { prepareCustomizationSources } from '../../../scripts/prepare-customization-sources.mjs';

const env = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
  PATH: dirname(process.execPath) + delimiter + (process.env.PATH ?? ''), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
export const execute = (command, args, cwd) => execFileSync(command, args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
export async function write(directory, file, value, executable = false) {
  const destination = join(directory, file);
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value));
  if (executable) await chmod(destination, 0o700);
}
export async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'agentui-preparation-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const scratchParent = join(root, 'scratch');
  const repository = async name => {
    const directory = join(root, name);
    await mkdir(directory);
    execute('git', ['init', '--template='], directory);
    const commit = () => {
      execute('git', ['add', '--all'], directory);
      execute('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-m', 'fixture'], directory);
      return execute('git', ['rev-parse', 'HEAD'], directory);
    };
    return { directory, commit, reference: (commit, subdirectory) => ({ repository: directory, commit, ...(subdirectory ? { subdirectory } : {}) }) };
  };
  const prepare = reference => prepareCustomizationSources({ reference, scratchParent });
  return { root, scratchParent, repository, prepare };
}
export async function tarball(f, repository, name, version, manifest = {}, contents = {}) {
  const directory = join(f.root, `tar-${name}-${version}`);
  const script = "node -e \"require('fs').writeFileSync('dependency-script-ran', 'unsafe')\"";
  await write(directory, 'package/package.json', { name, version, type: 'module', exports: './index.js', scripts: { preinstall: script, install: script, postinstall: script }, ...manifest });
  await write(directory, 'package/index.js', `export default ${JSON.stringify(`${name}@${version}`)};\n`);
  for (const [path, bytes] of Object.entries(contents)) await write(directory, `package/${path}`, bytes);
  const archive = `vendor/${name}-${version}.tgz`;
  await mkdir(dirname(join(repository.directory, archive)), { recursive: true });
  execute('tar', ['-czf', join(repository.directory, archive), '-C', directory, 'package'], f.root);
  return { version, resolved: `file:${archive}`, integrity: 'sha512-' + createHash('sha512').update(await readFile(join(repository.directory, archive))).digest('base64'), hasInstallScript: true };
}
export async function locked(f, repo, version = '1.0.0') {
  const entries = {};
  const script = "node -e \"require('fs').writeFileSync('root-script-ran', 'unsafe')\"";
  const pkg = { name: 'fixture', version: '1.0.0', type: 'module', packageManager: 'npm@11.19.1', agentui: { shared: './index.mjs' },
    scripts: { preinstall: script, install: script, postinstall: script, prepare: script } };
  for (const [name, group, flag] of [['value', 'dependencies'], ['development', 'devDependencies', 'dev'], ['optional', 'optionalDependencies', 'optional'], ['peer', 'peerDependencies', 'peer']]) {
    const entry = await tarball(f, repo, name, version);
    pkg[group] = { [name]: entry.resolved };
    entries[`node_modules/${name}`] = { ...entry, ...(flag ? { [flag]: true } : {}) };
  }
  const { agentui: _agentui, packageManager: _manager, type: _type, scripts: _scripts, ...root } = pkg;
  const lock = { name: pkg.name, version: pkg.version, lockfileVersion: 3, requires: true, packages: { '': root, ...entries } };
  await write(repo.directory, 'package.json', pkg);
  await write(repo.directory, 'package-lock.json', lock);
  await write(repo.directory, 'index.mjs', "import value from 'value'; import dev from 'development'; import optional from 'optional'; import peer from 'peer'; export default [value, dev, optional, peer];\n");
  return { pkg, lock };
}
export async function files(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await files(path));
    else result.push(path);
  }
  return result;
}
