import { canonicalJson, copyJson, parseRunAuthority, parseScope, sameScope } from '@agentui/contracts';
import type { ConversationScope, Json, RunAuthority } from '@agentui/contracts';
import { identifier, record } from '@agentui/contracts/decode';
import type { CreationIntent, CredentialHandle, ProviderConversation, ProviderInstance } from '@agentui/sdk';
import type { Installation } from './durable-model.js';
import { installation } from './native-execution.js';

export type ProviderIdentity = Pick<ProviderInstance<string>, 'namespace' | 'installationId' | 'generation' | 'protocolVersion'>;
export interface ProviderInstallation {
  readonly kind: 'provider';
  readonly contributionId: string;
  readonly instance: ProviderIdentity;
  readonly agent: { readonly opaqueId: string; readonly name: string };
  readonly presentationVersion: 1;
  readonly expectedAuthority: RunAuthority['kind'];
}
export function providerInstallationKey(value: ProviderInstallation): string {
  return canonicalJson({ ...value, agent: { opaqueId: value.agent.opaqueId } });
}
export type ConversationInstallation = Installation | ProviderInstallation;
export interface ProviderCreation {
  readonly installation: ProviderInstallation;
  readonly intent: CreationIntent<string>;
  readonly credential: CredentialHandle<string> | null;
}
export type CreationObservation =
  | { readonly kind: 'confirmed'; readonly source: 'create' | 'lookup'; readonly binding: ProviderConversation<string>; readonly evidence: Json }
  | { readonly kind: 'rejected' | 'not-dispatched'; readonly source: 'create' | 'lookup' | 'host'; readonly evidence: Json }
  | { readonly kind: 'pending' | 'uncertain'; readonly source: 'create' | 'lookup'; readonly evidence: Json };
export interface StoredCreation extends ProviderCreation {
  readonly status: 'reserved' | 'attempted' | 'observed';
  readonly observation: CreationObservation | null;
}
export function providerIdentity(value: unknown): ProviderIdentity {
  const input = record(value, ['namespace', 'installationId', 'generation', 'protocolVersion']);
  if (Object.values(input).some(value => typeof value !== 'string' || !value.trim())) throw new Error('Invalid provider identity');
  return { namespace: identifier(input.namespace), installationId: identifier(input.installationId),
    generation: identifier(input.generation), protocolVersion: identifier(input.protocolVersion) };
}
export function providerInstallation(value: unknown): ProviderInstallation {
  const input = record(value, ['kind', 'contributionId', 'instance', 'agent', 'presentationVersion', 'expectedAuthority']);
  const agent = record(input.agent, ['opaqueId', 'name']);
  if (input.kind !== 'provider' || input.presentationVersion !== 1 ||
    (input.expectedAuthority !== 'remote-provider' && input.expectedAuthority !== 'agentui-host')) throw new Error('Invalid provider installation');
  return { kind: 'provider', contributionId: identifier(input.contributionId), instance: providerIdentity(input.instance),
    agent: { opaqueId: identifier(agent.opaqueId), name: identifier(agent.name) }, presentationVersion: 1, expectedAuthority: input.expectedAuthority };
}
export function conversationInstallation(value: unknown): ConversationInstallation {
  return record(value).kind === 'provider' ? providerInstallation(value) : installation(value);
}
export function creationIntent<I extends string>(value: unknown, selected: ProviderInstallation, instance: ProviderInstance<I>): CreationIntent<I> {
  const input = record(value, ['kind', 'operationId', 'scope', 'agent']), agent = record(input.agent, ['instance', 'kind', 'opaqueId']);
  const operationId = identifier(input.operationId);
  if (input.kind !== 'create' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(operationId) ||
    agent.kind !== 'agent' || agent.opaqueId !== selected.agent.opaqueId || canonicalJson(providerIdentity(agent.instance)) !== canonicalJson(instance) ||
    canonicalJson(selected.instance) !== canonicalJson(instance)) throw new Error('Foreign creation intent');
  return { kind: 'create', operationId, scope: parseScope(input.scope), agent: { kind: 'agent', instance, opaqueId: selected.agent.opaqueId } };
}
export function creationBinding<I extends string>(value: unknown, creation: CreationIntent<I>, selected: ProviderInstallation): ProviderConversation<I> {
  const input = record(value, ['kind', 'creation', 'authority']);
  const original = creationIntent(input.creation, selected, creation.agent.instance), authority = parseRunAuthority(input.authority);
  if (input.kind !== 'agentui-created' || canonicalJson(original) !== canonicalJson(creation) || authority.kind !== selected.expectedAuthority ||
    authority.binding.namespace !== selected.instance.namespace || authority.binding.installationId !== selected.instance.installationId ||
    (authority.kind === 'agentui-host' && authority.hostId !== creation.scope.hostId)) throw new Error('Foreign creation binding');
  return { kind: 'agentui-created', creation, authority: { ...authority,
    binding: { ...authority.binding, installationId: creation.agent.instance.installationId } } };
}
export function providerCreation(value: unknown, scope: ConversationScope): ProviderCreation {
  const input = record(value, ['installation', 'intent', 'credential']), selected = providerInstallation(input.installation);
  const intent = creationIntent(input.intent, selected, selected.instance);
  if (!sameScope(intent.scope, scope)) throw new Error('Foreign creation scope');
  let credential: CredentialHandle<string> | null = null;
  if (input.credential !== null) {
    const handle = record(input.credential, ['kind', 'hostId', 'instance', 'opaqueHandle']);
    if (handle.kind !== 'credential-handle' || handle.hostId !== scope.hostId ||
      canonicalJson(providerIdentity(handle.instance)) !== canonicalJson(selected.instance)) throw new Error('Foreign creation credential');
    credential = { kind: 'credential-handle', hostId: scope.hostId, instance: selected.instance, opaqueHandle: identifier(handle.opaqueHandle) };
  }
  return { installation: selected, intent, credential };
}
export function creationObservation(value: unknown, original: ProviderCreation): CreationObservation {
  const input = record(value);
  record(input, input.kind === 'confirmed' ? ['kind', 'source', 'binding', 'evidence'] : ['kind', 'source', 'evidence']);
  if (input.source !== 'create' && input.source !== 'lookup' && input.source !== 'host') throw new Error('Invalid creation evidence source');
  const evidence = copyJson(input.evidence);
  if (Buffer.byteLength(canonicalJson(evidence)) > 64_000) throw new Error('Creation evidence exceeds limit');
  if (input.kind === 'rejected' || input.kind === 'not-dispatched') return { kind: input.kind, source: input.source, evidence };
  if (input.source === 'host') throw new Error('Invalid creation evidence source');
  if (input.kind === 'confirmed') return { kind: 'confirmed', source: input.source, evidence,
    binding: creationBinding(input.binding, original.intent, original.installation) };
  if (input.kind !== 'pending' && input.kind !== 'uncertain') throw new Error('Invalid creation observation');
  return { kind: input.kind, source: input.source, evidence };
}
