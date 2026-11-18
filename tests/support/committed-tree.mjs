import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const checkout = fileURLToPath(new URL('../../', import.meta.url));
export const networkTests = process.env.AGENTUI_CUSTOMIZATION_NETWORK_TESTS === '1';
const gitEnv = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
  GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' };
export const git = (cwd, ...args) => execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args],
  { cwd, encoding: 'utf8', env: gitEnv, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 }).trim();

/**
 * A fixture repository holding this checkout's whole committed tree with the working tree's changes laid over it.
 * The resolver requires every workspace member the root package.json declares, so a partial copy would not resolve.
 */
export async function committedTreeRepository(t) {
  const root = await mkdtemp(join(tmpdir(), 'agentui-committed-tree-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, 'source');
  await mkdir(directory);
  execFileSync('sh', ['-c', 'git -C "$1" archive HEAD | tar -x -C "$2"', 'archive', checkout, directory], { env: gitEnv, stdio: 'ignore' });
  const changed = git(checkout, 'ls-files', '-z', '--modified', '--others', '--exclude-standard').split('\0').filter(Boolean);
  const deleted = new Set(git(checkout, 'ls-files', '-z', '--deleted').split('\0').filter(Boolean));
  for (const path of new Set(changed)) {
    if (deleted.has(path)) continue;
    await mkdir(dirname(join(directory, path)), { recursive: true });
    await cp(join(checkout, path), join(directory, path));
  }
  for (const path of deleted) await rm(join(directory, path), { force: true });
  git(directory, 'init', '--quiet', '--template=');
  git(directory, 'config', 'user.email', 'fixture@example.invalid');
  git(directory, 'config', 'user.name', 'Fixture');
  const commit = (message = 'fixture') => { git(directory, 'add', '-A', '.'); git(directory, 'commit', '--quiet', '--allow-empty', '-m', message); return git(directory, 'rev-parse', 'HEAD'); };
  return { root, directory, commit, scratchParent: join(root, 'scratch') };
}
