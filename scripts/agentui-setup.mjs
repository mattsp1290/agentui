import { spawn } from 'node:child_process';
import { readFile, realpath } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootstrapScript, distribution, harnessInstallScript, shellQuote } from './agentui-runtime.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const usage = `Usage: ./agentui setup --agent codex|pi|claude [--ssh USER@HOST]

Installs a pinned harness in AgentUI's private tools directory and exits.
Does not sign in, start a host, or open the app. No provider credentials are required.
SSH must already connect in batch mode with normal host-key verification.
`;
const claudeCli = { sdkVersion: '0.3.323', version: '2.1.323' };

export function parseSetupArgs(args) {
  const values = new Map();
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) return { kind: 'help' };
  for (let index = 0; index < args.length; index++) {
    const option = args[index], value = args[++index];
    if (!['--agent', '--ssh'].includes(option) || !value || value.startsWith('-') || values.has(option)) {
      throw new Error(usage);
    }
    values.set(option, value);
  }
  const agent = values.get('--agent');
  if (!['codex', 'pi', 'claude'].includes(agent)) throw new Error(usage);
  const destination = values.get('--ssh');
  if (destination && (!/^[A-Za-z0-9_][A-Za-z0-9_.@:-]*$/u.test(destination) || destination.includes('..'))) throw new Error(usage);
  return { agent, target: destination ? { kind: 'ssh', destination } : { kind: 'local' } };
}

export async function harnessSpecifications() {
  const { CODEX_RUNTIME, PI_RUNTIME, CLAUDE_SDK_RUNTIMES } = await import('../packages/contracts/src/compatibility.ts');
  if (Object.values(CLAUDE_SDK_RUNTIMES).some(runtime => runtime.version !== claudeCli.sdkVersion)) {
    throw new Error('Harness installation pins need to be updated for the current runtime contracts.');
  }
  return {
    codex: { id: 'codex', packageName: '@openai/codex', version: CODEX_RUNTIME.version, executable: 'codex', expectedVersion: `codex-cli ${CODEX_RUNTIME.version}` },
    pi: { id: 'pi', packageName: '@earendil-works/pi-coding-agent', version: PI_RUNTIME.version, executable: 'pi', expectedVersion: PI_RUNTIME.version },
    claude: { id: 'claude', packageName: '@anthropic-ai/claude-code', version: claudeCli.version, executable: 'claude', expectedVersion: `${claudeCli.version} (Claude Code)` },
  };
}

export function setupScript(nodeVersion, specification) {
  return `${bootstrapScript(nodeVersion, 'pi', '')}
${harnessInstallScript(specification)}
"$node" --input-type=commonjs -e 'const [agent,version,executable,os,arch]=process.argv.slice(1); console.log("AGENTUI_INSTALLED "+JSON.stringify({event:"installed",agent,version,executable,os,arch,authentication:"not-checked"}));' ${[specification.id, specification.version].map(shellQuote).join(' ')} "$harness" "$os" "$arch"
`;
}

export async function setup(options) {
  if (options.kind === 'help') { process.stdout.write(usage); return; }
  const [specifications, nodeVersion] = await Promise.all([harnessSpecifications(), readFile(join(root, '.node-version'), 'utf8')]);
  const script = setupScript(nodeVersion.trim(), specifications[options.agent]);
  const remote = options.target.kind === 'ssh';
  const command = remote ? 'ssh' : '/bin/sh';
  const args = remote
    ? ['-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=2', options.target.destination, 'sh -s']
    : ['-s'];
  const child = spawn(command, args, { detached: true, stdio: ['pipe', 'pipe', 'inherit'] });
  let interrupted = false, output = '', overflow = false, killTimer;
  const terminate = signal => {
    if (!child.pid) return;
    try { process.kill(-child.pid, signal); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  };
  const interrupt = () => {
    interrupted = true;
    terminate('SIGTERM');
    killTimer ??= setTimeout(() => terminate('SIGKILL'), 5000);
  };
  const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'];
  for (const signal of signals) process.on(signal, interrupt);
  try {
    child.stdout.setEncoding('utf8').on('data', data => {
      if (output.length + data.length > 64_000) { overflow = true; interrupt(); }
      else output += data;
    });
    child.stdin.on('error', () => {});
    child.stdin.end(script);
    const result = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolve({ code, signal }));
    });
    if (interrupted || result.code !== 0) throw new Error(overflow ? 'Setup output exceeded its limit.' : 'Harness setup did not complete.');
    const records = output.split('\n').filter(line => line.startsWith('AGENTUI_INSTALLED '));
    if (records.length !== 1) throw new Error('Harness setup did not return an installation result.');
    let record;
    try {
      record = JSON.parse(records[0].slice('AGENTUI_INSTALLED '.length));
      if (!record || typeof record !== 'object' || Array.isArray(record) ||
          Object.keys(record).sort().join(',') !== 'agent,arch,authentication,event,executable,os,version' ||
          record.event !== 'installed' || record.agent !== options.agent || record.version !== specifications[options.agent].version ||
          typeof record.executable !== 'string' || !record.executable.startsWith('/') || record.executable.length > 4096 ||
          /[\0\r\n]/u.test(record.executable) || record.authentication !== 'not-checked') throw new Error();
      distribution(record.os, record.arch);
    } catch { throw new Error('Harness setup returned an invalid installation result.'); }
    process.stdout.write(`${JSON.stringify({ ...record, target: remote ? options.target.destination : 'local' })}\n`);
  } finally {
    clearTimeout(killTimer);
    for (const signal of signals) process.off(signal, interrupt);
  }
}

if (process.argv[1] && await realpath(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await setup(parseSetupArgs(process.argv.slice(2))); }
  catch (error) { process.stderr.write(`${error instanceof Error ? error.message : 'Harness setup failed.'}\n`); process.exitCode = 1; }
}
