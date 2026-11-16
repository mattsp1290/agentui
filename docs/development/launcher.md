# Run AgentUI locally or over SSH

Run these commands on the Mac where you want the desktop client. Install the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) first. Make Node.js, npm, and SSH available.

## Install a harness before signing in

To install a standalone harness on this machine, run one of these commands:

```sh
./agentui setup --agent codex
./agentui setup --agent pi
./agentui setup --agent claude
```

To install on an SSH target, add its destination:

```sh
./agentui setup --agent codex --ssh user@host
```

Setup supports macOS and Linux on ARM64 or x64. SSH must already connect without an interactive password prompt. Normal SSH host-key verification remains enabled. Setup uses the repository's pinned Node runtime on the client, but it does not need `npm ci`, application build artifacts, or provider credentials.

Setup installs a matching Node runtime when needed, verifies a new Node archive against its recorded SHA-256 digest, and installs the selected harness under `~/.local/share/agentui/tools`. It disables npm lifecycle scripts and uses private npm configuration files. For Claude, setup verifies the selected native package and links its executable without running the package's installer script. A completed installation publishes atomically. Repeating setup reuses a harness that passes its package and executable version checks. A failed install does not replace an existing published harness.

The command prints an `installed` JSON record with the executable path and version. Its `authentication` field is `not-checked`. Setup does not start the host, open the client, or sign in to a provider. It does not change global tools or shell profiles.

Codex follows the app-server runtime pin. Pi follows the coding-agent package pin. Claude CLI 2.1.323 is explicitly mapped to Claude SDK 0.3.323 and checked against that SDK's `claudeCodeVersion` during verification. Updating that SDK requires reviewing the CLI mapping. Top-level harness versions are pinned. Their fresh npm dependency graphs are not frozen by a checked-in per-harness lockfile.

Installing a CLI does not change the current chat integration. Pi chat uses the bundled SDK, so a global `pi` installation is not required. Claude chat uses the separate Claude SDK host entry. The normal launcher offers Codex and Pi. The Mac app includes protected OpenCode Go key entry and Keychain storage. Provider login and Linux encrypted storage remain separate work.

## Start a local workspace

From the AgentUI repository, run:

```sh
./agentui
```

The launcher builds the host and client, starts the host in your current directory, and opens the conversation UI. Select **New conversation** and send a message. Keep the launcher terminal running. Press Ctrl+C to stop its host and connection.

To choose a different workspace, pass its absolute path:

```sh
./agentui --workspace /Users/punk1290/git/your-project
```

Codex is the default agent. It uses the selected host user's existing Codex login. The launcher provisions a private compatible Codex CLI without replacing the global installation. Pi also appears in the harness picker, with setup guidance when its key is missing. If Codex reports missing credentials, sign in to Codex on that machine and launch again.

## Start a remote workspace

Check that SSH can connect without an interactive password prompt:

```sh
ssh lunus@100.102.195.3
```

Exit that SSH session, then start AgentUI on your Mac:

```sh
./agentui --ssh lunus@100.102.195.3
```

To use either Linux example machine, run:

```sh
./agentui --ssh infra-admin@100.82.43.93
./agentui --ssh punk1290@100.69.236.34
```

The launcher inspects the target's operating system and architecture. It provisions private runtime tools and uploads the built host and browser assets. The host listens on remote loopback. An SSH tunnel connects the local client to it.

The remote workspace defaults to the remote user's home directory. To choose a project, provide a path that exists on the remote machine:

```sh
./agentui --ssh infra-admin@100.82.43.93 \
	--workspace /home/infra-admin/git/your-project
```

The host runs the agent and keeps its conversation history on that machine. AgentUI does not copy or synchronize project files. The agent uses that machine's provider credentials.

## Select Pi with GLM 5.3

To start with Pi only, run one of these commands. No key is required to open setup.

```sh
./agentui --agent pi
./agentui --ssh infra-admin@100.82.43.93 --agent pi
```

Pi uses provider `opencode-go` and model `glm-5.3`. It supports streamed text, follow-ups, saved sessions, and Stop. This mode has no tools or file access. It does not install or launch the Codex CLI.

In the Mac app, choose **Pi** in the harness picker, then select **Open secure Pi setup** in Settings. The separate app-owned window accepts your OpenCode Go API key. Select **Save in Keychain and connect**. Return to chat and select **Reconnect** to refresh the harness choices.

The key stays out of the chat page, browser storage, conversation database, URLs, command arguments, and logs. A dedicated macOS Keychain record stores it for the selected launcher profile. On a later launch, open setup and select **Connect saved key**. Locked or denied Keychain access produces an error without a plaintext fallback. Rebuilding or changing the app's signature can require new Keychain authorization.

Setup readiness means the host has a configured key. It does not validate your subscription with a paid request. The provider can still reject a chat request because the key is invalid, its limits are exhausted, or the service is unavailable.

An exported `OPENCODE_GO_API_KEY` takes precedence at host startup. To replace it with a saved Keychain key, remove or update the variable in the launcher terminal and, for SSH, on the selected host. Close AgentUI, launch it again, open protected setup, and select **Connect saved key**. Saving a different key while Pi is active keeps the new key in Keychain and asks you to restart. It does not interrupt active conversations.

Protected setup requires the launcher-managed Mac app. Browser-only users can set `OPENCODE_GO_API_KEY` through their shell or secret manager. Keep its value out of command arguments and repository files. The manually managed `main.js pi` command still requires this variable before startup.

For SSH launches, the remote host uses its exported `OPENCODE_GO_API_KEY` when present. Otherwise, the launcher forwards the local variable through the SSH session in memory. It does not save the key on the remote machine.

## Reopen your conversations

Run the same command with the same target, agent, and workspace. The launcher reuses the host data directory and local client origin. Open a saved conversation to continue it. Closing or reconnecting the client does not automatically resend commands.

The launcher stores its tools separately from conversation data. Rebuilding the app preserves saved history. Existing manual hosts and their data directories remain separate from launcher-managed hosts.

## Resolve startup failures

If SSH cannot connect, verify the destination and your network connection. Resolve SSH authentication or host-key prompts with an ordinary SSH session before relaunching.

If a port is already in use, stop the launcher using that port or choose another port:

```sh
./agentui --ssh infra-admin@100.82.43.93 --port 7250
```

Use the same chosen port on later launches to keep the same client origin and local drafts. The launcher uses that port on both ends of the tunnel.

For a missing Pi key, open **Settings**, then **Open secure Pi setup** in the Mac app. If setup cannot reach the host, check that the launcher terminal is still running and the SSH connection is active. If the Pi runtime is unavailable, rebuild with `./agentui` and retry. AgentUI pairing codes are not required by the launcher.

## Verify local and remote chat

Build the application with `./agentui`, then stop it before running the verifier. Install the browser used by the verifier if needed:

```sh
npm run setup:browser
```

With your OpenCode Go key available to the launcher, run:

```sh
node scripts/verify-agentui-launch.mjs
```

The verifier runs Pi with GLM 5.3 on the local Mac and all three example SSH machines. It creates a real conversation, waits for a completed reply, sends a follow-up, restarts the launcher, and reopens the saved conversation in a fresh browser context. It verifies that both replies survived and that no pairing form or cookie appeared. It then asks Pi to recall the first token, so the check also exercises the saved provider session after restart. These checks send subscription requests and leave their verification chats in history.

To check one target, run:

```sh
node scripts/verify-agentui-launch.mjs --target local
node scripts/verify-agentui-launch.mjs --target lunus@100.102.195.3
```

Results, screenshots, and launcher logs go to `.audit/single-user-launch/live`. A target that fails any step is reported as `NOT VERIFIED` and makes the verifier exit unsuccessfully.

To start the same host without opening a desktop window, use `--no-open`. The launcher prints a readiness record containing the client URL and stays running. `--skip-build` reuses existing build artifacts for repeated checks.
