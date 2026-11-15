import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { ConversationScope } from '@agentui/contracts';
import { canonicalJson } from '@agentui/contracts';
import { CODEX_RUNTIME } from '@agentui/contracts/compatibility';
import { transcriptProjection } from '@agentui/contracts/conversation';
import type { Transcript, TranscriptEvent } from '@agentui/contracts/conversation';
import { createCodexDriver, createProviderRegistry, openLocalHost } from '@agentui/host';
import type { LocalHost } from '@agentui/host';
import type { createPiDriver } from '@agentui/host/pi';
import type { createClaudeSdkDriver } from '@agentui/host/claude-sdk';
import type { createCodexSdkDriver } from '@agentui/host/codex-sdk';
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
import { recoverProviderConversations, PROVIDER_RECOVERY } from './provider-recovery.js';
import { providerInstallation } from './agent-config.js';
import type { AgentConfiguration, NativeProvider } from './agent-config.js';
import { describeAgent } from './agents.js';
import type { InstalledAgent } from './agents.js';
import type { ExtensionManifest, ServerExtensionEntry } from '@agentui/sdk';
import { createProviderAuthority } from './provider-credentials.js';
import type { ProviderInstallation } from './provider-credentials.js';

export interface BrowserHostOptions {
  readonly directory: string;
  readonly assetsDirectory: string;
  readonly port?: number;
  readonly progressMs?: number;
  readonly provider?: NativeProvider;
  readonly configuration?: AgentConfiguration;
  readonly providerExtensions?: readonly { readonly manifest: ExtensionManifest; readonly entry: ServerExtensionEntry;
    readonly installations: readonly ProviderInstallation[] }[];
  readonly accessMode?: 'paired' | 'trusted';
}
function piApiKey(): string {
  const apiKey = process.env.OPENCODE_GO_API_KEY;
  if (!apiKey?.trim()) {
    throw new Error('Set OPENCODE_GO_API_KEY in the host environment before starting Pi.');
  }
  return apiKey.trim();
}
function claudeApiKey(): string {
  const apiKey = process.env.AGENTUI_ANTHROPIC_API_KEY;
  if (!apiKey?.trim()) throw new Error('Set AGENTUI_ANTHROPIC_API_KEY in the host environment before starting Claude.');
  return apiKey.trim();
}
export async function startBrowserHost(options: BrowserHostOptions) {
  if (options.provider && options.configuration) throw new Error('Choose a single provider or an agent configuration');
  const configured = options.configuration ?? (options.provider
    ? { default: 'default', agents: [{ ...options.provider, name: 'default' }] } : null);
  if (options.provider?.kind === 'pi') piApiKey();
  if (options.provider?.kind === 'claude-sdk') claudeApiKey();
  const owner = ownDirectory(options.directory);
  let access: Access | undefined;
  let host: LocalHost<TranscriptEvent, Transcript> | undefined;
  type Driver = ReturnType<typeof createCodexDriver> | ReturnType<typeof createCodexSdkDriver> | ReturnType<typeof createClaudeSdkDriver> | Awaited<ReturnType<typeof createPiDriver>>;
  const drivers: Driver[] = [];
  const agents: InstalledAgent[] = [];
  let defaultInstallation = recordedInstallation;
  let feeds: FeedRegistry | undefined;
  let providers: ReturnType<typeof createProviderRegistry> | undefined;
  let control: Awaited<ReturnType<typeof startControl>> | undefined;
  let closePromise: Promise<void> | undefined;
  let closing = false;
  const http = createServer();
  function close(): Promise<void> {
    closePromise ??= (async () => {
      closing = true;
      feeds?.dispose();
      const driverResults = await Promise.allSettled([
        Promise.resolve().then(() => providers?.close()),
        ...drivers.map(driver => Promise.resolve().then(() => driver.close())),
      ]);
      const driverFailed = driverResults.some(result => result.status === 'rejected');
      const deadline = setTimeout(() => http.closeAllConnections(), 2000);
      try {
        const results = [...driverResults, ...await Promise.allSettled([
          new Promise<void>(done => { http.close(() => done()); http.closeIdleConnections(); }),
          Promise.resolve().then(() => control?.close()),
          Promise.resolve().then(() => {
            // Failed native cleanup can leave writers that still need the host database.
            if (driverFailed) return;
            host?.close();
            return host?.drained;
          }),
        ])];
        const failure = results.find(result => result.status === 'rejected');
        if (failure?.status === 'rejected') throw new Error('Host shutdown failed', { cause: failure.reason });
      } finally {
        clearTimeout(deadline);
      }
      access?.close();
      owner.close();
    })();
    return closePromise;
  }
  try {
    const browser = readArtifactBytes(options.assetsDirectory, 'browser-development');
    const artifact = readInstalledArtifact(dirname(fileURLToPath(import.meta.url)));
    const accessDatabase = openAccessDatabase(join(owner.directory, 'host.sqlite'));
    access = new Access(accessDatabase, options.accessMode);
    if (configured) {
      if (!configured.agents.some(agent => agent.name === configured.default)) throw new Error('Missing default agent');
      const append: Parameters<typeof createCodexDriver>[0]['append'] = (scope, output) => {
        if (!host) throw new Error('Host is not ready to store agent output');
        host.append(scope, output);
      };
      const currentRunId = (scope: ConversationScope): string | null => {
        if (!host) throw new Error('Host not ready');
        return host.inspect(scope).snapshot.document.domain.currentRun?.runId ?? null;
      };
      for (const provider of configured.agents) {
        if (!(await stat(provider.cwd).catch(() => null))?.isDirectory()) throw new Error(`Provide --workspace pointing to an existing directory for ${provider.kind}.`);
        const installation = providerInstallation(provider);
        if (agents.some(agent => canonicalJson(agent.installation) === canonicalJson(installation))) throw new Error('Duplicate agent installation');
        if (provider.name === configured.default) defaultInstallation = installation;
        let driver: Driver | undefined;
        try {
          switch (provider.kind) {
            case 'pi':
              driver = await (await import('@agentui/host/pi')).createPiDriver({ cwd: provider.cwd,
                sessionDirectory: join(owner.directory, 'pi-sessions'), apiKey: piApiKey(), append, currentRunId });
              break;
            case 'claude-sdk':
              driver = (await import('@agentui/host/claude-sdk')).createClaudeSdkDriver({ cwd: provider.cwd,
                sessionDirectory: join(owner.directory, 'claude-sessions', provider.model), apiKey: claudeApiKey(),
                model: provider.model, ...(provider.executable ? { claudePathOverride: provider.executable } : {}), append, currentRunId });
              break;
            case 'codex-sdk':
              driver = (await import('@agentui/host/codex-sdk')).createCodexSdkDriver({ cwd: provider.cwd,
                ...(provider.executable ? { codexPathOverride: provider.executable } : {}), append, currentRunId });
              break;
            case 'codex': {
              let version: string;
              try {
                const result = await promisify(execFile)(provider.executable ?? 'codex', ['--version'], { timeout: 5000, maxBuffer: 4096 });
                version = result.stdout.trim();
              } catch { throw new Error(`Codex CLI is unavailable. Install Codex ${CODEX_RUNTIME.version}, run codex login, and restart this host.`); }
              if (version !== `codex-cli ${CODEX_RUNTIME.version}`) throw new Error(`Unsupported Codex version ${version}. This app requires Codex ${CODEX_RUNTIME.version}. Install that version and restart this host.`);
              driver = createCodexDriver({ cwd: provider.cwd, version: CODEX_RUNTIME.version,
                ...(provider.executable ? { executable: provider.executable } : {}), append });
              break;
            }
          }
          drivers.push(driver);
          if ('ready' in driver) await driver.ready();
          agents.push({ installation, ...(options.configuration ? { name: provider.name } : {}), availability: { kind: 'ready' } });
        } catch (error) {
          if (!options.configuration) throw error;
          if (driver) { await driver.close(); drivers.splice(drivers.indexOf(driver), 1); }
          agents.push({ installation, ...(options.configuration ? { name: provider.name } : {}), availability: { kind: 'unavailable', reason: 'Agent unavailable. Check its installed runtime and host credentials, then restart the host.' } });
        }
      }
      const hostId = access.hostId;
      host = openLocalHost({ path: join(owner.directory, 'host.sqlite'), projection: transcriptProjection,
        driver: drivers, authorize: scope => scope.hostId === hostId });
    } else {
      host = openRecordedHost({ path: join(owner.directory, 'host.sqlite'), backendPath: join(owner.directory, 'recorded.jsonl'),
        hostId: access.hostId, ...(options.progressMs === undefined ? {} : { progressMs: options.progressMs }) });
    }
    providers = createProviderRegistry((options.providerExtensions ?? []).map(extension => ({
      manifest: extension.manifest, entry: extension.entry,
      authority: createProviderAuthority(accessDatabase, extension.manifest.namespace, extension.installations),
    })));
    await providers.activate();
    await providers.discover();
    const recovered = new Set<string>();
    let after: string | null = null;
    for (;;) {
      const page = host.listConversations(access.hostId, after, 100);
      for (const scope of page) {
        const installation = host.inspect(scope).installation, key = canonicalJson(installation);
        const engine = installation.binding.engine;
        if (!recovered.has(key) && (engine === 'codex' || engine === 'codex-sdk' || engine === 'claude-sdk' || engine === 'pi')) {
          recoverProviderConversations(host, access.hostId, installation, PROVIDER_RECOVERY[engine]);
          recovered.add(key);
        }
        after = scope.conversationId;
      }
      if (page.length < 100) break;
    }
    const registry = new FeedRegistry();
    feeds = registry;
    const compatibility = configured ? { ...artifact.compatibility, nativeRuntime: describeAgent(defaultInstallation, { kind: 'ready' }).runtime } : artifact.compatibility;
    const apiOptions: Omit<Parameters<typeof createApi>[0], 'credentialClass'> = {
      access, host, compatibility, feeds: registry, installation: defaultInstallation, ...(configured ? { agents } : {}),
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
    return { origin, hostId: access.hostId, close, discoverProviders: providers.discover };
  } catch (error) {
    await close();
    throw error;
  }
}
