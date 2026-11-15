import { record } from '@agentui/contracts/decode';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { commitId, containedPath, CustomizationError, parseCustomizationPackage, repositoryLocation } from './contract.js';
import type { CustomizationSource } from './contract.js';

const execute = promisify(execFile);
const MAX_BYTES = 256 * 1024 * 1024;
const selectors = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_COMMON_DIR', 'GIT_NAMESPACE', 'GIT_REPLACE_REF_BASE', 'GIT_SHALLOW_FILE'];

function gitEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_NO_REPLACE_OBJECTS: '1', GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' };
  for (const key of selectors) delete env[key];
  return env;
}

async function git(args: string[], cwd: string, env: NodeJS.ProcessEnv, fetching = false, deadline = Infinity): Promise<Buffer> {
  try {
    if (Date.now() >= deadline) throw new CustomizationError('resource-limit', 'Customization source deadline exceeded.');
    const { stdout } = await execute('git', ['-c', 'protocol.allow=never', '-c', 'protocol.file.allow=always',
      '-c', 'protocol.ssh.allow=always', '-c', 'protocol.https.allow=always', ...args], {
      cwd, env, encoding: 'buffer', timeout: Math.max(1, Math.min(fetching ? 120_000 : 30_000, deadline - Date.now())), maxBuffer: MAX_BYTES,
    });
    return stdout;
  } catch (error) {
    if (error instanceof CustomizationError) throw error;
    // Git diagnostics can contain repository credentials. Only retain a fixed classification.
    const stderr = error && typeof error === 'object' && 'stderr' in error && Buffer.isBuffer(error.stderr) ? error.stderr.toString('utf8') : '';
    if (fetching && /not our ref|couldn't find remote ref|unadvertised object/iu.test(stderr)) {
      throw new CustomizationError('unknown-commit', 'The repository could not supply the requested commit. Check the full commit ID.');
    }
    if (fetching && /does not appear to be a git repository|repository .* does not exist|repository not found|authentication failed|permission denied/iu.test(stderr)) {
      throw new CustomizationError('access', 'The repository is unavailable. Check its location and existing Git access.');
    }
    throw new CustomizationError('retrieval-failed', 'Git could not retrieve the snapshot. Check repository access and the requested commit.');
  }
}

interface TreeFile { readonly path: string; readonly object: string; readonly executable: boolean }
function treeFiles(tree: Buffer, maxFiles: number): TreeFile[] {
  const entries: TreeFile[] = [];
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let text: string;
  try { text = decoder.decode(tree); } catch { throw new CustomizationError('path', 'Repository filenames must be valid UTF-8.'); }
  for (const record of text.split('\0')) {
    if (!record) continue;
    const match = /^(\d{6}) (\w+) ([a-f0-9]+)\t([\s\S]+)$/u.exec(record);
    if (!match || !match[1] || !match[2] || !match[3] || !match[4]) throw new CustomizationError('retrieval-failed', 'Git returned an invalid tree.');
    if (!['100644', '100755'].includes(match[1]) || match[2] !== 'blob') {
      throw new CustomizationError('unsupported-tree-entry', 'Customization snapshots do not support symlinks or Git submodules.');
    }
    entries.push({ path: containedPath(match[4]), object: match[3], executable: match[1] === '100755' });
    if (entries.length > maxFiles) throw new CustomizationError('resource-limit', 'Customization source file limit exceeded.');
  }
  return entries;
}

export interface SourceFile { readonly path: string; readonly sha256: string; readonly executable: boolean }
export interface CommittedInputs { readonly identity: string; readonly files: readonly SourceFile[] }
export interface ReadAllowance { files: number; bytes: number; readonly deadline: number }
export interface RepositoryTree {
  readonly commit: string;
  readonly directory: string;
  readonly inputs: CommittedInputs;
  dispose(): Promise<void>;
}
export function identity(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export interface CustomizationSnapshot {
  readonly commit: string;
  readonly directory: string;
  readonly customization?: CustomizationSource;
  dispose(): Promise<void>;
}

export async function readCommittedRepository(input: {
  readonly repository: string;
  readonly commit: string;
  readonly scratchParent: string;
  readonly allowance?: ReadAllowance;
}): Promise<RepositoryTree> {
  const allowance = input.allowance ?? { files: 20_000, bytes: MAX_BYTES, deadline: Infinity };
  const commit = commitId(input.commit);
  const repository = repositoryLocation(input.repository);
  const location = repository.includes(':') || isAbsolute(repository) ? repository : resolve(repository);
  const scratchParent = resolve(input.scratchParent);
  await mkdir(scratchParent, { recursive: true, mode: 0o700 });
  const privateDirectory = await mkdtemp(join(scratchParent, 'agentui-source-'));
  const directory = join(privateDirectory, 'source');
  const objects = join(privateDirectory, 'objects.git');
  const dispose = () => rm(privateDirectory, { recursive: true, force: true });
  try {
    await chmod(privateDirectory, 0o700);
    const env = gitEnvironment();
    await git(['init', '--bare', '--template=', `--object-format=${commit.length === 64 ? 'sha256' : 'sha1'}`, objects], privateDirectory, env, false, allowance.deadline);
    await git(['--git-dir', objects, 'fetch', '--no-tags', '--no-write-fetch-head', '--no-recurse-submodules', '--', location, commit], privateDirectory, env, true, allowance.deadline);
    const canonical = (await git(['--git-dir', objects, 'rev-parse', '--verify', `${commit}^{commit}`], privateDirectory, env, false, allowance.deadline)).toString('utf8').trim();
    if (canonical !== commit) throw new CustomizationError('unknown-commit', 'The requested object is not the specified commit.');
    const entries = treeFiles(await git(['--git-dir', objects, 'ls-tree', '-rz', '--full-tree', commit], privateDirectory, env, false, allowance.deadline), allowance.files);
    await mkdir(directory, { mode: 0o700 });
    const files: SourceFile[] = [];
    allowance.files -= entries.length;
    for (const entry of entries) {
      const blob = await git(['--git-dir', objects, 'cat-file', 'blob', entry.object], privateDirectory, env, false, allowance.deadline);
      allowance.bytes -= blob.length;
      if (allowance.bytes < 0) throw new CustomizationError('resource-limit', 'Customization snapshot exceeds 256 MiB.');
      files.push(Object.freeze({ path: entry.path, sha256: createHash('sha256').update(blob).digest('hex'), executable: entry.executable }));
      const destination = join(directory, entry.path);
      await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
      await writeFile(destination, blob, { flag: 'wx', mode: entry.executable ? 0o700 : 0o600 });
      if (entry.executable) await chmod(destination, 0o700);
    }
    files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    const inputs = Object.freeze({ identity: identity(['agentui-tree-v1', files]), files: Object.freeze(files) });
    await rm(objects, { recursive: true, force: true });
    return { commit: canonical, directory, inputs, dispose };
  } catch (error) {
    await dispose();
    if (error instanceof CustomizationError) throw error;
    throw new CustomizationError('retrieval-failed', 'Could not materialize the committed customization snapshot.');
  }
}

export async function readCustomizationSnapshot(input: {
  readonly repository: string;
  readonly commit: string;
  readonly scratchParent: string;
}): Promise<CustomizationSnapshot> {
  const tree = await readCommittedRepository(input);
  try {
    const files = new Set(tree.inputs.files.map(file => file.path));
    if (!files.has('package.json')) return { commit: tree.commit, directory: tree.directory, dispose: tree.dispose };
    const packageJson: unknown = JSON.parse(await readFile(join(tree.directory, 'package.json'), 'utf8'));
    const lock: unknown = files.has('package-lock.json') ? JSON.parse(await readFile(join(tree.directory, 'package-lock.json'), 'utf8')) : undefined;
    const customization = parseCustomizationPackage(packageJson, files, { lock, packagePath: '', packageManager: record(packageJson).packageManager });
    return { commit: tree.commit, directory: tree.directory, ...(customization ? { customization } : {}), dispose: tree.dispose };
  } catch (error) {
    await tree.dispose();
    if (error instanceof CustomizationError) throw error;
    throw new CustomizationError('invalid-package', 'Expected valid committed package.json and package-lock.json JSON.');
  }
}
