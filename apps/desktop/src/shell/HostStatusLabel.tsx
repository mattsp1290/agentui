import type { ApplicationSnapshot } from '../application/application-controller.js';

export function HostStatusLabel({ host }: { readonly host: ApplicationSnapshot['host'] }) {
  switch (host.kind) {
    case 'ready': case 'incompatible': return <span>Host {host.metadata.hostId}</span>;
    case 'unpaired': return <span>Pairing required</span>;
    case 'loading': return <span>Opening saved view…</span>;
    case 'unavailable': return <span>Host unavailable</span>;
  }
}
