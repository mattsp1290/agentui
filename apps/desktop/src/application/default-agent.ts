import type { CustomizationDefaultAgent, CustomizationSettings } from '@agentui/contracts/service';
import type { AgentDescriptor, ServiceMetadata } from '@agentui/contracts/service';
import { harness } from './ComposerAgentControls.js';

type ProviderAgent = Extract<AgentDescriptor, { readonly kind: 'provider' }>;
const isProvider = (agent: AgentDescriptor): agent is ProviderAgent => 'kind' in agent;
const ready = (agent: AgentDescriptor) => agent.availability.kind === 'ready';

/** The agent a stored default names on this host, ready or not; null when nothing matches. */
export function matchDefaultAgent(selector: CustomizationDefaultAgent, metadata: Pick<ServiceMetadata, 'agents' | 'defaultAgentId'>): AgentDescriptor | null {
  if (selector.kind === 'provider') {
    return metadata.agents.find(agent => isProvider(agent) && agent.namespace === selector.namespace && agent.installationId === selector.installationId &&
      agent.providerAgentId === selector.providerAgentId) ?? null;
  }
  const group = metadata.agents.filter(agent => !isProvider(agent) && harness(agent) === selector.harness);
  if (selector.model !== undefined) {
    const matches = group.filter(agent => 'runtime' in agent && agent.model?.id === selector.model);
    return matches.find(ready) ?? matches[0] ?? null;
  }
  const hostDefault = group.find(agent => agent.id === metadata.defaultAgentId && ready(agent));
  return hostDefault ?? group.find(ready) ?? group[0] ?? null;
}

/**
 * The agent ID that a new chat uses by default: the stored selector's agent when it is ready on this host, otherwise
 * null, and the caller uses the host default.
 */
export function resolveDefaultAgent(settings: Pick<CustomizationSettings, 'defaultAgent'> | null, metadata: Pick<ServiceMetadata, 'agents' | 'defaultAgentId'>): string | null {
  const selector = settings?.defaultAgent;
  if (!selector) return null;
  const agent = matchDefaultAgent(selector, metadata);
  return agent && ready(agent) ? agent.id : null;
}

/** The portable selector that stores `agent` as the default: what it is, not its host-local ID. */
export function defaultAgentSelector(agent: AgentDescriptor): CustomizationDefaultAgent | null {
  if (isProvider(agent)) {
    return agent.providerAgentId === null ? null
      : { kind: 'provider', namespace: agent.namespace, installationId: agent.installationId, providerAgentId: agent.providerAgentId };
  }
  const group = harness(agent);
  if (group === 'provider' || group === 'other') return null;
  return { kind: 'native', harness: group, ...(agent.model ? { model: agent.model.id } : {}) };
}
