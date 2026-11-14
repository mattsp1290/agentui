# Default theme and primitives

The theme packages give desktop and iOS modules the same semantic colors, spacing, typography, and motion durations.
Desktop uses DOM elements. Native uses React Native controls.
Neither package depends on the host or an agent adapter.

## Desktop modules

Import `@agentui/ui-primitives/styles.css` once in the desktop entry.
Wrap a module in `ThemeScope` from `@agentui/ui-primitives/desktop`.
The outer scope follows system appearance and reduced motion unless you provide explicit values.
Nested scopes inherit those choices.
Use `ThemeScope` as the outer desktop boundary.
A plain `ThemeProvider` represents caller-supplied preferences, so scopes below it inherit those preferences instead of observing the OS.
Nested scopes can request reduced motion but cannot re-enable motion that their parent reduced.

```tsx
import { Button, Text, TextField, ThemeScope } from '@agentui/ui-primitives/desktop';
import '@agentui/ui-primitives/styles.css';

export function ComposerExample() {
	return <ThemeScope>
		<Text variant="title" as="h2">Start a conversation</Text>
		<TextField label="Message" />
		<Button>Send message</Button>
	</ThemeScope>;
}
```

The action in this example has no agent connection.
`Button` defaults to `type="button"`. Set `type="submit"` when you want form submission.
`TextField` requires a visible label and links it to its input.
Controls have a 44-pixel minimum target, keyboard focus outlines, and text that can wrap.
Desktop text uses `rem` units and responds to browser text scaling.

`toCssVariables(theme)` from `@agentui/ui-primitives/desktop` exposes the same values for custom DOM controls.
Color variables use `--aui-color-*` with kebab-case role names.
Font sizes use `--aui-font-size-*`.
The other families are `--aui-space-*`, `--aui-radius-*`, `--aui-leading-*`, `--aui-weight-*`, `--aui-text-color-*`, `--aui-motion-*`, `--aui-control-*`, `--aui-button-*`, and `--aui-disabled-opacity`.
`ThemeScope` applies them automatically.
The stylesheet contract test checks every theme variable reference against the emitted variables.

## Native modules

Import `Button`, `Text`, `Surface`, `TextField`, and `ThemeProvider` from `@agentui/ui-primitives/native`.
The native shell supplies appearance and reduced-motion preferences to `ThemeProvider`.
This package does not subscribe to native OS preferences or mount an application.
Native text always enables automatic font scaling and uses unscaled token sizes.
Do not multiply these sizes by the OS font scale.
The native runtime and VoiceOver behavior still require qualification on an Apple device or simulator.

## Module overrides

Put a nested `ThemeScope` around a desktop module, or a nested `ThemeProvider` around a native module.
Pass `colors` with only the semantic roles you want to change.
Unset, empty, and non-string override values keep the inherited color, and unknown roles are ignored.
The override inherits the parent's remaining colors and preferences without changing sibling modules.
Changing `appearance` selects the new default palette before applying the scope's color overrides.
Desktop `ThemeScope` renders a block element with its own canvas background.
Place it around a module's `Surface` rather than around an inline action in a row.

```tsx
<ThemeScope colors={{ accent: '#6d28d9', onAccent: '#ffffff' }}>
	<Button>Module action</Button>
</ThemeScope>
```

Overrides are full-trust customization.
Their author must check text and control contrast.
The default palettes meet 4.5:1 for normal text and action labels, and 3:1 for control boundaries and focus against their adjacent surfaces.
Custom overrides have no automatic contrast correction.

## Verify the fixture

After `npm ci`, install the test browser with `npm run setup:browser`.
Run `npm run verify` to build all packages and check their types, boundaries, lint, contrast, and browser behavior.
Run `npm run preview:theme` after building to open the workbench at `http://127.0.0.1:4173`.
The workbench is a local fixture with example content.
It does not launch the Tauri client or connect an agent.

Browser checks exercise keyboard activation, disabled actions, labels, system appearance changes, nested overrides, reduced motion, 200% text at phone width, and axe accessibility checks.
The native checks compile against React Native with DOM globals excluded.
These checks do not establish native runtime behavior.
