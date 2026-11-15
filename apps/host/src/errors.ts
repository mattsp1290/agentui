import type { ServiceFailureKind } from '@agentui/contracts/service';

export const FAILURE_STATUS: Readonly<Record<ServiceFailureKind, number>> = { unauthorized: 401, forbidden: 403, invalid: 400, unavailable: 503, 'create-rejected': 409 };
