import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

const [node, main, ...args] = process.argv.slice(2);
let host;
let hostGroupPid = null;
let stopping;
const lines = createInterface({ input: process.stdin, terminal: false });
function forceStopHost() {
  if (hostGroupPid === null) return;
  try {
    if (process.platform === 'win32') host.kill('SIGKILL');
    else process.kill(-hostGroupPid, 'SIGKILL');
  } catch (error) { if (error.code !== 'ESRCH') throw error; }
  hostGroupPid = null;
}
async function stop() {
  if (stopping) return stopping;
  stopping = (async () => {
    if (!host) return;
    if (host.exitCode !== null || host.signalCode !== null) { forceStopHost(); return; }
    const exited = new Promise(resolve => host.once('close', resolve));
    host.kill('SIGINT');
    const deadline = setTimeout(forceStopHost, 15_000);
    try { await exited; } finally { clearTimeout(deadline); forceStopHost(); }
  })();
  await stopping;
  lines.close();
  process.stdin.destroy();
}
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => { void stop(); });
lines.once('line', line => {
  let environment;
  try {
    const supplied = JSON.parse(line);
    if (supplied.OPENCODE_GO_API_KEY !== null && typeof supplied.OPENCODE_GO_API_KEY !== 'string') throw new Error();
    environment = { ...process.env, ...(process.env.OPENCODE_GO_API_KEY ? {} : supplied.OPENCODE_GO_API_KEY ? { OPENCODE_GO_API_KEY: supplied.OPENCODE_GO_API_KEY } : {}) };
  } catch {
    process.stderr.write('Invalid AgentUI session environment.\n');
    process.exitCode = 1;
    lines.close();
    process.stdin.destroy();
    return;
  }
  host = spawn(node, [main, ...args], { detached: process.platform !== 'win32', env: environment, stdio: ['ignore', 'inherit', 'inherit'] });
  hostGroupPid = host.pid ?? null;
  host.once('error', error => {
    process.stderr.write(`Cannot start AgentUI host: ${error.message}\n`);
    process.exitCode = 1;
    void stop();
  });
  host.once('exit', (code, signal) => {
    forceStopHost();
    if (!stopping) process.exitCode = code ?? (signal ? 1 : 0);
    lines.close();
    process.stdin.destroy();
  });
});
lines.once('close', () => { void stop(); });
