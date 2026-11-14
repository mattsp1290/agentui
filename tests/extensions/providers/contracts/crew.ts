import * as SDK from '@agentui/sdk';

export type CrewModel = {
  request: { member: string; text: string };
  cursor: { checkpoint: string; stream: number };
  state: { messages: readonly string[] };
  event: { kind: 'message'; text: string };
};
export const crewInstance: SDK.ProviderInstance<'crew-personal'> = {
  namespace: 'example.crew', installationId: 'crew-personal', generation: '1', protocolVersion: 'crew-v2',
};
export function createCrewFixture<I extends string>(crewInstance: SDK.ProviderInstance<I>): {
  crewCredential: SDK.CredentialHandle<I>;
  crewAgent: SDK.ProviderRef<I, 'agent'>;
  crewCreation: SDK.CreationIntent<I>;
  crewBinding: SDK.ProviderConversation<I>;
  crewRun: SDK.ConversationRef<I, 'run'>;
  crewDecision: SDK.ConversationRef<I, 'decision'>;
  crewChoice: SDK.ConversationRef<I, 'choice'>;
  crewCursor: SDK.ProviderCursor<CrewModel, I>;
  crewSend: SDK.ProviderCommand<CrewModel, I>;
  crewBackend: SDK.ConnectedProvider<CrewModel, I>;
  crew: SDK.BackendProvider<CrewModel, I>;
} {
  const crewCredential: SDK.CredentialHandle<I> = {
    kind: 'credential-handle', instance: crewInstance, hostId: 'host', opaqueHandle: 'vault-entry',
  };
  const crewAgent: SDK.ProviderRef<I, 'agent'> = {
    instance: crewInstance, kind: 'agent', opaqueId: 'same-agent',
  };
  const crewCreation: SDK.CreationIntent<I> = {
    kind: 'create', operationId: 'crew-create', scope: { hostId: 'host', conversationId: 'crew' }, agent: crewAgent,
  };
  const crewBinding: SDK.ProviderConversation<I> = {
    kind: 'agentui-created', creation: crewCreation,
    authority: { kind: 'remote-provider', binding: {
      namespace: crewInstance.namespace, installationId: crewInstance.installationId, opaqueSessionId: 'same-session',
    } },
  };
  const crewRun: SDK.ConversationRef<I, 'run'> = {
    binding: crewBinding, ref: { kind: 'run', instance: crewInstance, opaqueId: 'same-run' },
  };
  const crewDecision: SDK.ConversationRef<I, 'decision'> = {
    binding: crewBinding, ref: { kind: 'decision', instance: crewInstance, opaqueId: 'same-decision' },
  };
  const crewChoice: SDK.ConversationRef<I, 'choice'> = {
    binding: crewBinding, ref: { kind: 'choice', instance: crewInstance, opaqueId: 'same-choice' },
  };
  const crewCursor: SDK.ProviderCursor<CrewModel, I> = {
    kind: 'provider-cursor', binding: crewBinding, opaque: { checkpoint: 'start', stream: 1 },
  };
  const crewSend: SDK.ProviderCommand<CrewModel, I> = {
    kind: 'send', operationId: 'crew-send', binding: crewBinding, request: { member: 'research', text: 'Hello' },
  };
  const crewUnsupported = { kind: 'unsupported', reason: 'Cancellation is unavailable' } satisfies SDK.ProviderUnsupported;
  const crewBackend: SDK.ConnectedProvider<CrewModel, I> = {
    instance: crewInstance,
    capabilities: { create: { kind: 'supported' }, send: { kind: 'supported' }, cancel: crewUnsupported,
      decide: { kind: 'supported' }, reconcile: { kind: 'supported' }, observe: { kind: 'supported' } },
    async discover() { return { kind: 'available', agents: [{ ref: crewAgent, name: 'Crew researcher' }] }; },
    async create(operation) { return { kind: 'confirmed', value: { ...crewBinding, creation: operation }, evidence: null }; },
    async submit(operation) {
      if (operation.kind === 'cancel') return crewUnsupported;
      return { kind: 'confirmed', value: operation.kind === 'send'
        ? { kind: 'send', run: { ...crewRun, binding: operation.binding }, state: 'accepted' } : { kind: 'decide', state: 'completed' }, evidence: null };
    },
    async reconcileCreation(operation) {
      return { kind: 'confirmed', value: { ...crewBinding, creation: operation }, evidence: null };
    },
    async reconcileCommand(operation) {
      if (operation.kind === 'cancel') return crewUnsupported;
      return { kind: 'confirmed', value: operation.kind === 'send'
        ? { kind: 'send', run: { ...crewRun, binding: operation.binding }, state: 'accepted' } : { kind: 'decide', state: 'completed' }, evidence: null };
    },
    async snapshot(binding) {
      return { kind: 'available', snapshot: { binding, cursor: crewCursor, projectionVersion: 1,
        state: { messages: [] }, decisions: [{ ref: crewDecision, run: crewRun, prompt: 'Continue?',
          choices: [{ ref: crewChoice, label: 'Yes' }] }] } };
    },
    observe() {
      return { close() {}, ended: Promise.resolve({ kind: 'unsupported', cursor: null, reason: 'Fixture has no event source' }) };
    },
    async close() {},
  };
  const crew: SDK.BackendProvider<CrewModel, I> = {
    apiVersion: SDK.backendProviderContractVersion,
    async connect() { return { kind: 'connected', backend: crewBackend }; },
  };
  return { crewCredential, crewAgent, crewCreation, crewBinding, crewRun, crewDecision, crewChoice, crewCursor, crewSend, crewBackend, crew };
}
export const { crewCredential, crewAgent, crewCreation, crewBinding, crewRun, crewDecision, crewChoice, crewCursor, crewSend, crewBackend, crew } = createCrewFixture(crewInstance);

export function crewForRuntimeInstallation(installationId: string) {
  const instance: SDK.ProviderInstance<string> = {
    namespace: 'example.crew', installationId, generation: '1', protocolVersion: 'crew-v2',
  };
  return createCrewFixture(instance).crew;
}
