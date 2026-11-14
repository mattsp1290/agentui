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
export const crewCredential: SDK.CredentialHandle<'crew-personal'> = {
  kind: 'credential-handle', instance: crewInstance, hostId: 'host', opaqueHandle: 'vault-entry',
};
export const crewAgent: SDK.ProviderRef<'crew-personal', 'agent'> = {
  instance: crewInstance, kind: 'agent', opaqueId: 'same-agent',
};
export const crewCreation: SDK.CreationIntent<'crew-personal'> = {
  kind: 'create', operationId: 'crew-create', scope: { hostId: 'host', conversationId: 'crew' }, agent: crewAgent,
};
export const crewBinding: SDK.ProviderConversation<'crew-personal'> = {
  kind: 'agentui-created', creation: crewCreation,
  authority: { kind: 'remote-provider', binding: {
    namespace: crewInstance.namespace, installationId: crewInstance.installationId, opaqueSessionId: 'same-session',
  } },
};
export const crewRun: SDK.ConversationRef<'crew-personal', 'run'> = {
  binding: crewBinding, ref: { kind: 'run', instance: crewInstance, opaqueId: 'same-run' },
};
export const crewDecision: SDK.ConversationRef<'crew-personal', 'decision'> = {
  binding: crewBinding, ref: { kind: 'decision', instance: crewInstance, opaqueId: 'same-decision' },
};
export const crewChoice: SDK.ConversationRef<'crew-personal', 'choice'> = {
  binding: crewBinding, ref: { kind: 'choice', instance: crewInstance, opaqueId: 'same-choice' },
};
export const crewCursor: SDK.ProviderCursor<CrewModel, 'crew-personal'> = {
  kind: 'provider-cursor', binding: crewBinding, opaque: { checkpoint: 'start', stream: 1 },
};
export const crewSend: SDK.ProviderCommand<CrewModel, 'crew-personal'> = {
  kind: 'send', operationId: 'crew-send', binding: crewBinding, request: { member: 'research', text: 'Hello' },
};
const crewUnsupported = { kind: 'unsupported', reason: 'Cancellation is unavailable' } satisfies SDK.ProviderUnsupported;
export const crewBackend: SDK.ConnectedProvider<CrewModel, 'crew-personal'> = {
  instance: crewInstance,
  capabilities: { create: { kind: 'supported' }, send: { kind: 'supported' }, cancel: crewUnsupported,
    decide: { kind: 'supported' }, reconcile: { kind: 'supported' }, observe: { kind: 'supported' } },
  async discover() { return { kind: 'available', agents: [{ ref: crewAgent, name: 'Crew researcher' }] }; },
  async create() { return { kind: 'pending', evidence: { admitted: true } }; },
  async submit(operation) {
    if (operation.kind === 'cancel') return crewUnsupported;
    return { kind: 'confirmed', value: operation.kind === 'send'
      ? { kind: 'send', run: crewRun, state: 'accepted' } : { kind: 'decide', state: 'completed' }, evidence: null };
  },
  async reconcile() { return { kind: 'uncertain', reason: 'No authoritative lookup evidence', evidence: null }; },
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
export const crew: SDK.BackendProvider<CrewModel, 'crew-personal'> = {
  apiVersion: SDK.backendProviderContractVersion,
  async connect() { return { kind: 'connected', backend: crewBackend }; },
};
