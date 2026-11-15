import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { SERVICE_CATALOG_PAGE } from '@agentui/contracts/service';
import { z } from 'zod';
import { idSchema, loadAccess, ReadError } from './access.js';
import { pair } from './pair.js';
import { Reader } from './reader.js';

async function serve(path: string): Promise<void> {
  const reader = new Reader(await loadAccess(path));
  await reader.authorize(AbortSignal.timeout(5000));
  const server = new McpServer({ name: 'agentui-read', version: '0.0.0' });
  const annotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
  const call = async (operation: (signal: AbortSignal) => Promise<Record<string, unknown>>, signal: AbortSignal) => {
    try {
      const structuredContent = await operation(AbortSignal.any([signal, AbortSignal.timeout(8000)]));
      return { structuredContent, content: [{ type: 'text' as const, text: JSON.stringify(structuredContent) }] };
    } catch (error) {
      const message = error instanceof ReadError ? error.message : 'AgentUI read failed';
      return { isError: true, content: [{ type: 'text' as const, text: message }] };
    }
  };
  server.registerTool('agentui_agents', {
    description: 'Read advertised agents, commands and availability. Commands describe the agent, not permission to write through this adapter.',
    inputSchema: z.strictObject({}), annotations,
  }, (_, extra) => call(signal => reader.agents(signal), extra.signal));
  server.registerTool('agentui_conversations', {
    description: 'Read a bounded page of recorded conversations. Follow after until null.',
    inputSchema: z.strictObject({ after: idSchema.nullable().default(null), limit: z.number().int().min(1).max(SERVICE_CATALOG_PAGE).default(20) }), annotations,
  }, (input, extra) => call(signal => reader.conversations(input.after, input.limit, signal), extra.signal));
  server.registerTool('agentui_inspect', {
    description: 'Read stored state at a cursor, current run, retained receipts, pending decisions and command activities. No provider refresh or historical run enumeration. Message text and command output are omitted.',
    inputSchema: z.strictObject({ conversationId: idSchema }), annotations,
  }, (input, extra) => call(signal => reader.inspect(input.conversationId, signal), extra.signal));
  server.registerTool('agentui_receipt', {
    description: 'Read an original command receipt without reconciliation. A null receipt is not proof that the command did not execute.',
    inputSchema: z.strictObject({ conversationId: idSchema, clientCommandId: idSchema }), annotations,
  }, (input, extra) => call(signal => reader.receipt(input.conversationId, input.clientCommandId, signal), extra.signal));
  await server.connect(new StdioServerTransport());
}

try {
  const [command, first, second, ...extra] = process.argv.slice(2);
  if (command === 'serve' && first && second === undefined) await serve(first);
  else if (command === 'pair' && first && second && extra.length === 0) await pair(first, second);
  else throw new Error('Invalid arguments');
} catch {
  process.stderr.write('AgentUI MCP startup failed. Check the command, private profile and host authorization. Pairing is never retried automatically.\n');
  process.exitCode = 1;
}
