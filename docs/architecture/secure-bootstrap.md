# Secure harness and credential setup

AgentUI should let a fresh Mac install Pi, Claude, or Codex on itself or a Linux target and configure provider credentials. Neither machine needs an existing provider login. The private Tailscale or NetBird network supplies the access boundary. The design concentrates on encrypted transport, encrypted persistence, and provider refresh ownership.

The first delivery supplies an install-only command and a public secret-provider interface. Launcher-managed Pi now also has a separate bundled Mac setup window that stores a static OpenCode Go key in Keychain and delivers it to the running host. Provider-native subscription login and encrypted Linux persistence remain open. Beans task `agentui-w4wf` tracks the broader onboarding work.

## Keep three responsibilities separate

The Mac orchestrates target setup. The selected target installs and runs the harness. A secret provider supplies static API keys or tokens to trusted host code. Native harnesses retain responsibility for their own login and refresh state.

Remote setup and chat use SSH with ordinary host-key verification. The service stays on target loopback. Provider and external-vault connections use their own verified HTTPS connections. No extra AgentUI user-account system is needed for this deployment.

The eventual setup flow is as follows.

1. Select a local or SSH target and the harness to install.
2. Install the compatible harness without checking provider login.
3. Select a supported credential source and establish that its encrypted storage is usable.
4. Collect a static key through native setup, or complete the target harness's provider login in the Mac browser.
5. Confirm credential readiness separately from installation success.
6. Start the target runtime with only the credential source it needs.

The native setup controls belong outside customizable chat content. The launcher opens host-served chat through `--host-url`. That document has no native Keychain command authority. Pi setup opens a separate bundled document with a distinct window identity and a narrowly scoped native command. Its Keychain record is separate from pairing credentials. A per-launch capability admits delivery to a fixed loopback host endpoint. SSH launches use the existing tunnel. The host keeps the delivered key in memory. It does not persist it on the target.

## Let the target own subscription refresh

Codex on the selected target owns its login and all refresh updates. Prefer the provider's supported device-login flow for a headless target. The Mac browser authorizes the target login. AgentUI does not need the user's provider password. A forwarded localhost callback is an alternative when device login is unavailable. See [Codex authentication](https://learn.chatgpt.com/docs/auth).

Do not synchronize copies of `auth.json` between Mac and Linux. A target can rotate a refresh token and crash before copying it back. A watcher or shutdown export adds the same persistence gap. A process lease prevents concurrent cooperating writers but cannot make provider refresh and a remote Keychain update atomic.

An encrypted keyring or encrypted writable filesystem must persist the native provider's writes directly. The qualified storage must include temporary sibling files used for atomic replacement. AgentUI must not claim that periodically encrypting a plaintext runtime directory makes token refresh crash-safe.

The launcher pins Codex app-server 0.167.2. The separate SDK mode pins 0.169.0. The exact [0.167.2 login schema](https://raw.githubusercontent.com/openai/codex/rust-v0.167.2/codex-rs/app-server-protocol/schema/json/v2/LoginAccountParams.json) marks externally supplied ChatGPT tokens internal-only and unstable. Current [app-server documentation](https://learn.chatgpt.com/docs/app-server) describes an experimental external-token flow, but that does not establish a supported integration for these pinned modes. An AgentUI-owned subscription refresh broker is outside the first design.

## Choose a storage backend that proves its protection

On macOS, Keychain is the intended default for static secrets and any separate target unlock key. The existing native credential work documents unresolved signing, upgrade, and Keychain-access qualification. Those limits also matter to a future provider-secret adapter.

On headless Linux, two candidates remain open.

- A qualified password-encrypted Secret Service backend can support Codex's strict keyring mode. Its unlock secret stays on the Mac or in separately protected recovery material. A bus or an API named keyring alone does not prove encrypted persistence.
- A qualified encrypted filesystem can hold the provider's writable credential directory. The provider writes through that filesystem, including its atomic replacements. A Mac-held unlock key separates the server's ciphertext backups from the key needed to open them.

Codex's strict `keyring` mode fails when its backend is unavailable. Its `auto` mode can fall back to a plaintext auth file. A secure setup must select a qualified backend explicitly and remain locked or unavailable when its prerequisites fail. The exact behavior is visible in the [pinned auth storage implementation](https://raw.githubusercontent.com/openai/codex/rust-v0.167.2/codex-rs/login/src/auth/storage.rs).

Selecting strict keyring mode does not prove that earlier plaintext copies are gone. The pinned implementation can warn when cleanup of an old fallback file fails. Qualification must inspect migration remnants as well as new writes.

An encrypted Linux backend has not been exercised by this delivery. No provider secret should be accepted on the strength of this design document alone.

Protection covers retained credentials and network traffic. A running host or harness must access the plaintext it uses. The design does not isolate secrets from a compromised process running as the host user or as root.

Disk qualification must also cover swap, hibernation, dumps, logs, temporary files, and backups. [Linux tmpfs](https://docs.kernel.org/filesystems/tmpfs.html) can swap. A runtime directory under `/run` is not evidence that plaintext never reaches a disk. Ordinary file deletion does not remove historical backup copies. Forgetting local material and revoking provider access are separate operations.

Reboot leaves a Mac-unlocked target store locked. Unattended restart requires another key source, such as separately qualified hardware-backed or external-vault access. Storing an unlock key next to ciphertext does not protect a stolen image containing both. [Systemd credentials](https://systemd.io/CREDENTIALS/) can supply static keys or an unlock input, but loaded credentials are immutable during a service run. They are not a mutable OAuth cache.

## Keep the secret-provider interface small

The first consumer is the existing host-side `ProviderInstallation.authentication.resolve` callback. It needs one string when the host admits a provider operation. It does not need a vault administrator, a browser credential record, or a generic OAuth lifecycle.

The public `SecretProvider` contract lets another user implement that read through their own backend client. The adapter owns backend-specific references and bootstrap identity. A host helper converts the provider into the existing resolver with fixed errors and validation. See the [secret-provider reference](secret-providers.md) for the delivered API and example.

Keep three categories distinct.

| Category | Example | Owner |
| --- | --- | --- |
| Backend configuration | Vault URL, Kubernetes namespace, Azure vault name | Operator configuration |
| Backend bootstrap identity | Workload identity, service-account identity, Vault token | Adapter construction and platform identity |
| Managed provider secret | Anthropic API key, OpenCode Go key | Selected secret backend |

Fetching the only Vault token from the same locked Vault is circular. A fresh installation still needs an independent identity or interactive unlock for the selected backend. The interface does not manufacture that identity.

References contain lookup metadata, never bearer credentials. Adapter exceptions can contain URLs or secret payloads, so host-facing failures use fixed safe text. Provider objects and secret values stay in trusted host code. Existing credential handles and grant metadata remain separate from the actual values.

Read support does not imply write, delete, leases, version-conditional replacement, or provider-native OAuth storage. Add those capabilities when there is an actual caller and a backend can enforce their semantics. An installation's admitted credential revision is not the backend's token-rotation version.

Kubernetes, Azure Key Vault, and HashiCorp Vault are intended adapter targets, not bundled integrations in this slice. An adapter name cannot establish encryption or backup guarantees. [Kubernetes documents](https://kubernetes.io/docs/concepts/configuration/secret/) that Secret objects are unencrypted in etcd by default. Base64 is encoding. Azure and Vault integrations also require their own authenticated clients and verified connections. See [Azure Key Vault security](https://learn.microsoft.com/en-us/azure/key-vault/general/secure-key-vault) and the [Vault security model](https://developer.hashicorp.com/vault/docs/internals/security).

## Architecture debate and decision

Three independent advocates examined the source and challenged each other's ownership proposals. All used the available inherited model. This was independent argument, not a claim of review across different model families.

The evaluation used five criteria.

| Criterion | Target-owned credentials | Mac-owned session delivery | Encrypted target vault |
| --- | --- | --- | --- |
| Concrete disk protection | Requires a qualified native backend | Keychain protects durable static keys. Linux copies still need memory and dump controls | Separates ciphertext and unlock key. Requires a real backend |
| Native refresh correctness | Keeps refresh with its native writer | Copy-back can lose refresh updates. External broker is not established | Direct encrypted filesystem writes can preserve the native writer. Watchers cannot |
| Fresh setup | Install first, then native login | Install first, then resolve and inject a key | Install storage dependencies before native login |
| Extension fit | Native auth storage differs from string reads | Direct static-secret reader fits the current seam | Read adapters fit static keys. Mutable auth needs a separate contract |
| Maintenance cost | Smallest subscription integration once storage is qualified | Smallest connected-session API-key flow | Mounting, unlocking, crash recovery, and backup behavior add work |

Use target ownership as the base for native login. Retain Mac Keychain session delivery as an option for static keys. Allow encrypted filesystems as storage implementations rather than requiring every user to operate a vault service. Reject copied OAuth caches and generic CRUD promises that conceal refresh durability.

For the first public interface, choose a direct reader over an operation-bound `use` callback. The current host already owns the admitted use boundary. A callback requires a broader refactor and JavaScript still permits retaining the returned string. A richer status or mutation API can follow a concrete consumer.

## Delivery and qualification

The first slice installs actual standalone harness CLIs from the Mac launcher and publishes the host secret-reader extension point. Installing Pi or Claude CLI does not switch the existing embedded SDK integrations to those executables. Normal chat launch remains a separate operation.

The work is tracked in Beans.

| Task | Outcome |
| --- | --- |
| `agentui-mebs` | Architecture investigation and competing ownership designs |
| `agentui-zbty` | Install compatible harnesses locally or through SSH without login |
| `agentui-vhvj` | Public host secret-provider read contract and existing-authority integration |
| `agentui-739j` | Concrete headless Linux encrypted-store implementation and qualification |
| `agentui-w4wf` | Native credential entry, actual encrypted persistence, login, and recovery qualification |

Before closing the remaining onboarding task, exercise fresh targets, locked and unavailable stores, signing changes, provider refresh across process death, concurrent native writers, Linux reboot, Mac replacement, and no plaintext fallback. Inspect synthetic markers in database, logs, filesystem snapshots, and backups. Revalidate provider-native behavior against the exact installed versions.

Laziness Protocol kept token refresh in the native harness. Model the Domain separated installation, static-secret reads, and native login ownership. Make Operations Idempotent shaped staged repeatable installation. Boundary Discipline placed external-secret validation and safe errors at the host boundary. Prove It Works keeps the Linux encryption and login claims open until actual target evidence exists.
