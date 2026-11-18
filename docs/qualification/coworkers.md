# Coworkers extension qualification

The `extensions/coworkers` extension connects AgentUI to a crabber-coworkers service through its v1 HTTP API, pinned at upstream revision `44ed2ad8326a4822a67a3eeca4087cfc98f03df8` (`extensions/coworkers/openapi/REVISION`). It lists the configured coworkers, creates AgentUI-owned conversations with them and receives replies by polling, because upstream has no event stream yet.

## Controlled evidence

- `extensions/coworkers/tests/contract.test.mjs` validates every fake response the tests use against the vendored `openapi/crabber-coworkers.v1.json`, and checks that `REVISION`, the API version and the request contract match the client constants.
- `extensions/coworkers/tests/provider.test.mjs` runs the built package as an installed entry through the host's real credential authority: a wrong request contract and a rejected token, discovery, idempotent creation, a polled reply, cancel, `failed` and `uncertain` outcomes, a lost submit reply whose read returns `404` before the send commits, a service outage during a running turn, `close`, and a 100-request window at the maximum stored text size.
- `extensions/coworkers/tests/poller.test.mjs` checks the scheduler with a fake clock: 50 idle conversations settle at or below 50 reads per 300 seconds, at most 4 requests are in flight, failures back off to 300 seconds, and `wake` polls at once.
- The provider conformance suite (`tests/extensions/providers/conformance`) runs a `Coworkers` row. Cases declared not applicable: decisions (the service has none) and the dropped-stream case (a polling feed has no stream; it ends only on close or when the conversation is gone).

## Live qualification

Not run. Running `crabber-coworkers serve` needs a configured coworker backed by a model the implementing session could not provide, so listing coworkers and one chat turn against a real service at `44ed2ad8326a4822a67a3eeca4087cfc98f03df8` remain unverified live.
