import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openRecordedHost } from '@agentui/host/recorded';
import { Access } from './access.js';
import { openAccessDatabase } from './access-database.js';
import { ownDirectory } from './ownership.js';
import { readArtifactBytes, readInstalledArtifact } from './artifact.js';
import { createApi } from './api.js';
import { FeedRegistry } from './feed-registry.js';
import { browserHandler } from './http-handler.js';
import { startControl } from './control.js';

export interface BrowserHostOptions {
  readonly directory: string;
  readonly assetsDirectory: string;
  readonly port?: number;
  readonly progressMs?: number;
}
export async function startBrowserHost(options: BrowserHostOptions) {
  const owner = ownDirectory(options.directory);
  let access: Access | undefined;
  let host: ReturnType<typeof openRecordedHost> | undefined;
  let feeds: FeedRegistry | undefined;
  let closing = false;
  const http = createServer();
  try {
    const browser = readArtifactBytes(options.assetsDirectory, 'browser-development');
    const artifact = readInstalledArtifact(dirname(fileURLToPath(import.meta.url)));
    access = new Access(openAccessDatabase(join(owner.directory, 'host.sqlite')));
    const activeAccess = access;
    host = openRecordedHost({ path: join(owner.directory, 'host.sqlite'), backendPath: join(owner.directory, 'recorded.jsonl'),
      hostId: access.hostId, ...(options.progressMs === undefined ? {} : { progressMs: options.progressMs }) });
    const activeHost = host;
    const registry = new FeedRegistry();
    feeds = registry;
    const api = createApi({ access, host, compatibility: artifact.compatibility, feeds: registry,
      credentialClass: 'browser-development', isClosing: () => closing });
    const handler = browserHandler({ access, api, files: browser.files, isClosing: () => closing });
    http.on('request', (request, response) => { void handler(request, response).catch(() => response.destroy()); });
    http.requestTimeout = 20_000;
    http.headersTimeout = 10_000;
    http.keepAliveTimeout = 5000;
    http.maxConnections = 128;
    await new Promise<void>((resolve, reject) => {
      http.once('error', reject);
      http.listen(options.port ?? 7140, '127.0.0.1', () => { http.off('error', reject); resolve(); });
    });
    const address = http.address();
    if (!address || typeof address === 'string') throw new Error('Invalid host address');
    const origin = `http://127.0.0.1:${address.port}`;
    const control = await startControl(join(owner.directory, 'control.sock'), access, registry, () => closing);
    return { origin, hostId: access.hostId,
      async close() {
        if (closing) return;
        closing = true;
        registry.dispose();
        activeHost.close();
        const deadline = setTimeout(() => http.closeAllConnections(), 2000);
        try {
          await Promise.all([new Promise<void>(done => { http.close(() => done()); http.closeIdleConnections(); }), control.close(), activeHost.drained]);
        } finally { clearTimeout(deadline); }
        activeAccess.close(); owner.close();
      },
    };
  } catch (error) {
    feeds?.dispose(); http.closeAllConnections(); http.close();
    host?.close(); if (host) await host.drained;
    access?.close(); owner.close(); throw error;
  }
}
