export type Appearance = 'light' | 'dark';

const lightColors = {
  canvas: '#f8f9fb', surface: '#ffffff', raised: '#f0f2f5',
  text: '#20242c', muted: '#596273', border: '#dce1e9', controlBorder: '#737e90',
  accent: '#3655c7', onAccent: '#ffffff', danger: '#b42338', onDanger: '#ffffff', focus: '#3655c7',
};
export type ThemeColors = Readonly<Record<keyof typeof lightColors, string>>;
export const palettes: Readonly<Record<Appearance, ThemeColors>> = {
  light: lightColors,
  dark: {
    canvas: '#15171c', surface: '#1d2027', raised: '#292e38',
    text: '#eef0f5', muted: '#adb6c6', border: '#3c4350', controlBorder: '#8793a8',
    accent: '#a9b9ff', onAccent: '#17214b', danger: '#ffacb8', onDanger: '#47111b', focus: '#a9b9ff',
  },
};
export const spacing = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 } as const;
export const radius = { control: 8, panel: 12 } as const;
export const typography = {
  body: { size: 16, lineHeight: 1.6, weight: 400 },
  muted: { size: 14, lineHeight: 1.6, weight: 400 },
  label: { size: 14, lineHeight: 1.5, weight: 600 },
  title: { size: 24, lineHeight: 1.3, weight: 600 },
  code: { size: 14, lineHeight: 1.6, weight: 400 },
} as const;
export type TextVariant = keyof typeof typography;
export type ButtonTone = 'primary' | 'secondary' | 'danger';
export interface ThemeOptions {
  readonly appearance?: Appearance;
  readonly reducedMotion?: boolean;
  readonly colors?: Partial<ThemeColors>;
}
export interface Theme {
  readonly appearance: Appearance;
  readonly reducedMotion: boolean;
  readonly colors: ThemeColors;
  readonly spacing: typeof spacing;
  readonly radius: typeof radius;
  readonly typography: typeof typography;
  readonly motion: Readonly<{ quick: number; standard: number }>;
}
export function createTheme(options: ThemeOptions = {}, parent?: Theme): Theme {
  const appearance = options.appearance ?? parent?.appearance ?? 'light';
  const reducedMotion = options.reducedMotion ?? parent?.reducedMotion ?? false;
  const inheritedColors = parent?.appearance === appearance ? parent.colors : palettes[appearance];
  return {
    appearance, reducedMotion,
    colors: { ...inheritedColors, ...options.colors },
    spacing, radius, typography,
    motion: reducedMotion ? { quick: 0, standard: 0 } : { quick: 120, standard: 180 },
  };
}
export const defaultTheme = createTheme();
