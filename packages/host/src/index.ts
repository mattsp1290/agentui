export { createEventStream, parseInteractionContinuation, parseSessionReference } from '@mattsp1290/switchboard';
export type {
  AdapterInstance, AdapterRegistration, Capability, EventObserver, EventStream,
  InteractionContinuation, PendingInteraction, SessionBinding, SessionReference,
} from '@mattsp1290/switchboard';
export type { ProviderBinding, RunAuthority, RunIdentity } from '@agentui/contracts';

export const hostRuntime = 'node';
export { openLocalHost } from './local-host.js';
export type { LocalHost, LocalHostOptions } from './local-host.js';
export { createRecordedDriver } from './recorded-driver.js';
export type { RecordedDriverOptions } from './recorded-driver.js';
export type { Installation, NativeRun, NativeDecision, HostOutput, CommandResult, CapturedTarget, ProviderDriver, HostBudgets } from './durable-model.js';

export { createCodexDriver } from './codex-driver.js';
export type { CodexDriverOptions, CodexTranscriptEvent } from './codex-driver.js';
export { CapacityError as HostCapacityError } from './sqlite-store.js';

export { codexInstallation, codexSdkInstallation, claudeSdkInstallation, piInstallation } from './native-installations.js';
