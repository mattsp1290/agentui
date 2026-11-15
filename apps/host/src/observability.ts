import { validateHeaderName, validateHeaderValue } from 'node:http';
import { ROOT_CONTEXT, SpanKind, SpanStatusCode } from '@opentelemetry/api';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { AlwaysOnSampler, BatchSpanProcessor, TracerProvider } from '@opentelemetry/sdk-trace';
import type { ServiceFailureKind, ServiceRequest } from '@agentui/contracts/service';
import type { CredentialClass } from './access.js';
import { createAgentObservations } from './agent-observations.js';
import type { AgentObservations } from './agent-observations.js';
import { createOtlpExporter } from './otlp-exporter.js';
import { OBSERVABILITY_BOUNDS } from './observability-bounds.js';

export type ObservabilityConfiguration =
  | { readonly kind: 'disabled' }
  | { readonly kind: 'otlp'; readonly endpoint: string; readonly headers: Readonly<Record<string, string>>; readonly serviceName: string;
      readonly datadogLlmObservability: boolean };

export type RequestObservation = {
  readonly operation: ServiceRequest['op'] | 'admission';
  readonly credentialClass: CredentialClass;
  readonly outcome: 'ok' | ServiceFailureKind;
  readonly startTime: number;
  readonly statusCode: number | null;
};

export interface HostObservability {
  record(observation: RequestObservation): void;
  recordOutput: AgentObservations['recordOutput'];
  close(): Promise<void>;
}

export const NO_OBSERVABILITY: HostObservability = { record() {}, recordOutput() {}, async close() {} };

export function readObservabilityConfiguration(env: NodeJS.ProcessEnv): ObservabilityConfiguration {
  if (env.OTEL_SDK_DISABLED?.trim().toLowerCase() === 'true') return { kind: 'disabled' };
  const exporter = env.OTEL_TRACES_EXPORTER?.trim();
  if (!exporter || exporter === 'none') return { kind: 'disabled' };
  if (exporter !== 'otlp') throw new Error('Set OTEL_TRACES_EXPORTER to otlp or none');
  const protocol = env.OTEL_EXPORTER_OTLP_TRACES_PROTOCOL ?? env.OTEL_EXPORTER_OTLP_PROTOCOL;
  if (protocol !== undefined && protocol !== 'http/json') throw new Error('Host telemetry requires OTLP protocol http/json');
  let endpoint: URL;
  try {
    const specific = env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
    endpoint = new URL(specific ?? env.OTEL_EXPORTER_OTLP_ENDPOINT ?? 'http://127.0.0.1:4318');
    if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error();
    if (specific === undefined) endpoint.pathname = `${endpoint.pathname.replace(/\/$/, '')}/v1/traces`;
  } catch { throw new Error('Provide a valid HTTP or HTTPS OTLP endpoint without credentials, query or fragment'); }
  const headers = new Map<string, string>();
  try {
    for (const encoded of [env.OTEL_EXPORTER_OTLP_HEADERS, env.OTEL_EXPORTER_OTLP_TRACES_HEADERS]) {
      for (const entry of encoded?.split(',').filter(value => value.trim()) ?? []) {
        const separator = entry.indexOf('=');
        if (separator < 1) throw new Error();
        const name = entry.slice(0, separator).trim().toLowerCase();
        const value = decodeURIComponent(entry.slice(separator + 1).trim());
        validateHeaderName(name);
        validateHeaderValue(name, value);
        headers.set(name, value);
      }
    }
  } catch { throw new Error('Provide valid URL-encoded OTLP headers as comma-separated name=value pairs'); }
  const serviceName = env.OTEL_SERVICE_NAME?.trim() ?? 'agentui-host';
  if (!serviceName || serviceName.length > 128 || Array.from(serviceName).some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) throw new Error('Provide OTEL_SERVICE_NAME with 1 to 128 printable characters');
  const datadog = env.AGENTUI_DATADOG_LLMOBS;
  if (datadog !== undefined && datadog !== 'true' && datadog !== 'false') throw new Error('Set AGENTUI_DATADOG_LLMOBS to true or false');
  return { kind: 'otlp', endpoint: endpoint.href, headers: Object.fromEntries(headers), serviceName, datadogLlmObservability: datadog === 'true' };
}

export function createHostObservability(configuration: ObservabilityConfiguration): HostObservability {
  if (configuration.kind === 'disabled') return NO_OBSERVABILITY;
  const exporter = createOtlpExporter(configuration);
  const provider = new TracerProvider({
    resource: resourceFromAttributes({ 'service.name': configuration.serviceName,
      ...(configuration.datadogLlmObservability ? { dd_llmobs_enabled: true } : {}) }),
    sampler: new AlwaysOnSampler(),
    spanLimits: { attributeCountLimit: 8, attributeValueLengthLimit: 128, eventCountLimit: 0, linkCountLimit: 0 },
    spanProcessors: [new BatchSpanProcessor({ exporter, maxQueueSize: OBSERVABILITY_BOUNDS.maxQueueSize, maxExportBatchSize: OBSERVABILITY_BOUNDS.maxBatchSize,
      scheduledDelayMillis: OBSERVABILITY_BOUNDS.flushIntervalMs, exportTimeoutMillis: OBSERVABILITY_BOUNDS.batchTimeoutMs })],
  });
  const tracer = provider.getTracer('agentui.host');
  const agents = createAgentObservations(provider);
  let closed = false, closePromise: Promise<void> | undefined;
  return {
    recordOutput: agents.recordOutput,
    record(observation) {
      if (closed) return;
      const span = tracer.startSpan('agentui.host.request', { kind: SpanKind.SERVER, startTime: observation.startTime,
        attributes: { 'agentui.operation': observation.operation, 'agentui.credential_class': observation.credentialClass,
          'agentui.outcome': observation.outcome, ...(observation.statusCode === null ? {} : { 'http.response.status_code': observation.statusCode }) } }, ROOT_CONTEXT);
      if (observation.outcome !== 'ok') span.setStatus({ code: SpanStatusCode.ERROR });
      span.end(performance.timeOrigin + performance.now());
    },
    close() {
      closed = true;
      agents.close();
      closePromise ??= new Promise<void>(resolve => {
        const finish = () => { exporter.abort(); resolve(); };
        const timer = setTimeout(finish, OBSERVABILITY_BOUNDS.shutdownDeadlineMs);
        void provider.shutdown().catch(() => {}).then(() => exporter.shutdown()).finally(() => { clearTimeout(timer); finish(); });
      });
      return closePromise;
    },
  };
}
