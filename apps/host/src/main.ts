import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { startBrowserHost } from './server.js';
import { parseControlRequest, formatControlResponse, requestControl } from './control.js';

const COMMANDS: Readonly<Record<string, readonly string[]>> = { 'browser-dev': ['port'], invite: [], devices: ['after'], revoke: ['id'] };
async function main(): Promise<void> {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    'data-dir': { type: 'string' }, port: { type: 'string' }, id: { type: 'string' }, after: { type: 'string' },
  } });
  if (!values['data-dir']) throw new Error('Provide --data-dir pointing to a private host directory');
  const [command, ...extra] = positionals;
  if (extra.length || !command || !Object.hasOwn(COMMANDS, command)) throw new Error('Use browser-dev, invite, devices or revoke');
  const allowed = COMMANDS[command];
  if (!allowed) throw new Error('Unknown command');
  for (const flag of Object.keys(values)) {
    if (flag !== 'data-dir' && !allowed.includes(flag)) throw new Error(`--${flag} is not valid for ${command}`);
  }
  const directory = resolve(values['data-dir']);
  if (command === 'browser-dev') {
    const port = values.port === undefined ? 7140 : Number(values.port);
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid listener port');
    const host = await startBrowserHost({ directory, port, assetsDirectory: fileURLToPath(new URL('../../desktop/web-dist-browser/', import.meta.url)) });
    process.stdout.write(`${JSON.stringify({ mode: 'browser-development', origin: host.origin, hostId: host.hostId })}\n`);
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
