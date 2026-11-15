import * as SDK from '@agentui/sdk';

export type LocalModel = {
  request: { input: readonly { role: 'user'; content: string }[] };
  cursor: readonly [epoch: number, offset: number];
  state: { transcript: string };
  event: { append: string };
};
export const localInstance: SDK.ProviderInstance<'native-work'> = {
  namespace: 'example-local', installationId: 'native-work', generation: '3', protocolVersion: 'local-v1',
};
export const localCredential: SDK.CredentialHandle<'native-work'> = {
  kind: 'credential-handle', instance: localInstance, hostId: 'host', opaqueHandle: 'local-vault-entry',
};
export const localAgent: SDK.ProviderRef<'native-work', 'agent'> = {
  instance: localInstance, kind: 'agent', opaqueId: 'same-agent',
};
export const localCreation: SDK.CreationIntent<'native-work'> = {
  kind: 'create', operationId: 'local-create', scope: { hostId: 'host', conversationId: 'local' }, agent: localAgent,
};
export const localBinding: SDK.ProviderConversation<'native-work'> = {
  kind: 'agentui-created', creation: localCreation,
  authority: { kind: 'agentui-host', hostId: 'host', binding: {
    namespace: localInstance.namespace, installationId: localInstance.installationId, opaqueSessionId: 'same-session',
  } },
};
export const localRun: SDK.ConversationRef<'native-work', 'run'> = {
  binding: localBinding, ref: { kind: 'run', instance: localInstance, opaqueId: 'same-run' },
};
export const localDecision: SDK.ConversationRef<'native-work', 'decision'> = {
  binding: localBinding, ref: { kind: 'decision', instance: localInstance, opaqueId: 'same-decision' },
};
export const localChoice: SDK.ConversationRef<'native-work', 'choice'> = {
  binding: localBinding, ref: { kind: 'choice', instance: localInstance, opaqueId: 'same-choice' },
};
export const localCursor: SDK.ProviderCursor<LocalModel, 'native-work'> = {
  kind: 'provider-cursor', binding: localBinding, opaque: [2, 7],
};
export const localSend: SDK.ProviderCommand<LocalModel, 'native-work'> = {
  kind: 'send', operationId: 'local-send', binding: localBinding, request: { input: [{ role: 'user', content: 'Hello' }] },
};
export const localBackend: SDK.ConnectedProvider<LocalModel, 'native-work'> = {
  instance: localInstance,
  capabilities: { create: { kind: 'supported' }, send: { kind: 'supported' }, cancel: { kind: 'supported' },
    decide: { kind: 'supported' }, reconcile: { kind: 'unsupported', reason: 'No lookup' }, observe: { kind: 'supported' } },
  async discover() { return { kind: 'available', agents: [{ ref: localAgent, name: 'Local assistant' }] }; },
  async create(operation) { return { kind: 'confirmed', value: { ...localBinding, creation: operation }, evidence: null }; },
  async submit(operation) {
    return { kind: 'confirmed', value: operation.kind === 'send'
      ? { kind: 'send', run: localRun, state: 'completed' } : { kind: operation.kind, state: 'completed' }, evidence: null };
  },
  async reconcileCreation() { return { kind: 'unsupported', reason: 'No lookup' }; },
  async reconcileCommand() { return { kind: 'unsupported', reason: 'No lookup' }; },
  async snapshot(binding) {
    return { kind: 'available', snapshot: { binding, cursor: localCursor, projectionVersion: 1,
      state: { transcript: '' }, decisions: [{ ref: localDecision, run: localRun, prompt: 'Continue?',
        choices: [{ ref: localChoice, label: 'Yes' }] }] } };
  },
  observe() {
    return { close() {}, ended: Promise.resolve({ kind: 'resync', cursor: null, reason: 'Fixture has no replay source' }) };
  },
  async close() {},
};
export const local: SDK.BackendProvider<LocalModel, 'native-work'> = {
  apiVersion: SDK.backendProviderContractVersion,
  async connect() { return { kind: 'connected', backend: localBackend }; },
};

export const localPresentation: SDK.ProviderPresentation<LocalModel, 'native-work'> = {
  instance: localInstance,
  decodeRequest(value) {
    if (!value || typeof value !== 'object' || !('input' in value) || !Array.isArray(value.input)) throw new Error('Invalid request');
    const input: LocalModel['request']['input'] = value.input.map((item: unknown) => {
      if (!item || typeof item !== 'object' || !('role' in item) || item.role !== 'user' || !('content' in item) || typeof item.content !== 'string') throw new Error('Invalid input');
      return { role: 'user', content: item.content };
    });
    return { input };
  },
  decodeCursor(value) {
    if (!Array.isArray(value) || value.length !== 2 || typeof value[0] !== 'number' || typeof value[1] !== 'number') throw new Error('Invalid cursor');
    return [value[0], value[1]];
  },
  decodeState(value) {
    if (!value || typeof value !== 'object' || !('transcript' in value) || typeof value.transcript !== 'string') throw new Error('Invalid state');
    return { transcript: value.transcript };
  },
  decodeEvent(value) {
    if (!value || typeof value !== 'object' || !('append' in value) || typeof value.append !== 'string') throw new Error('Invalid event');
    return { append: value.append };
  },
  request(text) { return { input: [{ role: 'user', content: text }] }; },
  snapshot(state) { return { currentRun: null, messages: [{ messageId: 'transcript', revision: 1, role: 'assistant', text: state.transcript, complete: true }] }; },
  apply(previous, event) { return { state: { transcript: previous.transcript + event.append }, events: [] }; },
};
