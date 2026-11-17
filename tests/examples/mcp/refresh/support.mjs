import assert from 'node:assert/strict';
import { appendFile, cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

export const main = fileURLToPath(new URL('../../../../examples/mcp-control/refresh/dist/main.js', import.meta.url));
export const recordResource = async value => { if (process.env.AGENTUI_MCP_RESOURCE_JOURNAL) await appendFile(process.env.AGENTUI_MCP_RESOURCE_JOURNAL, JSON.stringify(value) + '\n'); };
export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
export const absent = (pid, group = false) => { try { process.kill(group ? -pid : pid, 0); return false; } catch (e) { if (e.code === 'ESRCH') return true; throw e; } };
export async function until(read, predicate = Boolean) {
  for (let i = 0; i < 200; i++) { const result = await read(); if (predicate(result)) return result; await sleep(20); }
  throw new Error('Observation deadline exceeded');
}
export async function directory(t) {
  const root = await mkdtemp(join(tmpdir(), 'agentui-mcp-test-'));
  await recordResource({ type: 'directory', path: root });
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
export async function installed(t) {
  const root = await directory(t), entry = join(root, 'installed', 'main.js');
  await cp(new URL('../../../../apps/host/dist/', import.meta.url), join(root, 'installed'), { recursive: true });
  await writeFile(join(root, 'package.json'), JSON.stringify({ type: 'module' }));
  return { root, entry };
}
export async function client(t, entry, root, waitMs = 10000) {
  const transport = new StdioClientTransport({ command: process.execPath, args: [main, entry, root, String(waitMs)], stderr: 'pipe', env: { PROVIDER_SECRET_SENTINEL: 'never-forward' } });
  const client = new Client({ name: 'refresh-proof', version: '1' });
  let stderr = ''; transport.stderr.on('data', bytes => { stderr += bytes; });
  await client.connect(transport);
  const pid = transport.pid;
  await recordResource({ type: 'adapter', pid, root });
  t.after(async () => { await client.close(); await until(() => absent(pid)); assert.equal(stderr, ''); });
  return { client, transport, pid, call: operation => client.callTool({ name: 'agentui_refresh', arguments: { operation } }) };
}
export async function synthetic(t, mode) {
  const root = await directory(t), entry = join(root, 'synthetic.mjs'), record = join(root, 'record.json');
  await writeFile(entry, `import {appendFileSync,readFileSync} from 'node:fs'; import {spawn} from 'node:child_process';
const args=process.argv.slice(2), source=args[args.indexOf('--source')+1];
appendFileSync(${JSON.stringify(record)},JSON.stringify({pid:process.pid,source:process.env.AGENTUI_REFRESH_SOURCE,cwd:process.cwd(),env:process.env,args,reference:process.env.AGENTUI_REFRESH_SOURCE?JSON.parse(readFileSync(source)):null})+'\\n');
const id=args[args.indexOf('--request')+1];
${mode}
`);
  const recorded = new Set();
  const records = async () => (await readFile(record, 'utf8').catch(() => '')).split('\n').filter(Boolean).map(line => JSON.parse(line));
  return { root, entry, record, records, read: async () => {
    const values = await records();
    for (const value of values) if (!recorded.has(value.pid)) { recorded.add(value.pid); await recordResource({ type: 'cli', ...value }); }
    return values.at(-1) ?? null;
  } };
}
