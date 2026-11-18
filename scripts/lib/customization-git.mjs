// The customization worker's git writer. Every command has a fixed argument list (no shell), runs with hooks disabled,
// without an auto-detected identity, without prompts and in the C locale, and never with a force flag. Captured output
// stays on this machine: it is used to classify failures and the tail of a failed command goes to the store's git.log.
import { spawn } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';

export const GIT_TIMEOUT_MS = 120_000;
const OUTPUT_TAIL = 16 * 1024;

export class GitFailure extends Error {
  constructor(cause, output = '') {
    super(`git ${cause}`);
    this.cause = cause;
    this.output = output;
  }
}

/**
 * Runs one git command. Resolves `{ code, output, stdout }` (`output` is the combined tail, `stdout` is null past its limit); rejects with `GitFailure('git-timeout')` when the deadline passes
 * (a signing prompt that blocks ends here) and kills the command's process group when `signal` aborts.
 */
export function runGit(args, { cwd, signal, timeoutMs = GIT_TIMEOUT_MS, env = process.env, registerChild, stdoutLimit = 8 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new GitFailure('aborted')); return; }
    const child = spawn('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'user.useConfigOnly=true', ...args], {
      cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C', GIT_ASKPASS: '', SSH_ASKPASS: '', GCM_INTERACTIVE: 'never' },
    });
    registerChild?.(child);
    let output = '', stdout = '', settled = false, timedOut = false;
    const keep = data => { output = (output + data).slice(-OUTPUT_TAIL); };
    child.stdout.on('data', data => { keep(data); if (stdout.length <= stdoutLimit) stdout += data; });
    child.stderr.on('data', keep);
    const kill = () => { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ } };
    const timer = setTimeout(() => { timedOut = true; kill(); }, timeoutMs);
    const abort = () => kill();
    signal?.addEventListener('abort', abort, { once: true });
    const finish = (value, error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (error) reject(error); else resolve(value);
    };
    child.once('error', () => finish(null, new GitFailure('git-failed')));
    child.once('close', code => {
      if (signal?.aborted) finish(null, new GitFailure('aborted', output));
      else if (timedOut) finish(null, new GitFailure('git-timeout', output));
      else finish({ code, output, stdout: stdout.length > stdoutLimit ? null : stdout });
    });
  });
}

/** Maps git's C-locale output for a failed push to one fixed cause. */
export function pushFailure(output) {
  if (/Authentication failed|Permission denied|could not read Username|could not read Password|terminal prompts disabled|returned error: 40[13]|Host key verification failed/u.test(output)) return 'push-unauthorized';
  if (/\[rejected\]|\[remote rejected\]|non-fast-forward|fetch first|hook declined|failed to push some refs/u.test(output)) return 'push-rejected';
  return 'git-failed';
}
export function commitFailure(output) {
  return /Author identity unknown|Committer identity unknown|empty ident name|no email was given and auto-detection is disabled|unable to auto-detect email address/u.test(output)
    ? 'identity-missing' : 'git-failed';
}

// A minimal JSON tokenizer that keeps byte spans, so one value can be replaced without re-serializing the file.
function parseSpans(text) {
  let index = 0;
  const fail = () => { throw new Error('Invalid JSON'); };
  const space = () => { while (index < text.length && ' \t\n\r'.includes(text[index])) index++; };
  const string = () => {
    if (text[index] !== '"') fail();
    const start = index++;
    while (index < text.length && text[index] !== '"') index += text[index] === '\\' ? 2 : 1;
    if (index >= text.length) fail();
    index++;
    return { start, end: index, value: JSON.parse(text.slice(start, index)) };
  };
  const value = () => {
    space();
    const start = index;
    const character = text[index];
    if (character === '{') {
      index++;
      const members = [];
      space();
      if (text[index] === '}') { index++; return { kind: 'object', start, end: index, members }; }
      for (;;) {
        space();
        const key = string();
        space();
        if (text[index++] !== ':') fail();
        const node = value();
        members.push({ key: key.value, node });
        space();
        if (text[index] === ',') { index++; continue; }
        if (text[index] === '}') { index++; return { kind: 'object', start, end: index, members }; }
        fail();
      }
    }
    if (character === '[') {
      index++;
      const items = [];
      space();
      if (text[index] === ']') { index++; return { kind: 'array', start, end: index, items }; }
      for (;;) {
        items.push(value());
        space();
        if (text[index] === ',') { index++; continue; }
        if (text[index] === ']') { index++; return { kind: 'array', start, end: index, items }; }
        fail();
      }
    }
    if (character === '"') { const item = string(); return { kind: 'scalar', start, end: item.end }; }
    const match = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/u.exec(text.slice(index));
    if (!match) fail();
    index += match[0].length;
    return { kind: 'scalar', start, end: index };
  };
  const root = value();
  space();
  if (index !== text.length) fail();
  return root;
}
const member = (node, key) => node?.kind === 'object' ? node.members.filter(item => item.key === key) : [];

/**
 * Sets `agentui.extensions[index].enabled` in a package.json text without re-serializing it. Returns
 * `{ kind: 'changed', text }`, `{ kind: 'unchanged' }` or `{ kind: 'unsupported' }`; the last when the layout cannot be
 * edited safely or the result would change anything but that one flag.
 */
export function setReferenceEnabled(text, index, enabled) {
  let root, original;
  try { root = parseSpans(text); original = JSON.parse(text); } catch { return { kind: 'unsupported' }; }
  const [agentui] = member(root, 'agentui');
  const [extensions] = member(agentui?.node, 'extensions');
  const reference = extensions?.node.kind === 'array' ? extensions.node.items[index] : undefined;
  if (member(root, 'agentui').length !== 1 || member(agentui.node, 'extensions').length !== 1 || reference?.kind !== 'object') return { kind: 'unsupported' };
  const flags = member(reference, 'enabled');
  if (flags.length > 1) return { kind: 'unsupported' };
  let changed;
  if (flags.length === 1) {
    const current = text.slice(flags[0].node.start, flags[0].node.end);
    if (current !== 'true' && current !== 'false') return { kind: 'unsupported' };
    if (current === String(enabled)) return { kind: 'unchanged' };
    changed = text.slice(0, flags[0].node.start) + String(enabled) + text.slice(flags[0].node.end);
  } else {
    if (enabled) return { kind: 'unchanged' };
    const last = reference.members.at(-1);
    changed = last ? text.slice(0, last.node.end) + ', "enabled": false' + text.slice(last.node.end)
      : text.slice(0, reference.end - 1) + '"enabled": false' + text.slice(reference.end - 1);
  }
  let result;
  try { result = JSON.parse(changed); } catch { return { kind: 'unsupported' }; }
  const expected = structuredClone(original);
  expected.agentui.extensions[index].enabled = enabled;
  const actual = structuredClone(result);
  if (flags.length === 0) {
    // Key order is irrelevant to the comparison; an inserted member appears last.
    const { enabled: value, ...rest } = actual.agentui.extensions[index];
    actual.agentui.extensions[index] = { ...rest, enabled: value };
  }
  return isDeepStrictEqual(actual, expected) ? { kind: 'changed', text: changed } : { kind: 'unsupported' };
}
