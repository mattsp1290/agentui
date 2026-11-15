import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { CODEX_RUNTIME, PI_RUNTIME } from '@agentui/contracts/compatibility';
import { transcriptProjection } from '@agentui/contracts/conversation';
import type { Transcript, TranscriptEvent } from '@agentui/contracts/conversation';
import { createCodexDriver, createPiDriver, openLocalHost } from '@agentui/host';
import type { LocalHost } from '@agentui/host';
import { openRecordedHost, recordedInstallation } from '@agentui/host/recorded';
import { Access } from './access.js';
import type { CredentialClass } from './access.js';
import { openAccessDatabase } from './access-database.js';
import { ownDirectory } from './ownership.js';
import { readArtifactBytes, readInstalledArtifact } from './artifact.js';
import { createApi } from './api.js';
import { FeedRegistry } from './feed-registry.js';
import { serviceEndpoint } from './service-endpoint.js';
import { startControl } from './control.js';
import { recoverCodexConversations } from './codex-recovery.js';

export interface BrowserHostOptions {
  readonly directory: string;
  readonly assetsDirectory: string;
  readonly port?: number;
  readonly progressMs?: number;
  readonly provider?:
    | { readonly kind: 'codex'; readonly cwd: string }
    | { readonly kind: 'pi'; readonly cwd: string };
}
function piApiKey(): string {
  const apiKey = process.env.OPENCODE_GO_API_KEY;
  if (!apiKey?.trim()) {
    throw new Error('Set OPENCODE_GO_API_KEY in the host environment before starting Pi.');
  }
  return apiKey;
}
export async function startBrowserHost(options: BrowserHostOptions) {
  const provider = options.provider?.kind === 'pi' ? { ...options.provider, apiKey: piApiKey() } : options.provider;
  const owner = ownDirectory(options.directory);
  let access: Access | undefined;
  let host: LocalHost<TranscriptEvent, Transcript> | undefined;
  let driver: ReturnType<typeof createCodexDriver> | Awaited<ReturnType<typeof createPiDriver>> | undefined;
  let feeds: FeedRegistry | undefined;
  let control: Awaited<ReturnType<typeof startControl>> | undefined;
  let closePromise: Promise<void> | undefined;
  let closing = false;
  const http = createServer();
  function close(): Promise<void> {
    closePromise ??= (async () => {
      closing = true;
      feeds?.dispose();
      const driverResults = await Promise.allSettled([Promise.resolve().then(() => driver?.close())]);
      host?.close();
      const deadline = setTimeout(() => http.closeAllConnections(), 2000);
      try {
        const results = [...driverResults, ...await Promise.allSettled([
          new Promise<void>(done => { http.close(() => done()); http.closeIdleConnections(); }),
          control?.close(), host?.drained,
        ])];
        const failure = results.find(result => result.status === 'rejected');
        if (failure?.status === 'rejected') throw failure.reason;
      } finally {
        clearTimeout(deadline);
        access?.close();
        owner.close();
      }
    })();
    return closePromise;
  }
  try {
    const browser = readArtifactBytes(options.assetsDirectory, 'browser-development');
    const artifact = readInstalledArtifact(dirname(fileURLToPath(import.meta.url)));
    if (provider) {
      if (!(await stat(provider.cwd).catch(() => null))?.isDirectory()) {
        throw new Error(`Provide --workspace pointing to an existing directory for ${provider.kind === 'codex' ? 'Codex' : 'Pi'}.`);
      }
    }
    if (provider?.kind === 'codex') {
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
    if (provider) {
      const append: Parameters<typeof createCodexDriver>[0]['append'] = (scope, output) => {
        if (!host) throw new Error('Host is not ready to store agent output');
        host.append(scope, output);
      };
      driver = provider.kind === 'pi'
        ? await createPiDriver({ cwd: provider.cwd, sessionDirectory: join(owner.directory, 'pi-sessions'), apiKey: provider.apiKey, append })
        : createCodexDriver({ cwd: provider.cwd, version: CODEX_RUNTIME.version, append });
      const hostId = access.hostId;
      host = openLocalHost({ path: join(owner.directory, 'host.sqlite'), projection: transcriptProjection,
        driver, authorize: scope => scope.hostId === hostId });
      recoverCodexConversations(host, hostId, driver.installation, provider.kind === 'codex' ? 'Codex' : 'Pi');
    } else {
      host = openRecordedHost({ path: join(owner.directory, 'host.sqlite'), backendPath: join(owner.directory, 'recorded.jsonl'),
        hostId: access.hostId, ...(options.progressMs === undefined ? {} : { progressMs: options.progressMs }) });
    }
    const registry = new FeedRegistry();
    feeds = registry;
    const compatibility = provider ? { ...artifact.compatibility,
      nativeRuntime: provider.kind === 'codex' ? CODEX_RUNTIME : PI_RUNTIME } : artifact.compatibility;
    const apiOptions: Omit<Parameters<typeof createApi>[0], 'credentialClass'> = {
      access, host, compatibility, feeds: registry, installation: driver?.installation ?? recordedInstallation,
      isClosing: () => closing,
    };
    const apiFor = (credentialClass: CredentialClass) => createApi({ ...apiOptions, credentialClass });
    const handler = serviceEndpoint({ credentialClass: 'browser-development', access, api: apiFor('browser-development'),
      files: browser.files, isClosing: apiOptions.isClosing });
    const native = serviceEndpoint({ credentialClass: 'native', access, api: apiFor('native'), isClosing: apiOptions.isClosing });
    http.on('request', (request, response) => {
      const route = request.url?.startsWith('/native/') ? native : handler;
      void route(request, response).catch(() => response.destroy());
    });
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
