import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { startBrowserHost } from './server.js';
import { parseControlRequest, formatControlResponse, requestControl } from './control.js';

const COMMANDS: Readonly<Record<string, readonly string[]>> = { 'browser-dev': ['port'], codex: ['port', 'workspace'], 'codex-sdk': ['port', 'workspace'], pi: ['port', 'workspace'], invite: [], 'invite-native': [], devices: ['after'], revoke: ['id'] };
async function main(): Promise<void> {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    'data-dir': { type: 'string' }, port: { type: 'string' }, id: { type: 'string' }, after: { type: 'string' },
    workspace: { type: 'string' },
  } });
  if (!values['data-dir']) throw new Error('Provide --data-dir pointing to a private host directory');
  const [command, ...extra] = positionals;
  const allowed = command && Object.hasOwn(COMMANDS, command) ? COMMANDS[command] : undefined;
  if (extra.length || !command || !allowed) throw new Error('Use codex, pi, browser-dev, invite, invite-native, devices, revoke or codex-sdk');
  for (const flag of Object.keys(values)) {
    if (flag !== 'data-dir' && !allowed.includes(flag)) throw new Error(`--${flag} is not valid for ${command}`);
  }
  const directory = resolve(values['data-dir']);
  if (command === 'browser-dev' || command === 'codex' || command === 'codex-sdk' || command === 'pi') {
    if (command === 'codex' && !values.workspace) throw new Error('Provide --workspace pointing to the directory Codex can work in');
    if (command === 'codex-sdk' && !values.workspace) throw new Error('Provide --workspace pointing to the directory for Codex SDK conversations');
    if (command === 'pi' && !values.workspace) throw new Error('Provide --workspace pointing to the directory for Pi conversations');
    const port = values.port === undefined ? 7140 : Number(values.port);
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid listener port');
    const host = await startBrowserHost({ directory, port, assetsDirectory: fileURLToPath(new URL('../../desktop/web-dist-browser/', import.meta.url)),
      ...((command === 'codex' || command === 'codex-sdk' || command === 'pi') && values.workspace ? { provider: { kind: command, cwd: resolve(values.workspace) } } : {}) });
    process.stdout.write(`${JSON.stringify({ mode: command === 'browser-dev' ? 'browser-development' : command, origin: host.origin, hostId: host.hostId })}\n`);
    const close = () => { void host.close().catch(() => { process.exitCode = 1; }); };
    process.once('SIGINT', close);
    process.once('SIGTERM', close);
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
