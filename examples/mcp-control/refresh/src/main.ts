import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { serializeMessage } from '@modelcontextprotocol/sdk/shared/stdio.js';
import type { CallToolResult, RequestId } from '@modelcontextprotocol/sdk/types.js';
import { realpath, stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { RefreshSession, failure, toolInput } from './refresh.js';
import type { Outcome } from './refresh.js';

const invocationDirectory = process.cwd();
export const outgoingLimit = 8 * 1024 * 1024;
export function present(outcome: Outcome, rpcId: RequestId): CallToolResult {
  const text = outcome.kind === 'receipt'
    ? 'Complete canonical receipt. New requests attempt desired selection; identical replay and status only inspect. Selection does not prove client activation.'
    : `Adapter ${outcome.reason}. Keep original request ID ${outcome.requestId}. Inspect with the direct installed CLI extensions-refresh-status --request ${outcome.requestId}. Ending this wait does not cancel host work.`;
  const result: CallToolResult = { ...(outcome.kind === 'adapter-error' ? { isError: true } : {}), structuredContent: outcome, content: [{ type: 'text', text }] };
  if (Buffer.byteLength(serializeMessage({ jsonrpc: '2.0', id: rpcId, result })) <= outgoingLimit) return result;
  if (outcome.kind === 'adapter-error') throw new Error('Response ID exceeds output allowance');
  return present(failure(outcome.requestId, 'output-limit; receipt requires direct installed-CLI status'), rpcId);
}
async function serve(): Promise<void> {
  const [entry, directory, duration = '30000', ...extra] = process.argv.slice(2);
  const waitMs = Number(duration);
  if (!entry || !directory || !isAbsolute(entry) || !isAbsolute(directory) || extra.length
      || !Number.isSafeInteger(waitMs) || waitMs < 100 || waitMs > 300000 || process.platform === 'win32') throw new Error('Invalid startup');
  const installedEntry = await realpath(entry), hostDirectory = await realpath(directory);
  const [entryStat, hostStat] = await Promise.all([stat(installedEntry), stat(hostDirectory)]);
  if (!entryStat.isFile() || !hostStat.isDirectory() || (hostStat.mode & 0o077) !== 0
      || hostStat.uid !== process.getuid?.()) throw new Error('Invalid installed entry or private host directory');
  const session = new RefreshSession({ executable: process.execPath, installedEntry, hostDirectory, invocationDirectory, waitMs });
  const server = new McpServer({ name: 'agentui-refresh', version: '0.0.0' });
  const transport = new StdioServerTransport(process.stdin, process.stdout, { maxBufferSize: 64 * 1024 });
  let closing = false;
  const stop = () => {
    if (closing) return;
    closing = true;
    const drain = session.close();
    const terminal = setTimeout(() => { session.destroy(); process.stdin.destroy(); process.stdout.destroy(); process.stderr.destroy(); process.exit(75); }, 2000);
    void (async () => {
      try {
        await transport.close();
        const clean = await drain;
        await server.close();
        clearTimeout(terminal);
        process.stdin.destroy(); process.stdout.destroy(); process.stderr.destroy();
        process.exit(clean ? 0 : 75);
      } catch {}
    })();
  };
  server.server.onclose = stop;
  server.server.onerror = stop;
  for (const event of ['end', 'close', 'error']) process.stdin.on(event, stop);
  process.stdout.on('error', stop);
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, stop);
  server.registerTool('agentui_refresh', {
    description: 'Request a committed customization build and automatic desired-selection attempt. Identical replay/status only inspect. Promote reuses saved command and pins. Keep the original ID after uncertainty. Disconnect/cancel ends only the CLI wait, not host work; selection does not prove client activation.',
    inputSchema: toolInput,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  }, async ({ operation }, extra) => {
    const outcome = await session.invoke(operation, extra.signal);
    if (outcome.kind === 'adapter-error' && outcome.reason === 'cleanup-unconfirmed') stop();
    if (closing || extra.signal.aborted) throw new Error('Refresh wait ended; inspect the original ID');
    return present(outcome, extra.requestId);
  });
  await server.connect(transport);
}
if (import.meta.main) {
  void serve().catch(() => { process.stderr.write('AgentUI refresh MCP startup failed. Supply an absolute installed entry, private host directory and optional wait milliseconds.\n'); process.exit(1); });
}
