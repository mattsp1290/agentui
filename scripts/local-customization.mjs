import { EXTENSION_SDK_VERSION } from '@agentui/sdk';
import { desktopCustomizationIdentity, planCustomizationCatalog } from '@agentui/host/customization';
export { customizationPlugin } from './lib/customization-plugin.mjs';

export function desktopPlan(root) {
  const plan = planCustomizationCatalog(root, EXTENSION_SDK_VERSION, 'desktop');
  return { roots: plan.roots, entries: plan.entries.map((entry, index) => ({ ...entry, source: plan.sources[index] })),
    identity: desktopCustomizationIdentity(plan) };
}

