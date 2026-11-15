import { request as httpRequest } from 'node:http';
import type { ClientRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { diag } from '@opentelemetry/api';
import { ExportResultCode } from '@opentelemetry/core';
import { JsonTraceSerializer } from '@opentelemetry/otlp-transformer';
import type { SpanExporter } from '@opentelemetry/sdk-trace';

function acknowledgement(body: Uint8Array): 'accepted' | 'warning' | 'rejected' {
  const input: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return 'rejected';
  if (!('partialSuccess' in input) || input.partialSuccess === null) return 'accepted';
  const partial = input.partialSuccess;
  if (typeof partial !== 'object' || Array.isArray(partial)) return 'rejected';
  if ('rejectedSpans' in partial && partial.rejectedSpans !== null && partial.rejectedSpans !== 0 && partial.rejectedSpans !== '0') return 'rejected';
  if (!('errorMessage' in partial) || partial.errorMessage === null || partial.errorMessage === '') return 'accepted';
  return typeof partial.errorMessage === 'string' ? 'warning' : 'rejected';
}

type Attempt = { readonly done: Promise<void>; readonly abort: () => void };

export function createOtlpExporter(options: { readonly endpoint: string; readonly headers: Readonly<Record<string, string>> }): SpanExporter & { abort(): void } {
  const endpoint = new URL(options.endpoint);
  const send = endpoint.protocol === 'https:' ? httpsRequest : httpRequest;
  const active = new Set<Attempt>();
  let closing: Promise<void> | undefined;
  function shutdown(): Promise<void> {
    closing ??= Promise.all([...active].map(attempt => attempt.done)).then(() => {});
    return closing;
  }
  return {
    export(spans, callback) {
      if (closing) { callback({ code: ExportResultCode.FAILED }); return; }
      let request: ClientRequest | undefined;
      const done = new Promise<void>(resolve => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        let finished = false;
        const finish = (code: ExportResultCode) => {
          if (finished) return;
          finished = true;
          clearTimeout(timer);
          resolve();
          callback({ code });
        };
        try {
          const body = JsonTraceSerializer.serializeRequest(spans);
          if (!body) { finish(ExportResultCode.FAILED); return; }
          const outgoing = send(endpoint, { method: 'POST', agent: false,
            headers: { ...options.headers, 'content-type': 'application/json', 'content-length': body.byteLength } }, response => {
            if (response.statusCode !== 200 || response.headers['content-type']?.split(';')[0]?.trim().toLowerCase() !== 'application/json') {
              response.destroy(); finish(ExportResultCode.FAILED); return;
            }
            let bytes = 0;
            const chunks: Buffer[] = [];
            response.on('data', (chunk: Buffer) => {
              bytes += chunk.byteLength;
              if (bytes > 64 * 1024) { response.destroy(); finish(ExportResultCode.FAILED); return; }
              chunks.push(chunk);
            });
            response.once('error', () => finish(ExportResultCode.FAILED));
            response.once('end', () => {
              try {
                const result = acknowledgement(Buffer.concat(chunks));
                if (result === 'warning') diag.warn('OTLP receiver reported an export warning');
                finish(result === 'rejected' ? ExportResultCode.FAILED : ExportResultCode.SUCCESS);
              } catch { finish(ExportResultCode.FAILED); }
            });
          });
          request = outgoing;
          outgoing.once('error', () => finish(ExportResultCode.FAILED));
          timer = setTimeout(() => { outgoing.destroy(); finish(ExportResultCode.FAILED); }, 500);
          outgoing.end(body);
        } catch {
          request?.destroy();
          finish(ExportResultCode.FAILED);
        }
      });
      const attempt = { done, abort: () => request?.destroy() };
      active.add(attempt);
      void done.then(() => active.delete(attempt));
    },
    shutdown,
    abort() {
      void shutdown();
      for (const attempt of active) attempt.abort();
    },
  };
}
