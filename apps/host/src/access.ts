import type { DatabaseSync } from 'node:sqlite';
import type { AccessDatabase } from './access-database.js';

export type CredentialClass = 'browser-development' | 'native';
export interface Principal { readonly id: string; readonly hostId: string; readonly credentialClass: CredentialClass }
const OWNER_ID = 'trusted-owner';

export class Access {
  readonly hostId: string;
  private readonly db: DatabaseSync;
  constructor(state: AccessDatabase) {
    this.db = state.database; this.hostId = state.hostId;
  }
  owner(credentialClass: CredentialClass): Principal {
    return { id: OWNER_ID, hostId: this.hostId, credentialClass };
  }
  close(): void { this.db.close(); }
}
