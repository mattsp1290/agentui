import { request as httpRequest } from 'node:http';
import type { ClientRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { ExportResultCode } from '@opentelemetry/core';
import { JsonTraceSerializer } from '@opentelemetry/otlp-transformer';
import type { SpanExporter } from '@opentelemetry/sdk-trace';

export function createOtlpExporter(options: { readonly endpoint: string; readonly headers: Readonly<Record<string, string>> }): SpanExporter {
  const endpoint = new URL(options.endpoint);
  const send = endpoint.protocol === 'https:' ? httpsRequest : httpRequest;
  const active = new Set<ClientRequest>();
  let closed = false;
  return {
    export(spans, callback) {
      if (closed) { callback({ code: ExportResultCode.FAILED }); return; }
      let request: ClientRequest | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let finished = false;
      const finish = (code: ExportResultCode) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        if (request) active.delete(request);
        callback({ code });
      };
      try {
        const body = JsonTraceSerializer.serializeRequest(spans);
        if (!body) { finish(ExportResultCode.FAILED); return; }
        const outgoing = send(endpoint, { method: 'POST', agent: false,
          headers: { ...options.headers, 'content-type': 'application/json', 'content-length': body.byteLength } }, response => {
          response.once('error', () => finish(ExportResultCode.FAILED));
          response.once('end', () => finish(response.statusCode !== undefined && response.statusCode >= 200 && response.statusCode < 300
            ? ExportResultCode.SUCCESS : ExportResultCode.FAILED));
          response.resume();
        });
        request = outgoing;
        active.add(outgoing);
        outgoing.once('error', () => finish(ExportResultCode.FAILED));
        timer = setTimeout(() => { outgoing.destroy(); finish(ExportResultCode.FAILED); }, 500);
        outgoing.end(body);
      } catch {
        request?.destroy();
        finish(ExportResultCode.FAILED);
      }
    },
    async shutdown() {
      closed = true;
      for (const request of active) request.destroy();
      active.clear();
    },
  };
}
