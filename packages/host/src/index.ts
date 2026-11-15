export { createEventStream, parseInteractionContinuation, parseSessionReference } from '@mattsp1290/switchboard';
export type {
  AdapterInstance, AdapterRegistration, Capability, EventObserver, EventStream,
  InteractionContinuation, PendingInteraction, SessionBinding, SessionReference,
} from '@mattsp1290/switchboard';
export type { ProviderBinding, RunAuthority, RunIdentity } from '@agentui/contracts';

export const hostRuntime = 'node';
export { secretResolver } from './secret-provider.js';
export { createProviderRegistry, providerIdentity } from './providers.js';
export type { ProviderConversationOperations, ProviderCreationOperations, ProviderAuthority, ProviderAuthorization, ProviderIdentity, ProviderExtension, DiscoveredProvider } from './providers.js';
export { openLocalHost } from './local-host.js';
export type { LocalHost, LocalHostOptions } from './local-host.js';
export { createRecordedDriver } from './recorded-driver.js';
export type { RecordedDriverOptions } from './recorded-driver.js';
export type { Installation, NativeRun, NativeDecision, HostOutput, CommandResult, NotDispatched, ProviderDispatchObservation, CapturedTarget, ProviderDriver, HostBudgets } from './durable-model.js';

export { createCodexDriver } from './codex-driver.js';
export type { CodexDriverOptions, CodexTranscriptEvent } from './codex-driver.js';
export { CapacityError as HostCapacityError } from './sqlite-store.js';

export { codexInstallation, codexSdkInstallation, claudeSdkInstallation, piInstallation } from './native-installations.js';

export type { ConversationInstallation, ProviderInstallation, ProviderCreation, StoredCreation, CreationObservation } from './provider-creation.js';
export { providerInstallationKey } from './provider-creation.js';
