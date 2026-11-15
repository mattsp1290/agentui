# Chat with Opus or Sonnet through the Claude SDK

This host mode runs text conversations through Switchboard and the Claude Agent
SDK. Each host uses either Opus or Sonnet. The host keeps the API key and native
session IDs private.

Use the repository's pinned Node and npm versions. Install and build the project:

```sh
npm ci
npm run build
```

Export `AGENTUI_ANTHROPIC_API_KEY` in your host environment. If your shell profile
already exports it, load that profile:

```sh
source ~/.profile
```

Start an Opus host with a private data directory and an existing workspace:

```sh
node apps/host/dist/main.js claude-sdk --model opus --data-dir "$HOME/.local/share/agentui-opus" --workspace "$PWD" --port 7140
```

Open the printed loopback origin with `/browser.html` appended. In another
terminal, create a pairing code:

```sh
node apps/host/dist/main.js invite --data-dir "$HOME/.local/share/agentui-opus"
```

Enter that code, pair the host, and choose **New conversation**. Send a message.
Send a follow-up to continue the same native session. Reloading the browser or
restarting the host with the same model and directories preserves the
conversation. Use **Stop** to interrupt a response.

To run Sonnet, start another host with `--model sonnet`, a separate data
directory, and a free port. Use its printed origin and its own pairing code.
The browser identifies the selected family. The native SDK resolves the family
alias, and command evidence records the model observed in the native response.

The SDK is bundled as a pinned dependency. This route requires the host API key
and does not use a Claude subscription login. Conversations belong to their
original model and workspace. Keep the same directories when restarting a host.

This mode provides text chat without tools or interactive approvals. It does
not load workspace settings, user hooks, skills, or MCP servers. The host does
not expand file mentions or dispatch slash commands from message text.

For ownership and verification limits, read the
[Claude integration record](../integration/switchboard/claude.md).
