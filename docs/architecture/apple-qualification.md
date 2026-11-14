# Apple qualification

All GitHub Actions jobs use Linux runners.
Native macOS and iOS compilation, signing, installation, and device checks run outside Actions.

The desktop has a Tauri Rust project and mounted React shell. Its [local macOS bundle qualification](../qualification/desktop-macos.md) is separate from distribution signing and host integration. The iOS product has a committed Xcode project and mounts its React Native shell in an embedded Release bundle. The [iOS packaging guide](../qualification/ios-app.md) covers simulator preparation, build, installation, and relaunch. Physical-device signing and distribution are not qualified.
The independent [iOS update probe](../qualification/ios-updates.md) qualifies simulator rebuild and reinstall with an embedded Release bundle.
It does not qualify the integrated app, live updates, physical-device signing, or VoiceOver.
The product's package builds verify separate real platform declarations.
A successful TypeScript build does not prove native application functionality.

Later platform tasks must provide reproducible Apple-machine commands.
Record source revision, Node, npm, Xcode, macOS, native dependencies, signing method, and device or simulator identity.

Full desktop qualification must exercise connection, recovery, and client lifecycle. The packaging slice qualifies native launch and shell controls only. Connection and credential handling remain pending.
Full iOS qualification must install a developer build and exercise pairing, reconnect, pending decisions, and shared conversations. The packaging slice provides a disconnected screen and does not qualify those flows.
Native-incompatible customization must report rebuild-required.
Client disconnects and UI replacement must preserve the authoritative run.
