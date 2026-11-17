# Run the local Codex app

For automatic local or SSH setup without pairing, use [the desktop launcher](launcher.md). The instructions below run an independently managed host that the browser reaches directly.

Install Codex CLI 0.167.2 and sign in with `codex login` before starting the host. Check the installed version with `codex --version`.

From the repository root, build the host and browser app.

```sh
npm ci
npm run build
```

Start the host with an existing workspace directory. Use a private data directory reserved for Codex conversations, separate from recorded demonstrations.

```sh
node apps/host/dist/main.js codex \
	--workspace /absolute/path/to/your/project \
	--data-dir "$HOME/.local/share/agentui-codex" \
	--port 7140
```

On macOS, open this host in the desktop app from another terminal. Keep the host running.

```sh
./agentui --host-url http://127.0.0.1:7140/browser.html
```

The desktop window uses the local host's app screens. It grants the page no native commands. Native startup for this option still needs a macOS smoke test. You can also use [the local app](http://127.0.0.1:7140/browser.html) in a browser.

There is no pairing step. The host admits every client that reaches it over loopback or your private overlay as its single owner, after checking the Host, Origin and content-type headers. It uses your existing Codex CLI login without copying its credentials.

Select **New conversation**, write a message, and select **Send**. The host runs Codex in the workspace you selected. It starts with a read-only sandbox and requests explicit approval for commands or file changes that require more access. Inspect each request, then select **Allow** or **Deny**. Replies stream into the conversation while approval controls remain available.

Close the host with Ctrl+C. Restart with the same workspace, data directory, and port to reopen stored conversations. Drafts stay in the browser, and the host stores conversation history and Codex session references in its private data directory.

Before updating the native host, stop it and copy its entire private data directory to a separate backup location. The current build can open older message-only histories. Its first write to a conversation, including a new conversation or a rejected send, stores state that older builds cannot read. To roll back, restore the stopped-host backup and use its matching build. Keep the backup private because it contains conversation history.

To run the recorded demonstration, use the existing `browser-dev` command with a different data directory. The `codex` command fails with an installation instruction if Codex is missing or its version differs from 0.167.2.
