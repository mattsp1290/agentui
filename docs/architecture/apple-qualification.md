# Apple qualification

All GitHub Actions jobs use Linux runners.
Native macOS and iOS compilation, signing, installation, and device checks run outside Actions.

The product has no Tauri Rust project, Xcode project, Metro bundle, signing setup, or mounted application.
The independent [iOS update probe](../qualification/ios-updates.md) qualifies simulator rebuild and reinstall with an embedded Release bundle.
It does not qualify the integrated app, live updates, physical-device signing, or VoiceOver.
The product's package builds verify separate real platform declarations.
A successful TypeScript build does not prove native application functionality.

Later platform tasks must provide reproducible Apple-machine commands.
Record source revision, Node, npm, Xcode, macOS, native dependencies, signing method, and device or simulator identity.

Desktop qualification must launch Tauri and exercise connection, recovery, and client lifecycle.
iOS qualification must install a developer build and exercise pairing, reconnect, pending decisions, and shared conversations.
Native-incompatible customization must report rebuild-required.
Client disconnects and UI replacement must preserve the authoritative run.
