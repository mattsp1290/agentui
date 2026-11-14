import { createConnection } from 'node:net';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { startBrowserHost } from './server.js';

const { values, positionals } = parseArgs({ allowPositionals: true, options: {
  'data-dir': { type: 'string' }, port: { type: 'string' }, id: { type: 'string' }, after: { type: 'string' },
} });
async function main(): Promise<void> {
  if (!values['data-dir']) throw new Error('Provide --data-dir pointing to a private host directory');
  const directory = resolve(values['data-dir']);
  const [command, ...extra] = positionals;
  if (extra.length) throw new Error('Unexpected positional arguments');
  if (command === 'browser-dev') {
    const port = values.port === undefined ? 7140 : Number(values.port);
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid listener port');
    if (values.id || values.after) throw new Error('Device id is only valid for revoke');
    const host = await startBrowserHost({ directory, port,
      assetsDirectory: fileURLToPath(new URL('../../desktop/web-dist/', import.meta.url)) });
    process.stdout.write(`${JSON.stringify({ mode: 'browser-development', origin: host.origin, hostId: host.hostId })}\n`);
    let closing = false;
    const close = () => {
      if (closing) return;
      closing = true;
      void host.close().catch(() => { process.exitCode = 1; });
    };
    process.once('SIGINT', close);
    process.once('SIGTERM', close);
    return;
  }
  if (!['invite', 'devices', 'revoke'].includes(command ?? '') || values.port || (command !== 'revoke' && values.id) || (command !== 'devices' && values.after)) {
    throw new Error('Use browser-dev, invite, devices or revoke');
  }
  if (command === 'revoke' && !values.id) throw new Error('Provide the device --id to revoke');
  const socket = createConnection(join(directory, 'control.sock'));
  socket.setTimeout(5000, () => socket.destroy(new Error('Host control request timed out')));
  await new Promise<void>((done, reject) => {
    let response = '';
    socket.once('error', reject);
    socket.once('connect', () => socket.write(`${JSON.stringify({ op: command, ...(values.id ? { id: values.id } : {}), ...(values.after ? { after: values.after } : {}) })}\n`));
    socket.on('data', chunk => {
      response += chunk.toString('utf8');
      if (Buffer.byteLength(response) > 16_000) socket.destroy(new Error('Host control response too large'));
    });
    socket.once('end', () => {
      try {
        const parsed: unknown = JSON.parse(response);
        if (!parsed || typeof parsed !== 'object' || !('ok' in parsed) || parsed.ok !== true) throw new Error('Host control operation refused');
        process.stdout.write(response);
        done();
      } catch (error) { reject(error); }
    });
  });
}
void main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.message : 'Host operation failed'}\n`);
  process.exitCode = 1;
});
