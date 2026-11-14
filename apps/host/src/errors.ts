import type { ServiceResponse } from '@agentui/contracts/service';

type FailureKind = Extract<ServiceResponse, { ok: false }>['error']['kind'];
export const FAILURE_STATUS: Readonly<Record<FailureKind, number>> = { unauthorized: 401, forbidden: 403, invalid: 400, unavailable: 503 };
export class HostFailure extends Error {
  constructor(readonly kind: FailureKind, message: string) { super(message); }
}
