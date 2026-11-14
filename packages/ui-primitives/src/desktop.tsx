import { useContext, useId, useSyncExternalStore, type CSSProperties, type HTMLAttributes, type ButtonHTMLAttributes, type InputHTMLAttributes } from 'react';
import { type ButtonTone, type TextVariant, type Theme } from '@agentui/theme';
import { ThemeProvider, ThemeContext, useTheme, type ThemeProviderProps } from '@agentui/theme/react';

export function toCssVariables(theme: Theme): Record<`--aui-${string}`, string> {
  const variables: Record<`--aui-${string}`, string> = {};
  for (const [key, value] of Object.entries(theme.colors)) variables[`--aui-${key}`] = value;
  for (const [key, value] of Object.entries(theme.spacing)) variables[`--aui-space-${key}`] = `${value / 16}rem`;
  for (const [key, value] of Object.entries(theme.radius)) variables[`--aui-radius-${key}`] = `${value / 16}rem`;
  for (const [key, value] of Object.entries(theme.typography)) {
    variables[`--aui-text-${key}`] = `${value.size / 16}rem`;
    variables[`--aui-leading-${key}`] = String(value.lineHeight);
    variables[`--aui-weight-${key}`] = String(value.weight);
  }
  for (const [key, value] of Object.entries(theme.motion)) variables[`--aui-motion-${key}`] = `${value}ms`;
  return variables;
}
const mediaQueries = ['(prefers-color-scheme: dark)', '(prefers-reduced-motion: reduce)'] as const;
function readEnvironment(): number {
  if (typeof window === 'undefined') return 0;
  return (window.matchMedia(mediaQueries[0]).matches ? 1 : 0) + (window.matchMedia(mediaQueries[1]).matches ? 2 : 0);
}
function subscribeEnvironment(notify: () => void): () => void {
  const queries = mediaQueries.map((query) => window.matchMedia(query));
  for (const query of queries) query.addEventListener('change', notify);
  return () => { for (const query of queries) query.removeEventListener('change', notify); };
}
const readServerEnvironment = () => 0;
const subscribeNothing = () => () => {};
export interface ThemeScopeProps extends ThemeProviderProps, Omit<HTMLAttributes<HTMLDivElement>, 'color' | 'children'> {}
export function ThemeScope({ appearance, reducedMotion, colors, children, ...props }: ThemeScopeProps) {
  const parent = useContext(ThemeContext);
  const system = useSyncExternalStore(parent ? subscribeNothing : subscribeEnvironment, readEnvironment, readServerEnvironment);
  return <ThemeProvider appearance={appearance ?? parent?.appearance ?? (system % 2 ? 'dark' : 'light')}
    reducedMotion={reducedMotion ?? parent?.reducedMotion ?? system >= 2} {...(colors ? { colors } : {})}>
    <ThemeSurface {...props}>{children}</ThemeSurface>
  </ThemeProvider>;
}
function ThemeSurface({ children, style, className = '', ...props }: HTMLAttributes<HTMLDivElement>) {
  const theme = useTheme();
  return <div {...props} className={`aui-theme ${className}`} data-appearance={theme.appearance}
    data-reduced-motion={theme.reducedMotion} style={{ ...toCssVariables(theme), ...style }}>{children}</div>;
}
export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> { readonly tone?: ButtonTone }
export function Button({ tone = 'primary', className = '', type = 'button', ...props }: ButtonProps) {
  return <button {...props} type={type} className={`aui-button ${className}`} data-tone={tone} />;
}
export interface TextProps extends HTMLAttributes<HTMLElement> {
  readonly variant?: TextVariant;
  readonly as?: 'p' | 'span' | 'h1' | 'h2' | 'h3' | 'code';
}
export function Text({ variant = 'body', as: Tag = 'p', className = '', ...props }: TextProps) {
  return <Tag {...props} className={`aui-text ${className}`} data-variant={variant} />;
}
export type SurfaceProps = HTMLAttributes<HTMLDivElement>;
export function Surface({ className = '', ...props }: SurfaceProps) {
  return <div {...props} className={`aui-surface ${className}`} />;
}
export interface TextFieldProps extends InputHTMLAttributes<HTMLInputElement> { readonly label: string }
export function TextField({ label, id, className = '', ...props }: TextFieldProps) {
  const generatedId = useId();
  const inputId = id ?? generatedId;
  return <label className="aui-field" htmlFor={inputId}>
    <span className="aui-text" data-variant="label">{label}</span>
    <input {...props} id={inputId} className={`aui-input ${className}`} />
  </label>;
}
export type ThemeStyle = CSSProperties & Record<`--aui-${string}`, string>;
