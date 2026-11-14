# T3 Code design reference

AgentUI uses T3 Code as a reference for its default visual language.
The reference revision is [6bce2226decf0e5d1864fecb53e3e91ce1672acc](https://github.com/pingdotgg/t3code/tree/6bce2226decf0e5d1864fecb53e3e91ce1672acc).

## Apply the useful patterns

T3 Code separates [semantic color roles and light and dark palettes](https://github.com/pingdotgg/t3code/blob/6bce2226decf0e5d1864fecb53e3e91ce1672acc/packages/shared/src/themePalettes.ts) from platform rendering.
AgentUI follows that separation with a small theme package and independent desktop and React Native primitives.
Color names describe purpose, so a module can change an accent without replacing every component.

Its [web geometry](https://github.com/pingdotgg/t3code/blob/6bce2226decf0e5d1864fecb53e3e91ce1672acc/apps/web/src/index.css) gives controls consistent radii, sidebar spacing, and a bounded conversation column.
Its [button component](https://github.com/pingdotgg/t3code/blob/6bce2226decf0e5d1864fecb53e3e91ce1672acc/apps/web/src/components/ui/button.tsx) distinguishes action tones, keyboard focus, disabled controls, and coarse-pointer targets.
AgentUI starts with fewer variants and a 44-pixel minimum target for every action.
Future conversation modules can reuse the same geometry without adopting T3 Code's routing or component framework.

## Keep the AgentUI ownership model

Native agent adapters remain Switchboard's responsibility.
This comparison does not qualify or replace those adapters.
T3 Code's Effect state, Electron integration, provider control, theme persistence, and routing remain outside this delivery.
AgentUI's desktop and iOS entries are still compilation probes.
The visual fixture exercises the new primitives, not an operational agent client.

## Reuse and license

The reference [license](https://github.com/pingdotgg/t3code/blob/6bce2226decf0e5d1864fecb53e3e91ce1672acc/LICENSE) is MIT, copyright 2026 T3 Tools Inc.
This delivery uses original implementations informed by those patterns.
It copies no upstream implementation or assets.
Any later copied or substantially adapted code must retain the upstream copyright and MIT permission notice with that code.
