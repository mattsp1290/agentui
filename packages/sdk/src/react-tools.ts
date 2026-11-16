import { parseUiExtensionPresentation, type UiExtensionPresentation } from './react.js';
import { createFrontendToolGeneration } from './tools.js';
import type { FrontendToolGeneration, FrontendToolGenerationOptions } from './tool-contracts.js';

export interface UiExtensionGeneration {
  readonly generation: FrontendToolGeneration;
  readonly presentation: UiExtensionPresentation;
}

export async function createUiExtensionGeneration(options: Pick<FrontendToolGenerationOptions<UiExtensionPresentation>,
  'namespace' | 'generation' | 'platform' | 'activate' | 'onFailure'>): Promise<UiExtensionGeneration> {
  const { namespace, generation: generationId, platform, onFailure } = options;
  const { generation, contributions: presentation } = await createFrontendToolGeneration({
    namespace, generation: generationId, platform,
    ...(onFailure === undefined ? {} : { onFailure }),
    activate: context => options.activate(context),
    capture: parseUiExtensionPresentation,
  });
  return { generation, presentation };
}
