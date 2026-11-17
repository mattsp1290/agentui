import type { ServiceFailureKind } from '@agentui/contracts/service';

export const FAILURE_STATUS: Readonly<Record<ServiceFailureKind, number>> = { forbidden: 403, invalid: 400, unavailable: 503, 'create-rejected': 409,
  'invalid-image': 400, 'image-scope': 403, 'image-upload-conflict': 409, 'image-unsupported': 409, 'image-capacity': 507, 'image-integrity': 503 };
