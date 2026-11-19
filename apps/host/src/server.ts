import { createServer } from 'node:http';
import { createPiSetup, piSetupEndpoint } from './pi-setup.js';
import type { PiSetup } from './pi-setup.js';
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
import { createCodexDriver, openLocalHost } from '@agentui/host';
import type { CodexModelDriver, LocalHost, ProviderDriver } from '@agentui/host';
import type { createPiDriver } from '@agentui/host/pi';
import type { createClaudeSdkDriver } from '@agentui/host/claude-sdk';
import type { createCodexSdkDriver } from '@agentui/host/codex-sdk';
import { openRecordedHost, recordedInstallation } from '@agentui/host/recorded';
import { openAccessDatabase } from './access-database.js';
import type { AccessDatabase } from './access-database.js';
import { ownDirectory } from './ownership.js';
import { readArtifactBytes, readInstalledArtifact } from './artifact.js';
import { createApi } from './api.js';
import { FeedRegistry } from './feed-registry.js';
import { serviceEndpoint } from './service-endpoint.js';
import { startControl, unavailableSelectionControl } from './control.js';
import { recoverProviderConversations, PROVIDER_RECOVERY } from './provider-recovery.js';
import { providerInstallation } from './agent-config.js';
import type { AgentConfiguration, NativeProvider } from './agent-config.js';
import { describeAgent } from './agents.js';
import type { InstalledAgent } from './agents.js';
import { createHostObservability } from './observability.js';
import type { ObservabilityConfiguration } from './observability.js';
import { directCodexEnvironment } from './native-environment.js';
import { assertNoSelectionJournal } from './server-selection.js';
import { createInstalledRefreshBuilder } from './installed-refresh-builder.js';
import { serverArtifactExpectation } from './server-artifact-runtime.js';
import { createRefreshController } from './refresh-jobs.js';
import type { RefreshBuilder, RefreshController } from './refresh-jobs.js';
import type { ExtensionStartup } from './server-selection.js';
import { createServerExtensions } from '@agentui/host/extensions';
import type { ServerExtensionReplacement } from '@agentui/host/extensions';
import type { SelectionControl } from './selection-protocol.js';
import { providerExtensionSource } from './provider-extensions.js';
import type { BrowserProviderExtension, ProviderExtensionSelection } from './provider-extensions.js';
export type { BrowserProviderExtension } from './provider-extensions.js';

export interface BrowserHostOptions {
  readonly directory: string;
  readonly assetsDirectory: string;
  readonly hostArtifactDirectory?: string;
  readonly port?: number;
  readonly progressMs?: number;
  readonly agentStartup: HostAgentStartup;
  readonly observability?: ObservabilityConfiguration;
  readonly extensions?: ExtensionStartup;
  readonly refreshBuilder?: string;
  readonly setupCapability?: string;
  /** Test-only override of the 15-second extension operation deadline. */
  readonly operationDeadlineMs?: number;
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
export type HostAgentStartup =
  | { readonly kind: 'recorded' }
  | { readonly kind: 'provider'; readonly provider: NativeProvider }
  | { readonly kind: 'configured'; readonly configuration: AgentConfiguration }
  | { readonly kind: 'desktop'; readonly configuration: AgentConfiguration }
  | { readonly kind: 'extensions' };
export async function startBrowserHost(options: BrowserHostOptions) {
  const startup = options.agentStartup;
  const configured = startup.kind === 'configured' || startup.kind === 'desktop' ? startup.configuration : startup.kind === 'provider'
    ? { default: 'default', agents: [{ ...startup.provider, name: 'default' }] } : null;
  if (startup.kind === 'provider' && startup.provider.kind === 'pi') piApiKey();
  if (startup.kind === 'provider' && startup.provider.kind === 'claude-sdk') claudeApiKey();
  if (startup.kind === 'desktop' && !/^[a-f0-9]{64}$/.test(options.setupCapability ?? '')) throw new Error('Launch desktop setup through ./agentui.');
  const observability = createHostObservability(options.observability ?? { kind: 'disabled' });
  let owner: ReturnType<typeof ownDirectory>;
  try { owner = ownDirectory(options.directory); }
  catch (error) { await observability.close(); throw error; }
  let database: AccessDatabase;
  try { database = openAccessDatabase(join(owner.directory, 'host.sqlite')); }
  catch (error) { owner.close(); await observability.close(); throw error; }
  let host: LocalHost<TranscriptEvent, Transcript> | undefined;
  type Driver = ReturnType<typeof createCodexDriver> | ReturnType<typeof createCodexSdkDriver> | ReturnType<typeof createClaudeSdkDriver> | Awaited<ReturnType<typeof createPiDriver>>;
  const drivers: Driver[] = [];
  let piSetup: PiSetup | undefined;
  const modelDrivers: ProviderDriver<TranscriptEvent>[] = [];
  const agents: InstalledAgent[] = [];
  let defaultInstallation = recordedInstallation;
  let feeds: FeedRegistry | undefined;
  const providers = createServerExtensions(options.operationDeadlineMs === undefined ? {} : { operationDeadlineMs: options.operationDeadlineMs });
  let control: Awaited<ReturnType<typeof startControl>> | undefined;
  let refresh: RefreshController | undefined;
  let resolveFatal!: () => void;
  const fatal = new Promise<void>(resolve => { resolveFatal = resolve; });
  let closePromise: Promise<void> | undefined;
  let closing = false;
  const http = createServer();
  function close(): Promise<void> {
    if (closePromise) return closePromise;
    closePromise = Promise.resolve().then(() => shutdown);
    const shutdown = (async () => {
      closing = true;
      feeds?.dispose();
      const drainResults = await Promise.allSettled([
        refresh?.close(),
        providers.close(),
        ...drivers.map(driver => Promise.resolve().then(() => driver.close())),
      ]);
      const drainFailed = drainResults.some(result => result.status === 'rejected');
      const deadline = setTimeout(() => http.closeAllConnections(), 2000);
      try {
        const results = [...drainResults, ...await Promise.allSettled([
          new Promise<void>(done => { http.close(() => done()); http.closeIdleConnections(); }),
          Promise.resolve().then(() => control?.close()),
          Promise.resolve().then(() => {
            if (drainFailed) return;
            host?.close();
            return host?.drained;
          }),
        ])];
        const failure = results.find(result => result.status === 'rejected');
        if (failure?.status === 'rejected') throw new Error('Host shutdown failed', { cause: failure.reason });
      } finally {
        clearTimeout(deadline);
      }
      database.database.close();
      owner.close();
    })().finally(() => observability.close());
    return closePromise;
  }
  try {
    const browser = readArtifactBytes(options.assetsDirectory, 'browser-development');
    const artifact = readInstalledArtifact(options.hostArtifactDirectory ?? dirname(fileURLToPath(import.meta.url)));
    async function replaceExtensions(readyHost: LocalHost<TranscriptEvent, Transcript>, selected: ProviderExtensionSelection) {
      const replacement = await providers.replace(providerExtensionSource(database, selected));
      if (replacement.kind !== 'replaced' || replacement.generation === null) return replacement;
      const generation = replacement.generation;
      const current = () => { const status = providers.status(); return !closing && status.kind === 'active' && status.generation === generation; };
      let after: string | null = null;
      while (current()) {
        const page = readyHost.listConversations(database.hostId, after, 100);
        for (const scope of page) {
          if (!current()) return replacement;
          if ('kind' in readyHost.inspect(scope).installation) await readyHost.observeProvider(scope);
          if (!current()) return replacement;
          after = scope.conversationId;
        }
        if (page.length < 100) break;
      }
      return replacement;
    }
    const extensions = options.extensions ?? { kind: 'transient', entries: [] };
    if (options.refreshBuilder !== undefined && extensions.kind !== 'durable-artifacts') throw new Error('Refresh builder requires durable extensions');
    let boot: (readyHost: LocalHost<TranscriptEvent, Transcript>) => Promise<void>;
    let directReplace: (readyHost: LocalHost<TranscriptEvent, Transcript>, entries: readonly BrowserProviderExtension[]) => Promise<ServerExtensionReplacement>;
    let selectionControl: SelectionControl;
    switch (extensions.kind) {
      case 'durable-artifacts': {
        let builder: RefreshBuilder = { kind: 'unavailable' };
        if (options.refreshBuilder !== undefined) {
          const { artifactId: _artifactId, ...expected } = serverArtifactExpectation('');
          builder = await createInstalledRefreshBuilder({ entry: options.refreshBuilder, expected });
        }
        const composed = await createRefreshController({ database, artifactRoot: join(owner.directory, 'refresh-artifacts'),
          builder, selection: { entries: extensions.entries,
          runtime: providers.status, isClosing: () => closing,
          replace: selected => {
            if (!host) throw new Error('Selection host unavailable');
            return replaceExtensions(host, selected);
          },
          stopRuntime: () => { void close().catch(() => {}); resolveFatal(); } } });
        refresh = composed;
        const durable = composed.selection;
        boot = () => durable.activate();
        directReplace = async () => { throw new Error('Durable extensions require selection commands'); };
        selectionControl = durable;
        break;
      }
      case 'transient':
        assertNoSelectionJournal(database);
        boot = async readyHost => {
          const replacement = await replaceExtensions(readyHost, { kind: 'entries', entries: extensions.entries });
          if (replacement.kind === 'failed') {
            const messages = { load: 'Server extension loading failed', authorization: 'Provider authorization refused',
              activation: 'Provider activation failed', cleanup: 'Provider cleanup failed' };
            throw new Error(messages[replacement.failure]);
          }
          if (replacement.kind !== 'replaced') throw new Error('Provider activation unavailable');
        };
        directReplace = (readyHost, entries) => replaceExtensions(readyHost, { kind: 'entries', entries });
        selectionControl = unavailableSelectionControl;
        break;
    }
    if (configured) {
      if (!configured.agents.some(agent => agent.name === configured.default)) throw new Error('Missing default agent');
      const appendFor = (source: NativeProvider['kind']): Parameters<typeof createCodexDriver>[0]['append'] => (scope, output) => {
        if (!host) throw new Error('Host is not ready to store agent output');
        host.append(scope, output);
        observability.recordOutput(source, scope, output.events);
      };
      const currentRunId = (scope: ConversationScope): string | null => {
        if (!host) throw new Error('Host not ready');
        return host.inspect(scope).snapshot.document.domain.currentRun?.runId ?? null;
      };
      const readImage: NonNullable<Parameters<typeof createCodexDriver>[0]['readImage']> = (scope, imageId) => {
        if (!host) throw new Error('Host not ready');
        return host.readImage(scope, imageId);
      };
      for (const provider of configured.agents) {
        const append = appendFor(provider.kind);
        if (!(await stat(provider.cwd).catch(() => null))?.isDirectory()) throw new Error(`Provide --workspace pointing to an existing directory for ${provider.kind}.`);
        const installation = providerInstallation(provider);
        if (agents.some(agent => canonicalJson(agent.installation) === canonicalJson(installation))) throw new Error('Duplicate agent installation');
        if (provider.name === configured.default) defaultInstallation = installation;
        let driver: Driver | undefined;
        let discovered: readonly CodexModelDriver[] = [];
        try {
          switch (provider.kind) {
            case 'pi':
              if (startup.kind === 'desktop') {
                const setup = createPiSetup({ cwd: provider.cwd, sessionDirectory: join(owner.directory, 'pi-sessions'), append, currentRunId }, () => closing);
                piSetup = setup;
                driver = setup.driver;
                if (process.env.OPENCODE_GO_API_KEY?.trim()) await setup.configure(process.env.OPENCODE_GO_API_KEY, 'environment').catch(() => {});
                break;
              }
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
              const env = directCodexEnvironment();
              let version: string;
              try {
                const result = await promisify(execFile)(provider.executable ?? 'codex', ['--version'], { timeout: 5000, maxBuffer: 4096, env });
                version = result.stdout.trim();
              } catch { throw new Error(`Codex CLI is unavailable. Install Codex ${CODEX_RUNTIME.version}, run codex login, and restart this host.`); }
              if (version !== `codex-cli ${CODEX_RUNTIME.version}`) throw new Error(`Unsupported Codex version ${version}. This app requires Codex ${CODEX_RUNTIME.version}. Install that version and restart this host.`);
              if (startup.kind === 'desktop') await promisify(execFile)(provider.executable ?? 'codex', ['login', 'status'], { timeout: 5000, maxBuffer: 4096, env });
              const codex = createCodexDriver({ cwd: provider.cwd, version: CODEX_RUNTIME.version,
                ...(provider.executable ? { executable: provider.executable } : {}), env, append, readImage });
              driver = codex;
              break;
            }
          }
          drivers.push(driver);
          if ('ready' in driver) await driver.ready();
          if ('models' in driver) {
            discovered = await driver.models();
            const selected = discovered.find(entry => entry.selectable && entry.isDefault) ?? discovered.find(entry => entry.selectable);
            if (!selected) throw new Error('Codex did not offer any available models.');
            if (provider.name === configured.default) defaultInstallation = selected.driver.installation;
          }
          agents.push({ installation, ...('models' in driver ? { selectable: false } : {}), ...(startup.kind === 'configured' ? { name: provider.name } : {}), get availability(): InstalledAgent['availability'] { return provider.kind === 'pi' && piSetup ? piSetup.availability() : { kind: 'ready' }; } },
            ...discovered.map((entry): InstalledAgent => ({ installation: entry.driver.installation, model: entry.model, selectable: entry.selectable,
              ...(startup.kind === 'configured' ? { name: provider.name } : {}), availability: { kind: 'ready' } })));
          modelDrivers.push(...discovered.map(entry => entry.driver));
        } catch (error) {
          if (startup.kind !== 'configured' && startup.kind !== 'desktop') throw error;
          if (driver) { await driver.close(); const index = drivers.indexOf(driver); if (index !== -1) drivers.splice(index, 1); }
          agents.push({ installation, ...(startup.kind === 'configured' ? { name: provider.name } : {}), availability: { kind: 'unavailable', reason: provider.kind === 'codex' ? `Codex is unavailable. Run codex login on this host, then restart AgentUI. This app requires Codex ${CODEX_RUNTIME.version}.` : 'Agent unavailable. Check its installed runtime and host credentials, then restart the host.' } });
        }
      }
    }
    const hostId = database.hostId;
    const readyHost = startup.kind === 'recorded'
      ? openRecordedHost({ path: join(owner.directory, 'host.sqlite'), backendPath: join(owner.directory, 'recorded.jsonl'),
        hostId, providers, ...(options.progressMs === undefined ? {} : { progressMs: options.progressMs }) })
      : openLocalHost({ path: join(owner.directory, 'host.sqlite'), projection: transcriptProjection,
        driver: [...drivers, ...modelDrivers], providers, authorize: scope => scope.hostId === hostId });
    host = readyHost;
    await boot(readyHost);
    const recovered = new Set<string>();
    let after: string | null = null;
    for (;;) {
      const page = host.listConversations(hostId, after, 100);
      for (const scope of page) {
        const installation = host.inspect(scope).installation, key = canonicalJson(installation);
        if ('kind' in installation) { after = scope.conversationId; continue; }
        const engine = installation.binding.engine;
        if (!recovered.has(key) && (engine === 'codex' || engine === 'codex-sdk' || engine === 'claude-sdk' || engine === 'pi')) {
          recoverProviderConversations(host, hostId, installation, PROVIDER_RECOVERY[engine]);
          recovered.add(key);
        }
        after = scope.conversationId;
      }
      if (page.length < 100) break;
    }
    const registry = new FeedRegistry();
    feeds = registry;
    const nativeRuntime = startup.kind === 'extensions' ? null : configured
      ? describeAgent(defaultInstallation, { kind: 'ready' }, host.imageInput(defaultInstallation)).runtime : artifact.compatibility.nativeRuntime;
    const compatibility = { ...artifact.compatibility, nativeRuntime };
    const agentSelection: Parameters<typeof createApi>[0]['agentSelection'] = startup.kind === 'extensions'
      ? { kind: 'extensions' }
      : { kind: 'native', defaultInstallation, agents: configured ? agents : [{ installation: recordedInstallation, availability: { kind: 'ready' } }] };
    const isClosing = () => closing;
    const api = createApi({ host, compatibility, feeds: registry, providers, agentSelection, isClosing,
      extensions: { describe: providers.extensions, call: providers.callOperation } });
    const handler = serviceEndpoint({ client: 'browser-development', hostId, api, files: browser.files, isClosing, observability });
    const native = serviceEndpoint({ client: 'native', hostId, api, isClosing, observability });
    const setupHandler = piSetup && options.setupCapability ? piSetupEndpoint(piSetup, options.setupCapability, () => closing) : null;
    http.on('request', (request, response) => {
      if (request.url === '/setup/pi' && setupHandler) {
        void setupHandler(request, response).catch(() => response.destroy());
        return;
      }
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
    control = await startControl(join(owner.directory, 'control.sock'), isClosing, selectionControl, providers.discover, refresh);
    return { origin, hostId, close, fatal, discoverProviders: providers.discover,
      extensionStatus: providers.status, callOperation: providers.callOperation,
      async replaceProviderExtensions(selected: readonly BrowserProviderExtension[]) {
        return directReplace(readyHost, selected);
      },
    };
  } catch (error) {
    await close();
    throw error;
  }
}
