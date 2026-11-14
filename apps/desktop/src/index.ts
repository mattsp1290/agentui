import type { Root } from 'react-dom/client';
import type { ConversationModule } from '@agentui/sdk/react';

export const clientPlatform = 'desktop';

export interface DesktopMount {
  readonly container: HTMLElement;
  readonly root: Root;
  readonly module: ConversationModule;
}

export { Button, Text, Surface, TextField, ThemeScope } from '@agentui/ui-primitives/desktop';
