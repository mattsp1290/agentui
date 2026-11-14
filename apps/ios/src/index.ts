import type { ComponentType } from 'react';
import type { ViewProps } from 'react-native';
import type { ConversationModuleProps } from '@agentui/sdk/react';

export const clientPlatform = 'ios';
export type IosConversationView = ComponentType<ConversationModuleProps & Pick<ViewProps, 'accessibilityLabel' | 'style'>>;

export type { ButtonProps, TextProps, SurfaceProps, TextFieldProps } from '@agentui/ui-primitives/native';
