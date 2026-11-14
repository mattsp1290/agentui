# AgentUI

AgentUI is a conversation client for existing agent installations, with React customization for Tauri desktop and a separate React Native iOS client.

This foundation establishes package builds and ownership contracts. It does not launch a desktop app, an iOS app, a host server, or an agent loop.

Use Node 24.22.3 and npm 11.19.1.

```sh
npm ci
npx --no-install playwright install --with-deps chromium
npm run verify
```

Build before running standalone `npm run check` or `npm test`. Consumers resolve emitted package exports in dependency order.

Read [architecture boundaries](docs/architecture/boundaries.md), [Apple qualification](docs/architecture/apple-qualification.md), and [Switchboard artifact provenance](vendor/README.md).

Linux CI runs the same package checks and browser fixtures with the pinned toolchain.
Apple application builds remain separate.

Read the [default theme and primitives](docs/design/theme.md) and [T3 Code design findings](docs/design/t3-code.md).
Run `npm run preview:theme` after building to inspect the local visual fixture.
