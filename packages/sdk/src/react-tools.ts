import type { FrontendPlatform } from './extensions.js';
import { parseUiExtensionContributions, type UiExtensionPresentation } from './react.js';
import { createFrontendToolGeneration } from './tools.js';
import type { FrontendToolGeneration, UiExtensionContext } from './tool-contracts.js';

export interface UiExtensionGeneration {
  readonly generation: FrontendToolGeneration;
  readonly presentation: UiExtensionPresentation;
}

export async function createUiExtensionGeneration(options: {
  readonly namespace: string;
  readonly generation: string;
  readonly platform: FrontendPlatform;
  activate(context: UiExtensionContext): unknown;
}): Promise<UiExtensionGeneration> {
  let acceptCaptured: () => { presentation: UiExtensionPresentation; dispose: () => Promise<void> } = () => {
    throw new Error('UI extension acceptance preceded activation capture');
  };
  const { generation, contributions } = await createFrontendToolGeneration({
    namespace: options.namespace, generation: options.generation, platform: options.platform,
    async activate(context) {
      const captured = parseUiExtensionContributions(await options.activate(context));
      if (captured.kind === 'invalid-lifetime') throw captured.error;
      acceptCaptured = () => {
        if (captured.kind === 'invalid-presentation') throw captured.error;
        return { presentation: captured.presentation, dispose: captured.dispose };
      };
      return { dispose: captured.dispose };
    },
    accept: () => acceptCaptured(),
  });
  return { generation, presentation: contributions.presentation };
}
