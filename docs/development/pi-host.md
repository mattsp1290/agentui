# Chat with GLM 5.3 through OpenCode Go

Use your OpenCode Go subscription key with the Pi SDK host. This host uses Pi 1.5.2 with provider `opencode-go` and model `glm-5.3`. It provides text chat without tools, commands, or file access.

Use Node 24.22.3 and npm 11.19.1. From the repository root, build the host and browser app.

```sh
npm ci
npm run build
```

Set `OPENCODE_GO_API_KEY` in the host process environment through your shell or secret manager. Keep the key out of command arguments, browser forms, and repository files. The host refuses to start if this variable is missing or empty.

Start the host with an existing workspace directory. Reserve a private data directory for Pi conversations.

```sh
node apps/host/dist/main.js pi \
	--workspace /absolute/path/to/your/project \
	--data-dir "$HOME/.local/share/agentui-pi" \
	--port 7140
```

The workspace identifies this host's conversations. Pi does not read the workspace or run tools in this mode. The host prints its local origin and host ID when ready. Keep this process running.

Open [the local app](http://127.0.0.1:7140/browser.html). On macOS, you can open the same host in the desktop app from another terminal.

```sh
./agentui --host-url http://127.0.0.1:7140/browser.html
```

The desktop landing page's **Connect to local Codex** button opens this same address. It connects to the provider already running there. The connected app identifies this host as **Pi · GLM 5.3 · OpenCode Go**.

Request a pairing code from another terminal.

```sh
node apps/host/dist/main.js invite \
	--data-dir "$HOME/.local/share/agentui-pi"
```

Copy `value.code` into **Pairing code**, then select **Pair host**. Each code works once and expires. Request another if needed. Existing native clients use the same host through `invite-native` and its native endpoint.

Select **New conversation**, write a message, and select **Send**. Replies stream into the conversation. Wait for the reply to finish before sending a follow-up. To interrupt a reply, select **Stop**. The partial reply stays in history, and the follow-up draft stays in the composer.

Close the host with Ctrl+C. Restart with the same workspace, data directory, port, and environment variable to continue saved conversations. After an unexpected stop, the host marks unfinished output as interrupted. Drafts stay in the browser. The host stores conversation history and Pi session files under its private data directory, with Pi sessions in `pi-sessions`. The API key stays in host memory and is excluded from app metadata and saved conversations.

Use separate data directories for Pi, Codex, and recorded demonstrations. Keep the host data directory private because its conversation history contains your messages and replies.

Run the opt-in integration test with the same environment variable already exported.
It starts a disposable bundled host and browser, sends real subscription requests,
checks follow-up and restart memory, then interrupts a streamed response.

```sh
AGENTUI_PI_LIVE=1 node --test tests/application/pi-live.test.mjs
```
