import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { request } from 'node:http';
import { createInterface } from 'node:readline';
import { directCodexEnvironment } from '../../../apps/host/build/tsc/native-environment.js';

const root = new URL('../../../', import.meta.url);

export async function within(promise, description, milliseconds = 8000, onTimeout = () => {}) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => {
        onTimeout();
        reject(new Error(`${description} deadline exceeded`));
      }, milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}

export function launchProcess(t, args, environment = {}) {
  const process = spawn(globalThis.process.execPath, args, {
    cwd: root, env: { ...directCodexEnvironment(), ...environment }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '', stderr = '';
  process.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
  process.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
  const exited = new Promise((resolve, reject) => {
    process.once('error', reject);
    process.once('exit', (code, signal) => resolve({ code, signal }));
  });
  const child = { process, exited, get stdout() { return stdout; }, get stderr() { return stderr; } };
  t.after(() => stopProcess(child));
  return child;
}

export async function stopProcess(child) {
  if (child.process.exitCode !== null || child.process.signalCode !== null) return;
  child.process.kill('SIGTERM');
  try {
    await within(child.exited, 'Process cleanup', 2000, () => child.process.kill('SIGKILL'));
  } catch {
    await child.exited;
  }
}

export async function exitWithin(child, milliseconds = 5000) {
  const result = await within(child.exited, `Process exit. ${child.stderr}`, milliseconds, () => child.process.kill('SIGKILL'));
  assert.deepEqual(result, { code: 0, signal: null }, child.stderr);
}

export async function startup(child, parseLine = JSON.parse) {
  const lines = createInterface({ input: child.process.stdout });
  const ready = new Promise((resolve, reject) => {
    lines.on('line', line => {
      try {
        const value = parseLine(line);
        if (value) resolve({ kind: 'ready', ...value });
      } catch (error) { reject(error); }
    });
  });
  try {
    return await within(Promise.race([ready, child.exited.then(result => ({ kind: 'exit', ...result }))]),
      'Host startup', 8000, () => child.process.kill('SIGKILL'));
  } finally { lines.close(); }
}

export function hostRequest(origin, path, body, headers = {}, method = 'POST') {
  return new Promise((resolve, reject) => {
    const outgoing = request(`${origin}${path}`, { method, headers: { 'Content-Type': 'application/json', ...headers } }, incoming => {
      let text = '';
      incoming.setEncoding('utf8').on('data', chunk => { text += chunk; });
      incoming.once('error', reject);
      incoming.once('end', () => {
        let body;
        try { body = JSON.parse(text); } catch { body = text; }
        resolve({ status: incoming.statusCode, headers: incoming.headers, body });
      });
    });
    outgoing.once('error', reject);
    outgoing.setTimeout(5000, () => outgoing.destroy(new Error('Host request deadline exceeded')));
    outgoing.end(body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body));
  });
}

export function browserRequest(origin, body, cookie = '', headers = {}) {
  return hostRequest(origin, '/api/v1', body, { Origin: origin, ...(cookie ? { Cookie: cookie } : {}), ...headers });
}

export async function control(t, args, environment) {
  const child = launchProcess(t, args, environment);
  await exitWithin(child);
  const response = JSON.parse(child.stdout);
  assert.equal(response.ok, true);
  return response.value;
}

export async function pairBrowser(t, origin, inviteArgs, environment) {
  const invitation = await control(t, inviteArgs, environment);
  const response = await browserRequest(origin, { op: 'pair', code: invitation.code });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  const cookie = response.headers['set-cookie'][0].split(';')[0];
  return { code: invitation.code, cookie };
}
