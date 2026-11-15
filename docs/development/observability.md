# Export host request traces

The host can export OpenTelemetry request spans and observed native agent runs to an OTLP HTTP receiver. Tracing is off by default. Enable it in the environment of a serving command such as `browser-dev`, `serve`, or `codex-sdk`.

After building the repository, start a host with a local Collector:

```sh
OTEL_TRACES_EXPORTER=otlp \
OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318 \
node apps/host/dist/main.js browser-dev --data-dir /path/to/private-host --port 7140
```

The receiver must accept OTLP `http/json`. The host appends `/v1/traces` to the base endpoint. Pair a browser or native client and make a service request. Look for the `agentui-host` service and `agentui.host.request` spans in your tracing backend. Static asset requests do not produce spans.

## Send traces through a Datadog Agent

Enable the HTTP receiver in the local Agent's `datadog.yaml`:

```yaml
otlp_config:
  receiver:
    protocols:
      http:
        endpoint: 127.0.0.1:4318
```

Restart the Agent, then start the host with the same environment shown above. The Agent owns Datadog authentication and forwarding. The host does not need a Datadog API key. The Agent must run on the same host as AgentUI. See [Datadog's OTLP endpoint setup](https://docs.datadoghq.com/opentelemetry/setup/otlp_ingest_in_the_agent/) for Agent requirements and container configuration.

For Datadog LLM Observability, enable that product on the Agent and set `AGENTUI_DATADOG_LLMOBS=true` in the host environment. This adds the `dd_llmobs_enabled: true` resource attribute to exported spans. Switchboard's GenAI agent spans describe observed native runs. They contain no conversation content. See [Datadog's OpenTelemetry mapping](https://docs.datadoghq.com/llm_observability/instrument/otel_instrumentation/) for Agent requirements and backend conversion. HTTP export success alone does not prove a converted LLM span is visible in Datadog.

## Configure export

These variables apply only when starting the host. Control commands such as `invite`, `devices`, and `revoke` do not create a telemetry exporter.

| Variable | Behavior |
| --- | --- |
| `OTEL_TRACES_EXPORTER` | `otlp` enables tracing. Unset, empty, or `none` disables it. Other values fail startup. |
| `OTEL_SDK_DISABLED` | `true`, ignoring case and surrounding spaces, disables tracing before other telemetry settings are parsed. |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | Base HTTP or HTTPS URL. Defaults to `http://127.0.0.1:4318`. The host appends `/v1/traces`. |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` | Full trace URL. Overrides the base URL without appending a path. |
| `OTEL_EXPORTER_OTLP_PROTOCOL` | Only `http/json` is supported. The default is `http/json`. |
| `OTEL_EXPORTER_OTLP_TRACES_PROTOCOL` | Overrides the general protocol. |
| `OTEL_EXPORTER_OTLP_HEADERS` | Collector authorization headers as comma-separated `name=value` entries. Percent-encode header values. |
| `OTEL_EXPORTER_OTLP_TRACES_HEADERS` | Overrides matching general header names. |
| `OTEL_SERVICE_NAME` | Exported service name. Defaults to `agentui-host`. Allows 1 to 128 printable characters. |
| `AGENTUI_DATADOG_LLMOBS` | `true` adds the Datadog LLM Observability resource marker. Unset or `false` omits it. Other values fail startup. |

Endpoint URLs cannot contain credentials, query strings, or fragments. Invalid configuration fails startup with a generic diagnostic that omits the supplied value. Keep Collector credentials in host environment variables. Use HTTPS when sending them across a network.

The CLI reads telemetry environment settings once. The exporter sends only the endpoint and headers in that parsed configuration. Programmatic host options do not inherit ambient collector headers. The direct Codex version probe and app-server process receive an environment with host `OTEL_*` settings and `AGENTUI_DATADOG_LLMOBS` removed. Switchboard supplies its Codex SDK and Claude SDK children with allowlisted environments that also exclude those settings.

The host supplies its own resource and sampler. It does not read `OTEL_RESOURCE_ATTRIBUTES`, detect process or machine attributes, or configure sampling from environment variables. No Datadog-specific host variables are required. Configure environment and version tags in your Collector or Agent.

## Inspect span fields

Each request span has kind `SERVER` and these attributes:

| Attribute | Values |
| --- | --- |
| `agentui.operation` | The admitted service operation, including `pair`. Failures before admission use `admission`. |
| `agentui.credential_class` | `browser-development` or `native`. |
| `agentui.outcome` | `ok`, `unauthorized`, `forbidden`, `invalid`, `unavailable`, or `create-rejected`. |
| `http.response.status_code` | The response code actually written. Omitted if no response headers were sent. |

Duration covers admission, dispatch, and response serialization. It ends when the endpoint writes the response. It does not measure client delivery or the lifetime of a provider run. Failures have OpenTelemetry status `ERROR` without an error description.

The exporter receives no request URLs, headers, bodies, prompts, replies, search queries, tool arguments, exception messages, filesystem paths, or host, principal, conversation, and run identifiers. Incoming trace headers and baggage do not establish parentage. Each request starts a new trace. The operator-selected service name is exported verbatim.

## Inspect observed agent runs

AgentUI consumes Switchboard's public `./observability` entry from revision `dadfe09fb2f0090b46168309309ca01bb89b9a0e`. Its observer uses `contentPolicy: { kind: 'none' }` and an empty tool allowlist. The host borrows a tracer from its own provider under Switchboard's versioned instrumentation scope.

After the host persists a native `run-started` event, it opens an `invoke_agent` span. The matching persisted `run-ended` event closes it. This covers Codex CLI, Codex SDK, Claude SDK, and Pi. The interval measures the host's observed run lifecycle. It starts after run-start persistence and ends after terminal-event persistence. Failures before a run starts produce no agent span.

Spans use fixed agent names `codex`, `codex-sdk`, `claude-sdk`, or `pi`, and fixed provider names `openai`, `anthropic`, or `opencode-go`. Completed runs have Switchboard outcome `success`. Failed runs have outcome `error` and bounded category `unknown-error`, since local storage and cleanup can also fail. Interrupted or disconnected runs, including runs still open at shutdown, have outcome `outcome-unknown`. A Stop request alone does not establish cancellation.

Scope and native run IDs identify observations only inside the host's bounded map. They are not exported as correlations. The host records no model-request spans, token usage, or tool spans because the native lifecycle does not establish those facts. At most 128 agent observations remain open. Additional observations may be dropped while native work continues.

The host owns a separate tracer provider for each running host. It does not register a global provider or patch HTTP, provider clients, or filesystem access. This slice does not export logs, metrics, client spans, or control-socket operations.

Export runs in the background using OpenTelemetry's JSON serializer. The queue holds at most 128 spans and batches at most 32. Under pressure, spans may be dropped. Each HTTP attempt has an absolute 500 ms deadline and does not retry or follow redirects. Batch processing has a 750 ms timeout. Shutdown allows the bounded queued batches to export concurrently and waits at most one second before destroying telemetry connections. Export failure does not change a service response or host shutdown result. Traces are diagnostic evidence rather than durable receipts.

The exporter drains its own in-flight attempts during graceful shutdown. It accepts only HTTP 200 JSON acknowledgments, bounded to 64 KiB. Malformed responses and nonzero span rejections fail the export. An acceptance warning produces a fixed diagnostic without exposing the Collector's text.

## Verify the local export path

Build first, then run the receiver and bundled-host tests:

```sh
npm run build
node --test tests/application/*observability.test.mjs tests/application/telemetry-export.test.mjs
```

The tests inspect actual OTLP JSON sent by the bundled host. They check content exclusions, disabled mode, receiver failures, and Switchboard GenAI spans from a controlled native fixture. They do not attest to receipt in a live Datadog account.

## Configure the Crew worker

The [public Crew launcher](../../examples/crew/README.md#trace-the-host-and-crew-worker) uses the same host configuration described above. Its request spans cover AgentUI admission and dispatch. They do not measure remote Crew inference. The optional native agents configured in that host retain their normal observed agent spans.

Crew owns tracing around actual native driver calls. The following worker settings describe [Crew PR 81](https://github.com/mattsp1290/crew/pull/81) at revision `c7ed7b43008dc414485304f167834d6eb9bc2d53`. GitHub reported that PR open when this integration was prepared on November 15, 2026. Confirm the installed Crew revision before using these settings. This AgentUI change does not upgrade or deploy Crew.

Set these variables in the Crew member worker's environment, separately from the AgentUI launcher:

```sh
BIRBCREW_OTLP_TRACES_ENDPOINT=http://127.0.0.1:4318/v1/traces
OTEL_SERVICE_NAME=crew-worker
```

Crew's endpoint is a full traces URL. Unlike AgentUI, selecting an endpoint enables Crew export without `OTEL_TRACES_EXPORTER=otlp`. Follow the [pinned Crew verification guide](https://github.com/mattsp1290/crew/blob/c7ed7b43008dc414485304f167834d6eb9bc2d53/docs/verification.md#typescript-history-replay-and-traces) for endpoint precedence, plaintext restrictions, collector headers, local JSONL traces, and shutdown limits.

For a Datadog Agent with LLM Observability enabled, Crew's opt-in is `BIRBCREW_DATADOG_LLMOBS=true`. Keep `OTEL_EXPORTER_OTLP_HEADERS` and `OTEL_EXPORTER_OTLP_TRACES_HEADERS` unset in Crew's environment. The Agent owns forwarding credentials. AgentUI's separate opt-in is `AGENTUI_DATADOG_LLMOBS=true`. Setting either flag does not configure the other process.

Crew records metadata-only agent spans around actual native driver calls. Individual model requests, tool executions, and agent-span token usage remain outside that observation boundary.

AgentUI does not forward incoming trace context to Crew or synthesize Crew agent spans from snapshots. AgentUI request traces and Crew invocation traces are separate. Crew's selected UUID correlations remain Crew's export policy. AgentUI continues to exclude host, conversation, and run identifiers. Neither transport acknowledgment nor a span proves command settlement or native termination.

To verify this launcher boundary after building, run:

```sh
node --test examples/crew/tests/launcher-observability.test.mjs
```

This local test exercises the actual launcher against controlled Crew and OTLP HTTP servers. Live Crew invocation export and Datadog ingestion or conversion require checks against the installed worker and backend. Inspect both service names and verify an actual Crew agent span in the backend. AgentUI's live Datadog qualification remains tracked in `agentui-pkbs`.

See [OpenTelemetry JavaScript instrumentation](https://opentelemetry.io/docs/languages/js/instrumentation/) for SDK concepts.
