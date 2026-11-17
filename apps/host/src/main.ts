import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { parseOperationSummary, parseSelectionStatus, parseReceiptChunk } from './selection-protocol.js';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { startBrowserHost } from './server.js';
import type { AgentConfiguration, NativeProvider } from './agent-config.js';
import { readAgentConfiguration } from './agent-config.js';
import { takeServerExtensionConfiguration } from './server-extension-config.js';
import { parseControlRequest, formatControlResponse, requestControl } from './control.js';
import type { ControlRequest } from './control.js';
import { readObservabilityConfiguration } from './observability.js';

const COMMANDS: Readonly<Record<string, readonly string[]>> = { desktop: ['port', 'workspace', 'assets', 'executable', 'preferred'], serve: ['port', 'assets', 'config', 'extensions', 'refresh-builder'], 'browser-dev': ['port', 'assets'], codex: ['port', 'workspace', 'assets', 'executable'], 'codex-sdk': ['port', 'workspace', 'assets', 'executable'], 'claude-sdk': ['port', 'workspace', 'assets', 'model', 'executable'], pi: ['port', 'workspace', 'assets'], invite: [], 'invite-native': [], 'providers-refresh': [], devices: ['after'], revoke: ['id'], 'extensions-refresh-request': ['request', 'source', 'expected-revision'], 'extensions-refresh-status': ['request'], 'extensions-refresh-promote': ['request'], 'extensions-select': ['operation', 'expected-revision', 'selection'], 'extensions-apply': ['operation', 'expected-revision', 'request'], 'extensions-retry': ['operation', 'expected-revision', 'request', 'after-attempt'], 'extensions-status': ['operation', 'attempt', 'receipt'] };
function selectionFile(path: string | undefined, description = 'artifact selection'): unknown {
  try { return JSON.parse(readFileSync(path ?? '', 'utf8')); }
  catch { throw new Error(`Invalid ${description} file`); }
}
async function main(): Promise<void> {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    'data-dir': { type: 'string' }, port: { type: 'string' }, id: { type: 'string' }, after: { type: 'string' },
    'refresh-builder': { type: 'string' }, config: { type: 'string' }, extensions: { type: 'string' }, executable: { type: 'string' }, model: { type: 'string' }, workspace: { type: 'string' }, assets: { type: 'string' },
    source: { type: 'string' }, request: { type: 'string' }, attempt: { type: 'string' }, 'after-attempt': { type: 'string' }, operation: { type: 'string' }, 'expected-revision': { type: 'string' }, selection: { type: 'string' }, receipt: { type: 'string' },
    preferred: { type: 'string' },
  } });
  if (!values['data-dir']) throw new Error('Provide --data-dir pointing to a private host directory');
  const [command, ...extra] = positionals;
  const allowed = command && Object.hasOwn(COMMANDS, command) ? COMMANDS[command] : undefined;
  if (extra.length || !command || !allowed) throw new Error('Use serve, codex, pi, browser-dev, invite, invite-native, devices, revoke, codex-sdk, claude-sdk, extensions-select, extensions-apply, extensions-retry, extensions-status, extensions-refresh-request, extensions-refresh-status, extensions-refresh-promote or providers-refresh');
  for (const flag of Object.keys(values)) {
    if (flag !== 'data-dir' && !allowed.includes(flag)) throw new Error(`--${flag} is not valid for ${command}`);
  }
  const directory = resolve(values['data-dir']);
  if (command === 'desktop' || command === 'serve' || command === 'browser-dev' || command === 'codex' || command === 'codex-sdk' || command === 'claude-sdk' || command === 'pi') {
    if (command === 'serve' && values.config === undefined && values.extensions === undefined) throw new Error('Provide --config or --extensions pointing to a configuration file');
    if (values.config !== undefined && !values.config.trim()) throw new Error('Invalid agent configuration');
    if (command === 'desktop' && (!values.workspace || (values.preferred !== 'codex' && values.preferred !== 'pi'))) throw new Error('Desktop startup requires --workspace and --preferred codex or pi.');
    const executable = values.executable ? { executable: resolve(values.executable) } : {};
    if (command === 'codex' && !values.workspace) throw new Error('Provide --workspace pointing to the directory Codex can work in');
    if (command === 'codex-sdk' && !values.workspace) throw new Error('Provide --workspace pointing to the directory for Codex SDK conversations');
    if (command === 'pi' && !values.workspace) throw new Error('Provide --workspace pointing to the directory for Pi conversations');
    let provider: NativeProvider | undefined;
    if (command === 'claude-sdk') {
      if (!values.workspace) throw new Error('Provide --workspace pointing to the directory for Claude SDK conversations');
      if (values.model !== 'opus' && values.model !== 'sonnet') throw new Error('Provide --model opus or --model sonnet for Claude SDK conversations');
      provider = { kind: command, cwd: resolve(values.workspace), model: values.model, ...executable };
    } else if ((command === 'codex' || command === 'codex-sdk' || command === 'pi') && values.workspace) {
      provider = { kind: command, cwd: resolve(values.workspace), ...(command === 'pi' ? {} : executable) };
    }
    const port = values.port === undefined ? 7140 : Number(values.port);
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid listener port');
    if (values.extensions !== undefined && !values.extensions.trim()) throw new Error('Invalid server extension configuration');
    const extensions = values.extensions === undefined ? undefined : takeServerExtensionConfiguration(resolve(values.extensions), process.env);
    const desktopAgents: AgentConfiguration['agents'] = [
      ...(values.preferred === 'codex' ? [{ name: 'codex', kind: 'codex', cwd: resolve(values.workspace ?? '.'), ...executable } satisfies AgentConfiguration['agents'][number]] : []),
      { name: 'pi', kind: 'pi', cwd: resolve(values.workspace ?? '.') },
    ];
    const setupCapability = process.env.AGENTUI_SETUP_CAPABILITY ?? '';
    delete process.env.AGENTUI_SETUP_CAPABILITY;
    const host = await startBrowserHost({ directory, port, observability: readObservabilityConfiguration(process.env), assetsDirectory: values.assets ? resolve(values.assets) : fileURLToPath(new URL('../../desktop/web-dist-browser/', import.meta.url)),
      ...(extensions === undefined ? {} : { extensions }),
      ...(values['refresh-builder'] === undefined ? {} : { refreshBuilder: values['refresh-builder'] }),
      ...(command === 'desktop' ? { setupCapability } : {}),
      agentStartup: command === 'desktop' ? { kind: 'desktop', configuration: { default: values.preferred ?? 'codex', agents: desktopAgents } } : values.config !== undefined ? { kind: 'configured', configuration: readAgentConfiguration(resolve(values.config)) }
        : provider ? { kind: 'provider', provider } : { kind: command === 'browser-dev' ? 'recorded' : 'extensions' } });
    void host.fatal.then(() => { process.exitCode = 1; });
    const close = () => { void host.close().catch(() => { process.exitCode = 1; }); };
    process.on('SIGINT', close);
    process.on('SIGTERM', close);
    process.stdout.write(`${JSON.stringify({ mode: command === 'browser-dev' ? 'browser-development' : command, origin: host.origin, hostId: host.hostId })}\n`);
    return;
  }
  const expectedRevision = values['expected-revision'] === undefined ? undefined : Number(values['expected-revision']);
  let request: ControlRequest;
  switch (command) {
    case 'extensions-refresh-request':
      request = parseControlRequest({ op: command, request: { id: values.request, reference: selectionFile(values.source, 'refresh source'), expectedSelectionRevision: expectedRevision } });
      break;
    case 'extensions-refresh-status': case 'extensions-refresh-promote':
      request = parseControlRequest({ op: command, id: values.request });
      break;
    case 'extensions-select':
      request = parseControlRequest({ op: command, command: { id: values.operation, expectedRevision, selection: selectionFile(values.selection) } });
      break;
    case 'extensions-apply':
      request = parseControlRequest({ op: 'extensions-live', request: { kind: 'apply', requestId: values.request, selectionId: values.operation, expectedRevision } });
      break;
    case 'extensions-retry':
      request = parseControlRequest({ op: 'extensions-live', request: { kind: 'retry', requestId: values.request, selectionId: values.operation, expectedRevision, afterAttemptId: values['after-attempt'] } });
      break;
    case 'extensions-status':
      if (values.operation !== undefined && values.attempt !== undefined) throw new Error('Use --operation or --attempt');
      request = parseControlRequest({ op: command, query: values.attempt !== undefined ? { kind: 'attempt', id: values.attempt }
        : values.operation !== undefined ? { kind: 'selection', id: values.operation } : null });
      break;
    default:
      request = parseControlRequest({ op: command, ...(values.id ? { id: values.id } : {}), ...(values.after ? { after: values.after } : {}) });
  }
  const response = await requestControl(join(directory, 'control.sock'), request).catch(error => {
    if (request.op === 'extensions-refresh-request' || request.op === 'extensions-refresh-status' || request.op === 'extensions-refresh-promote') {
      throw new Error('Refresh reply unavailable; use extensions-refresh-status --request ID or replay the identical extensions-refresh-request');
    }
    if (request.op === 'extensions-live') throw new Error('Selection reply unavailable; inspect --attempt or resend the identical --request');
    throw error;
  });
  if (!response.ok) throw new Error(response.error);
  if (command === 'extensions-status' && values.receipt) {
    const status = parseSelectionStatus(response.value);
    if (status.kind !== 'ready') throw new Error('Selection journal unavailable');
    const operation = parseOperationSummary(status.operation), chunks: Buffer[] = [];
    let offset = 0, total: number | undefined;
    do {
      const reply = await requestControl(join(directory, 'control.sock'), { op: 'extensions-receipt', digest: operation.receiptDigest, offset });
      if (!reply.ok) throw new Error(reply.error);
      const chunk = parseReceiptChunk(reply.value);
      if (chunk.digest !== operation.receiptDigest || chunk.offset !== offset || (total !== undefined && chunk.total !== total)) throw new Error('Selection receipt changed');
      chunks.push(Buffer.from(chunk.base64, 'base64')); offset = chunk.next; total = chunk.total;
    } while (offset < total);
    const bytes = Buffer.concat(chunks);
    if (createHash('sha256').update(bytes).digest('hex') !== operation.receiptDigest) throw new Error('Selection receipt digest mismatch');
    writeFileSync(values.receipt, bytes, { mode: 0o600 });
  }
  process.stdout.write(request.op === 'extensions-refresh-request' || request.op === 'extensions-refresh-status' || request.op === 'extensions-refresh-promote'
    ? `${JSON.stringify(response)}\n` : formatControlResponse(response));
}
void main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.message : 'Host operation failed'}\n`);
  process.exitCode = 1;
});
