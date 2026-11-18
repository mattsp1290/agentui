import { identifier, record } from '@agentui/contracts/decode';

/** The token namespace. The host reads these variables as secrets and deletes them from its environment once consumed. */
export const EXTENSION_TOKEN_VARIABLE = /^AGENTUI_EXTENSION_[A-Za-z0-9_]+$/u;
export const maximumInstallationGrants = 64;

export interface InstallationGrantInstance {
  readonly namespace: string;
  readonly installationId: string;
  readonly generation: string;
  readonly protocolVersion: string;
}
export type InstallationGrantAuthentication =
  | { readonly kind: 'environment'; readonly variable: string; readonly revision: string }
  | { readonly kind: 'unauthenticated' };
/** A version 2 installation grant. It names a token variable but never holds a secret. */
export interface InstallationGrant {
  readonly id: string;
  readonly instance: InstallationGrantInstance;
  readonly service: string;
  readonly expectedAuthority: 'agentui-host' | 'remote-provider';
  readonly authentication: InstallationGrantAuthentication;
}

export function parseGrantInstance(value: unknown): InstallationGrantInstance {
  const input = record(value, ['namespace', 'installationId', 'generation', 'protocolVersion']);
  if (Object.values(input).some(value => typeof value !== 'string' || !value.trim())) throw new Error('Invalid provider identity');
  return { namespace: identifier(input.namespace), installationId: identifier(input.installationId),
    generation: identifier(input.generation), protocolVersion: identifier(input.protocolVersion) };
}

function parseAuthentication(value: unknown): InstallationGrantAuthentication {
  const input = record(value);
  if (input.kind === 'unauthenticated') {
    record(value, ['kind']);
    return { kind: 'unauthenticated' };
  }
  record(value, ['kind', 'variable', 'revision']);
  const variable = identifier(input.variable);
  if (input.kind !== 'environment' || !EXTENSION_TOKEN_VARIABLE.test(variable)) throw new Error('Invalid authentication');
  return { kind: 'environment', variable, revision: identifier(input.revision) };
}

/** Validates the structure of one grant. It reads no environment, so parsing a customization package never touches a secret. */
export function parseInstallationGrant(value: unknown): InstallationGrant {
  const grant = record(value, ['id', 'instance', 'service', 'expectedAuthority', 'authentication']);
  if (grant.expectedAuthority !== 'agentui-host' && grant.expectedAuthority !== 'remote-provider') throw new Error('Invalid authority');
  return { id: identifier(grant.id), instance: parseGrantInstance(grant.instance), service: identifier(grant.service),
    expectedAuthority: grant.expectedAuthority, authentication: parseAuthentication(grant.authentication) };
}

export function parseInstallationGrants(value: unknown): readonly InstallationGrant[] {
  if (!Array.isArray(value) || value.length > maximumInstallationGrants) throw new Error('Invalid installation grants');
  return value.map(parseInstallationGrant);
}
