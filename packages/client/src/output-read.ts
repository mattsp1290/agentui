import { hash } from 'fast-sha256';
import type { OutputRead } from '@agentui/contracts';
import type { ServiceValueMap } from '@agentui/contracts/service';
export function finishOutputRead(value: ServiceValueMap['output-read']): OutputRead {
  if (value.result.kind !== 'available') return value.result;
  const { output, base64 } = value.result;
  const bytes = Uint8Array.from(atob(base64), character => character.charCodeAt(0));
  if (bytes.byteLength !== output.byteLength) throw new Error('Output byte length mismatch');
  new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  const digest = Array.from(hash(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
  if (digest !== output.sha256) throw new Error('Output digest mismatch');
  return { kind: 'available', output, bytes };
}
