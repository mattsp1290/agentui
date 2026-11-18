import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const clean = () => Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_') && !key.startsWith('AGENTUI_EXTENSION_') &&
  !['EMAIL', 'HOME'].includes(key)));

/**
 * A temporary git world under `directory`: an empty HOME with its own git identity, and a local bare remote whose
 * `customization` branch holds `files`. No real remote and no real git configuration is touched.
 */
export async function seedRemote(directory, files) {
  const home = join(directory, 'home');
  await mkdir(home, { recursive: true });
  const gitconfig = join(home, '.gitconfig');
  await writeFile(gitconfig, '[user]\n\tname = Session Test\n\temail = session@example.invalid\n[commit]\n\tgpgsign = false\n[init]\n\tdefaultBranch = main\n');
  const gitEnvironment = { ...clean(), HOME: home, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: gitconfig };
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: gitEnvironment, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const remote = join(directory, 'remote.git');
  git(directory, 'init', '--quiet', '--bare', remote);
  const seed = join(directory, 'seed');
  await mkdir(seed);
  git(seed, 'init', '--quiet', '-b', 'customization');
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(seed, path)), { recursive: true });
    await writeFile(join(seed, path), text);
  }
  git(seed, 'add', '-A');
  git(seed, 'commit', '--quiet', '-m', 'Seed');
  git(seed, 'push', '--quiet', remote, 'customization');
  return { home, gitconfig, gitEnvironment, git, remote, seed };
}
