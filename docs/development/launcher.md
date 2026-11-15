# Run AgentUI locally or over SSH

Run these commands on the Mac where you want the desktop client. Install the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) first. Make Node.js, npm, and SSH available.

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

Codex is the default agent. It uses the selected host user's existing Codex login. The launcher provisions a private compatible Codex CLI without replacing the global installation. If the host reports missing provider credentials, sign in to Codex on that machine and launch again.

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

Set `OPENCODE_GO_API_KEY` through your shell or secret manager. Keep its value out of command arguments and repository files.

```sh
./agentui --agent pi
./agentui --ssh infra-admin@100.82.43.93 --agent pi
```

Pi uses provider `opencode-go` and model `glm-5.3`. It supports streamed text, follow-ups, saved sessions, and Stop. This mode has no tools or file access. It does not install or launch the Codex CLI.

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

If a provider reports missing credentials, configure the provider on the selected host. AgentUI pairing codes and Keychain access are not part of this launcher flow.

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
