import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import type { BrowserHostOptions } from './server.js';
import { startBrowserHost } from './server.js';
import { readAgentConfiguration } from './agent-config.js';
import { takeServerExtensionConfiguration } from './server-extension-config.js';
import { parseControlRequest, formatControlResponse, requestControl } from './control.js';
import { readObservabilityConfiguration } from './observability.js';

const COMMANDS: Readonly<Record<string, readonly string[]>> = { serve: ['port', 'assets', 'config', 'extensions', 'trusted'], 'browser-dev': ['port', 'assets', 'trusted'], codex: ['port', 'workspace', 'assets', 'executable', 'trusted'], 'codex-sdk': ['port', 'workspace', 'assets', 'executable', 'trusted'], 'claude-sdk': ['port', 'workspace', 'assets', 'model', 'executable', 'trusted'], pi: ['port', 'workspace', 'assets', 'trusted'], invite: [], 'invite-native': [], devices: ['after'], revoke: ['id'] };
async function main(): Promise<void> {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    'data-dir': { type: 'string' }, port: { type: 'string' }, id: { type: 'string' }, after: { type: 'string' },
    config: { type: 'string' }, extensions: { type: 'string' }, executable: { type: 'string' }, model: { type: 'string' }, workspace: { type: 'string' }, assets: { type: 'string' },
    trusted: { type: 'boolean' },
  } });
  if (!values['data-dir']) throw new Error('Provide --data-dir pointing to a private host directory');
  const [command, ...extra] = positionals;
  const allowed = command && Object.hasOwn(COMMANDS, command) ? COMMANDS[command] : undefined;
  if (extra.length || !command || !allowed) throw new Error('Use serve, codex, pi, browser-dev, invite, invite-native, devices, revoke, codex-sdk or claude-sdk');
  for (const flag of Object.keys(values)) {
    if (flag !== 'data-dir' && !allowed.includes(flag)) throw new Error(`--${flag} is not valid for ${command}`);
  }
  const directory = resolve(values['data-dir']);
  if (command === 'serve' || command === 'browser-dev' || command === 'codex' || command === 'codex-sdk' || command === 'claude-sdk' || command === 'pi') {
    if (command === 'serve' && !values.config) throw new Error('Provide --config pointing to an agent configuration file');
    const executable = values.executable ? { executable: resolve(values.executable) } : {};
    if (command === 'codex' && !values.workspace) throw new Error('Provide --workspace pointing to the directory Codex can work in');
    if (command === 'codex-sdk' && !values.workspace) throw new Error('Provide --workspace pointing to the directory for Codex SDK conversations');
    if (command === 'pi' && !values.workspace) throw new Error('Provide --workspace pointing to the directory for Pi conversations');
    let provider: BrowserHostOptions['provider'];
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
    const providerExtensions = values.extensions === undefined ? undefined : takeServerExtensionConfiguration(resolve(values.extensions), process.env);
    const host = await startBrowserHost({ directory, port, observability: readObservabilityConfiguration(process.env), assetsDirectory: values.assets ? resolve(values.assets) : fileURLToPath(new URL('../../desktop/web-dist-browser/', import.meta.url)),
      accessMode: values.trusted ? 'trusted' : 'paired',
      ...(providerExtensions === undefined ? {} : { providerExtensions }),
      ...(provider === undefined ? {} : { provider }), ...(values.config ? { configuration: readAgentConfiguration(resolve(values.config)) } : {}) });
    const close = () => { void host.close().catch(() => { process.exitCode = 1; }); };
    process.once('SIGINT', close);
    process.once('SIGTERM', close);
    process.stdout.write(`${JSON.stringify({ mode: command === 'browser-dev' ? 'browser-development' : command, origin: host.origin, hostId: host.hostId })}\n`);
    return;
  }
  const request = parseControlRequest({ op: command, ...(values.id ? { id: values.id } : {}), ...(values.after ? { after: values.after } : {}) });
  const response = await requestControl(join(directory, 'control.sock'), request);
  if (!response.ok) throw new Error(response.error);
  process.stdout.write(formatControlResponse(response));
}
void main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.message : 'Host operation failed'}\n`);
  process.exitCode = 1;
});
