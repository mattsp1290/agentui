import type { ComponentType } from 'react';
import type { ConversationScope } from '@agentui/contracts';

export interface ConversationModuleProps {
  readonly conversation: ConversationScope;
}

export interface ConversationModule {
  readonly id: string;
  readonly component: ComponentType<ConversationModuleProps>;
}
