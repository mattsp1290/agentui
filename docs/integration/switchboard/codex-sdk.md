# Codex SDK subscription chat

The `codex-sdk` host mode uses Switchboard's public `./codex` adapter and the
official `@openai/codex-sdk` 0.169.0 package. It fixes the model to
`gpt-6.1-sol` and uses ChatGPT subscription authentication. The
[startup guide](../../development/codex-sdk-host.md) describes login.

## Ownership

Switchboard owns native SDK creation, account checks, thread start and resume,
message normalization, cancellation, and child-process cleanup. AgentUI does
not launch an alternative native transport or implement a model loop.

AgentUI owns authorization, command receipts, saved conversation bindings,
transcript replay and restart recovery. It passes a native thread identifier
back to Switchboard only from the private saved run of that conversation.
A separate installation and runtime format prevent accidental resumption of
existing app-server conversations through this SDK route.

The native SDK runs with a read-only sandbox and no interactive approval prompts.
This does not promise that every native local-read tool is absent. AgentUI does
not display SDK tool activity or support tool approval continuations in this
mode.

The native SDK emits completed assistant message items. It does not provide
individual text-token updates through this execution interface. The UI displays
those messages as they arrive. Stop interrupts the native request. A completed
send receipt acknowledges admission of a native turn, rather than successful
completion of the model response. Interrupted host runs are sealed during
restart recovery and never replayed automatically.

## Verification

The opt-in `tests/application/codex-sdk-live.test.mjs` drives the bundled host
through its browser. It checks a first response, follow-up memory,
browser reload, host restart with native thread continuity, Stop, and the saved
interrupted outcome. An invalid API key in the host environment detects an
accidental API-key fallback. The test checks that this sentinel does not reach
saved host files or browser storage.

Run the journey with the pinned toolchain and an existing ChatGPT login:

```sh
npm run build
AGENTUI_CODEX_SDK_LIVE=1 node --test tests/application/codex-sdk-live.test.mjs
```

This bounded route does not qualify interactive approvals, external session
adoption, LiteLLM, native extensions, attachments, or iOS execution. The broader
session integration and provider registration beans remain open.
