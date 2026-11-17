export interface Principal { readonly id: string; readonly hostId: string }

export function ownerPrincipal(hostId: string): Principal {
  return { id: 'trusted-owner', hostId };
}
