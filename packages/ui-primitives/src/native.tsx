import { type ReactNode } from 'react';
import { Pressable, Text as NativeText, TextInput, View, type PressableProps, type TextProps as NativeTextProps, type TextInputProps, type ViewProps } from 'react-native';
import { buttonTones, textVariantColor, control, type ButtonTone, type TextVariant } from '@agentui/theme';
import { useTheme } from '@agentui/theme/react';
export { ThemeProvider } from '@agentui/theme/react';

export interface TextProps extends Omit<NativeTextProps, 'allowFontScaling'> { readonly variant?: TextVariant }
export function Text({ variant = 'body', style, ...props }: TextProps) {
  const theme = useTheme();
  const token = theme.typography[variant];
  return <NativeText {...props} allowFontScaling style={[{
    color: theme.colors[textVariantColor[variant]],
    fontSize: token.size, lineHeight: token.size * token.lineHeight, fontWeight: token.weight,
    ...(variant === 'code' ? { fontFamily: 'Menlo' } : {}),
  }, style]} />;
}
export interface ButtonProps extends Omit<PressableProps, 'children' | 'accessibilityRole' | 'role'> {
  readonly tone?: ButtonTone;
  readonly children: ReactNode;
}
export function Button({ tone = 'primary', children, style, disabled, accessibilityState, ...props }: ButtonProps) {
  const theme = useTheme();
  const roles = buttonTones[tone];
  return <Pressable {...props} disabled={disabled} accessibilityRole="button"
    accessibilityState={{ ...accessibilityState, disabled: Boolean(disabled) }}
    style={(state) => [{ minHeight: control.minTarget, minWidth: control.minTarget, paddingVertical: theme.spacing.sm,
      paddingHorizontal: theme.spacing.lg, borderRadius: theme.radius.control, borderWidth: 1,
      borderColor: theme.colors[roles.border], backgroundColor: theme.colors[roles.background],
      justifyContent: 'center', alignItems: 'center', opacity: disabled ? control.disabledOpacity : state.pressed ? 0.85 : 1,
    }, typeof style === 'function' ? style(state) : style]}>
    <Text variant="label" style={{ color: theme.colors[roles.foreground] }}>{children}</Text>
  </Pressable>;
}
export type SurfaceProps = ViewProps;
export function Surface({ style, ...props }: SurfaceProps) {
  const theme = useTheme();
  return <View {...props} style={[{ backgroundColor: theme.colors.surface, borderColor: theme.colors.border,
    borderWidth: 1, borderRadius: theme.radius.panel, padding: theme.spacing.xl }, style]} />;
}
export interface TextFieldProps extends Omit<TextInputProps, 'allowFontScaling'> { readonly label: string }
export function TextField({ label, style, editable, accessibilityState, ...props }: TextFieldProps) {
  const theme = useTheme();
  return <View style={{ gap: theme.spacing.sm }}>
    <Text variant="label" accessibilityElementsHidden importantForAccessibility="no">{label}</Text>
    <TextInput keyboardAppearance={theme.appearance} {...props} editable={editable} allowFontScaling accessibilityLabel={props.accessibilityLabel ?? label}
      accessibilityState={{ ...accessibilityState, disabled: editable === false }}
      placeholderTextColor={theme.colors.muted} style={[{
        minHeight: control.minTarget, minWidth: control.minTarget, color: theme.colors.text, backgroundColor: theme.colors.surface,
        borderColor: theme.colors.controlBorder, borderWidth: 1, borderRadius: theme.radius.control,
        paddingVertical: theme.spacing.sm, paddingHorizontal: theme.spacing.lg, fontSize: theme.typography.body.size,
      }, style]} />
  </View>;
}
