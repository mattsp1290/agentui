# Choose an agent for each chat

Build the app, then save an agent configuration file with paths for your host:

```json
{
  "version": 1,
  "default": "codex",
  "agents": [
    { "name": "codex", "kind": "codex", "workspace": "/absolute/project", "executable": "/absolute/codex-0.167.2/bin/codex" },
    { "name": "sol", "kind": "codex-sdk", "workspace": "/absolute/project", "executable": "/absolute/codex-0.169.0/bin/codex" },
    { "name": "sonnet", "kind": "claude-sdk", "model": "sonnet", "workspace": "/absolute/project" },
    { "name": "pi", "kind": "pi", "workspace": "/absolute/project" }
  ]
}
```

Use unique names and set `default` to one of them. Claude also accepts `"model": "opus"`. The other kinds use their existing fixed models. Omit entries you do not want. Keep keys out of this file. Claude reads `AGENTUI_ANTHROPIC_API_KEY`; Pi reads `OPENCODE_GO_API_KEY`. Codex uses its ordinary CLI login. An optional `executable` selects the exact Codex or Claude binary; omitting it uses the runtime's existing discovery.

```sh
node apps/host/dist/main.js serve --config /absolute/agents.json --data-dir /absolute/private/agentui --port 7140
```

Open the printed address with `/browser.html` appended and pair with the ordinary `invite` command. Choose **Agent for new chat**, then **New conversation**. Each saved chat keeps its original agent, controls, and draft. Changing this selector affects only new chats.

An agent that cannot start appears as unavailable. If the default is unavailable, select another available agent explicitly. Removed agents leave readable history with commands disabled. Restore the same workspace, model, and native runtime to continue their chats. Keep the same data directory when moving from a single-agent command to this configuration.

A creation whose reply was lost keeps its original chat and agent. **Recover creation** checks that saved choice. For an older pending creation without a saved agent, recovery first checks for the existing chat. If absent, select **Agent for pending creation** explicitly and recover again.

The `codex`, `codex-sdk`, `claude-sdk`, `pi`, and `browser-dev` commands remain available. The Codex and Claude shortcuts also accept `--executable /absolute/path`. This setup does not replace global CLI installations or change native login.

Provider-only hosts can run `node apps/host/dist/main.js serve --extensions /absolute/extensions.json --data-dir /absolute/private/agentui`. Add `--trusted` for trusted browser access. See the [server extension guide](../architecture/extension-sdk.md#select-server-extensions-with-the-cli) for the selection file. The host chooses the ready provider with the smallest stable ID from each current catalog. With no ready providers it has no default, disables creation, and keeps saved conversations readable.
