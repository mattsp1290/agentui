import type { RunAuthority } from '@agentui/contracts';
import type { EventObserver } from '@agentui/host';

export interface ProviderTestSubject<Event> {
  readonly authority: RunAuthority;
  readonly observation: EventObserver<Event>;
}
