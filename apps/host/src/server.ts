import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { CODEX_RUNTIME } from '@agentui/contracts/compatibility';
import { transcriptProjection } from '@agentui/contracts/conversation';
import type { Transcript, TranscriptEvent } from '@agentui/contracts/conversation';
import { createCodexDriver, openLocalHost } from '@agentui/host';
import type { LocalHost } from '@agentui/host';
import { openRecordedHost, recordedInstallation } from '@agentui/host/recorded';
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
  readonly provider?: { readonly kind: 'codex'; readonly cwd: string };
}
export async function startBrowserHost(options: BrowserHostOptions) {
  const owner = ownDirectory(options.directory);
  let access: Access | undefined;
  let host: LocalHost<TranscriptEvent, Transcript> | undefined;
  let codex: ReturnType<typeof createCodexDriver> | undefined;
  let feeds: FeedRegistry | undefined;
  let control: Awaited<ReturnType<typeof startControl>> | undefined;
  let closePromise: Promise<void> | undefined;
  let closing = false;
  const http = createServer();
  function close(): Promise<void> {
    closePromise ??= (async () => {
      closing = true;
      feeds?.dispose();
      codex?.close();
      host?.close();
      const deadline = setTimeout(() => http.closeAllConnections(), 2000);
      try {
        const results = await Promise.allSettled([
          new Promise<void>(done => { http.close(() => done()); http.closeIdleConnections(); }),
          control?.close(), host?.drained,
        ]);
        const failure = results.find(result => result.status === 'rejected');
        if (failure?.status === 'rejected') throw failure.reason;
      } finally { clearTimeout(deadline); }
      access?.close();
      owner.close();
    })();
    return closePromise;
  }
  try {
    const browser = readArtifactBytes(options.assetsDirectory, 'browser-development');
    const artifact = readInstalledArtifact(dirname(fileURLToPath(import.meta.url)));
    if (options.provider) {
      if (!(await stat(options.provider.cwd).catch(() => null))?.isDirectory()) {
        throw new Error('Provide --workspace pointing to an existing directory for Codex.');
      }
      let version: string;
      try {
        const result = await promisify(execFile)('codex', ['--version'], { timeout: 5000, maxBuffer: 4096 });
        version = result.stdout.trim();
      } catch {
        throw new Error(`Codex CLI is unavailable. Install Codex ${CODEX_RUNTIME.version}, run codex login, and restart this host.`);
      }
      if (version !== `codex-cli ${CODEX_RUNTIME.version}`) {
        throw new Error(`Unsupported Codex version ${version}. This app requires Codex ${CODEX_RUNTIME.version}. Install that version and restart this host.`);
      }
    }
    access = new Access(openAccessDatabase(join(owner.directory, 'host.sqlite')));
    if (options.provider) {
      codex = createCodexDriver({ cwd: options.provider.cwd, version: CODEX_RUNTIME.version,
        append(scope, output) {
          if (!host) throw new Error('Host is not ready to store Codex output');
          host.append(scope, output);
        } });
      const hostId = access.hostId;
      host = openLocalHost({ path: join(owner.directory, 'host.sqlite'), projection: transcriptProjection,
        driver: codex, authorize: scope => scope.hostId === hostId });
    } else {
      host = openRecordedHost({ path: join(owner.directory, 'host.sqlite'), backendPath: join(owner.directory, 'recorded.jsonl'),
        hostId: access.hostId, ...(options.progressMs === undefined ? {} : { progressMs: options.progressMs }) });
    }
    const registry = new FeedRegistry();
    feeds = registry;
    const compatibility = codex ? { ...artifact.compatibility, nativeRuntime: CODEX_RUNTIME } : artifact.compatibility;
    const api = createApi({ access, host, compatibility, feeds: registry, installation: codex?.installation ?? recordedInstallation,
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
    control = await startControl(join(owner.directory, 'control.sock'), access, registry, () => closing);
    return { origin, hostId: access.hostId, close };
  } catch (error) {
    await close();
    throw error;
  }
}
