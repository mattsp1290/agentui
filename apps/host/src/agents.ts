import { createHash } from 'node:crypto';
import { canonicalJson } from '@agentui/contracts';
import { CLAUDE_SDK_CHAT_LABELS, CLAUDE_SDK_RUNTIMES, CODEX_RUNTIME, CODEX_SDK_CHAT_LABEL, CODEX_SDK_MODEL, CODEX_SDK_RUNTIME, PI_CHAT_LABEL, PI_RUNTIME, RECORDED_RUNTIME } from '@agentui/contracts/compatibility';
import type { AgentDescriptor, NativeAgentDescriptor } from '@agentui/contracts/service';
import { codexInstallationModel, providerInstallationKey, providerUnavailableReasons } from '@agentui/host';
import type { Installation, ProviderInstallation, UnavailableProvider } from '@agentui/host';

export interface InstalledAgent {
  readonly name?: string;
  readonly selectable?: boolean;
  readonly model?: NativeAgentDescriptor['model'];
  readonly installation: Installation;
  readonly availability: AgentDescriptor['availability'];
}
const nativeAgents: readonly Pick<NativeAgentDescriptor, 'runtime' | 'label' | 'commands' | 'model'>[] = [
  { runtime: CODEX_RUNTIME, label: 'Codex', commands: ['send', 'cancel', 'approve'] },
  { runtime: CODEX_SDK_RUNTIME, label: CODEX_SDK_CHAT_LABEL, model: CODEX_SDK_MODEL, commands: ['send', 'cancel'] },
  { runtime: CLAUDE_SDK_RUNTIMES.opus, label: CLAUDE_SDK_CHAT_LABELS.opus, commands: ['send', 'cancel'] },
  { runtime: CLAUDE_SDK_RUNTIMES.sonnet, label: CLAUDE_SDK_CHAT_LABELS.sonnet, commands: ['send', 'cancel'] },
  { runtime: PI_RUNTIME, label: PI_CHAT_LABEL, commands: ['send', 'cancel'] },
  { runtime: RECORDED_RUNTIME, label: 'Recorded assistant', commands: ['send', 'approve'] },
];

export function describeAgent(installation: Installation, availability: AgentDescriptor['availability'], model?: NativeAgentDescriptor['model']): NativeAgentDescriptor {
  const { binding } = installation;
  const runtime = { engine: binding.engine, version: binding.nativeVersion, format: binding.nativeFormat };
  const known = nativeAgents.find(agent => canonicalJson(agent.runtime) === canonicalJson(runtime));
  const modelId = codexInstallationModel(installation);
  const selectedModel = model ?? (modelId ? { id: modelId, label: modelId } : known?.model);
  return { ...(selectedModel ? { model: selectedModel } : {}), id: `agent-v1-${createHash('sha256').update(canonicalJson(installation)).digest('hex')}`, runtime,
    frontendOffers: 'unsupported', label: model?.label ?? modelId ?? known?.label ?? 'Unavailable agent', commands: known?.commands ?? [],
    availability: known ? availability : { kind: 'unavailable', reason: 'This agent runtime is unsupported.' } };
}

export function describeProviderAgent(installation: ProviderInstallation, availability: AgentDescriptor['availability'], commands: AgentDescriptor['commands'] = [], frontendOffers: AgentDescriptor['frontendOffers'] = 'unsupported'): AgentDescriptor {
  return { kind: 'provider', id: `provider-v1-${createHash('sha256').update(providerInstallationKey(installation)).digest('hex')}`,
    label: installation.agent.name, namespace: installation.instance.namespace, protocolVersion: installation.instance.protocolVersion,
    commands, availability, frontendOffers };
}

export function describeUnavailableProvider(provider: UnavailableProvider): AgentDescriptor {
  return { kind: 'provider', id: `provider-installation-v1-${createHash('sha256').update(canonicalJson({ contributionId: provider.contributionId, instance: provider.instance })).digest('hex')}`,
    label: `${provider.instance.namespace} · ${provider.instance.installationId}`, namespace: provider.instance.namespace, protocolVersion: provider.instance.protocolVersion,
    commands: [], frontendOffers: 'unsupported', availability: { kind: 'unavailable', reason: providerUnavailableReasons[provider.cause] } };
}
