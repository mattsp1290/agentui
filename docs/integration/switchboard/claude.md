# Claude SDK text chat

The `claude-sdk` host mode consumes Switchboard's public `./claude` adapter and
`@anthropic-ai/claude-agent-sdk` 0.3.323. The
[native package pin](../../../vendor/switchboard-claude.json) records the exact
Switchboard source and artifact digest. It supports the `opus` and `sonnet`
family selectors. The [startup guide](../../development/claude-sdk-host.md)
describes credentials and model selection.

## Ownership

Switchboard owns native SDK queries, credential mapping, private native session
storage, session resume, assistant message normalization, cancellation, and
child-process cleanup. Its public declarations do not expose native SDK types.
It starts one native query for each user turn and resumes only the native
session ID supplied by AgentUI's private run record.

AgentUI owns authorization, command receipts, installation bindings, transcript
writes, browser replay, and restart recovery. Codex and Claude share the SDK
chat driver that handles these host responsibilities. Model families have
distinct installation bindings and native storage directories. Native IDs and
credentials do not appear in browser conversation events.

The host reads only `AGENTUI_ANTHROPIC_API_KEY` for Claude authentication. It
passes the credential in memory to Switchboard, which maps it to the native
SDK's `ANTHROPIC_API_KEY`. Ambient provider authentication and routing settings
are excluded from the child environment.

A completed send receipt acknowledges native turn admission. It does not mean
the response finished successfully. Stop waits for native cancellation and
cleanup. Restart recovery seals incomplete output without automatically
repeating a model request. Missing or mismatched saved sessions fail rather
than creating replacement conversations.

## Verification

The opt-in `tests/application/claude-sdk-live.test.mjs` runs the browser
journey separately for Opus and Sonnet. Each journey checks a first response,
random follow-up memory, browser reload, host restart, private native session
continuity, Stop, and the saved interrupted outcome. It scans host files and
browser storage for the actual provider credential. Safe reports record the
requested model family and the native model observed in command evidence.

Run both journeys after loading the host credential and building the project:

```sh
source ~/.profile
npm run build
AGENTUI_CLAUDE_SDK_LIVE=1 node --test tests/application/claude-sdk-live.test.mjs
```

Set `AGENTUI_CLAUDE_SDK_EVIDENCE_DIR` to retain per-model reports and screenshots.
The default test suite skips live paid-provider calls.

The existing GPT subscription journey remains independently available in
`tests/application/codex-sdk-live.test.mjs`. Claude authentication does not
qualify GPT subscription authentication, or the reverse.

## Remaining qualification

This bounded route does not qualify external session discovery, interactive
tool approvals, LiteLLM, renewable credentials, attachments, native extension
hooks, or iOS execution. The broader Claude integration and provider
registration beans remain open. The live journey reports record exact built artifact identities and the native
model IDs observed during each run.

The Claude SDK requires the MCP SDK as a peer dependency even though this route
disables MCP servers. AgentUI does not import that peer in its host chat code.
The lockfile records the installed peer versions. The artifact pin records and
tests the peer versions resolved from the Claude SDK's own location, including
shared dependencies used by the other providers.
