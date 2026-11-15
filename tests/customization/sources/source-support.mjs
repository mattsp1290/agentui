import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { resolveCustomizationSources } from '@agentui/host/customization';

export const manager = 'npm@11.19.1';
export const digest = value => createHash('sha256').update(value).digest('hex');
export const integrity = 'sha512-' + Buffer.alloc(64, 42).toString('base64');
export function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' }, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
export async function write(directory, path, value) {
  await mkdir(dirname(join(directory, path)), { recursive: true });
  await writeFile(join(directory, path), typeof value === 'string' ? value : JSON.stringify(value));
}
export async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'agentui-sources-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const scratchParent = join(root, 'scratch');
  const repository = async name => {
    const directory = join(root, name);
    await mkdir(directory);
    git(directory, 'init', '--template=');
    git(directory, 'config', 'user.email', 'fixture@example.invalid');
    git(directory, 'config', 'user.name', 'Fixture');
    const commit = () => { git(directory, 'add', '.'); git(directory, 'commit', '--allow-empty', '-m', 'fixture'); return git(directory, 'rev-parse', 'HEAD'); };
    return { directory, commit };
  };
  const read = reference => resolveCustomizationSources({ reference, scratchParent });
  return { root, scratchParent, repository, read };
}
export async function shared(repo, path = '', extra = {}) {
  await write(repo.directory, join(path, 'source.ts'), 'export const value = 1;\n');
  await write(repo.directory, join(path, 'package.json'), { ...extra, agentui: { shared: './source.ts', ...extra.agentui } });
}
export const reference = (repo, commit, subdirectory) => ({ repository: repo.directory, commit, ...(subdirectory === undefined ? {} : { subdirectory }) });
export function lockFor(pkg, entries = {}) {
  const { agentui: _agentui, packageManager: _packageManager, ...root } = pkg;
  return { name: pkg.name, version: pkg.version, lockfileVersion: 3, packages: { '': root, ...entries } };
}
export const registry = { version: '1.0.0', resolved: 'https://registry.npmjs.org/value/-/value-1.0.0.tgz', integrity };
