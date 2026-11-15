# Chat with Sol through your Codex subscription

This mode runs GPT 6.1 Sol through the native Codex SDK and your ChatGPT login.
The host keeps its conversation mapping private. The browser receives completed assistant messages and saved transcript events.
This SDK does not emit individual text tokens.

Use the repository's pinned Node and npm versions. Install and build the project:

```sh
npm ci
npm run build
```

Install Codex CLI 0.169.0 and make `codex` available on your host PATH.
Check its version and your native login:

```sh
codex --version
codex login status
```

If you are signed out, run `codex login` and complete the browser login. Start
the host with a private data directory and an existing workspace:

```sh
node apps/host/dist/main.js codex-sdk --data-dir "$HOME/.local/share/agentui-sol" --workspace "$PWD" --port 7140
```

Open the printed loopback origin with `/browser.html` appended. In another
terminal, create a pairing code:

```sh
node apps/host/dist/main.js invite --data-dir "$HOME/.local/share/agentui-sol"
```

Enter that code, pair the host, and choose **New conversation**. Send a message.
Send a follow-up to continue the same native thread. Reloading the browser or
restarting the host with the same directories preserves that conversation.
Use **Stop** to interrupt a response and retain completed messages already received.

This mode fixes the model to `gpt-6.1-sol` and requires ChatGPT authentication.
It does not fall back to an API key. Existing `codex` mode uses the separate
app-server integration for interactive tool approvals. Saved conversations
belong to their original runtime and are not interchangeable between modes.

For the ownership boundaries and verification limits, read the
[SDK integration record](../integration/switchboard/codex-sdk.md).

If Codex can no longer reopen a saved native thread, choose **New conversation**.
AgentUI preserves the old transcript and never silently replaces its native
thread. If the account or CLI changes while the host is running, check
`codex --version` and `codex login status`, then restart the host.
