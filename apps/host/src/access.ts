import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { AccessDatabase } from './access-database.js';
import { DEVICE_SECRET_BYTES, INVITATION_CODE_BYTES } from './native-wire.js';

export type CredentialClass = 'browser-development' | 'native';
export interface Principal { readonly id: string; readonly hostId: string; readonly credentialClass: CredentialClass }
type HostAccess = { readonly kind: 'paired' } | { readonly kind: 'trusted'; readonly principal: Principal };
const digest = (value: string): string => createHash('sha256').update(value).digest('hex');
const ACTIVE_DEVICE = "credential_class=? AND expires>? AND revoked=0 AND policy='owner'";

export class Access {
  readonly hostId: string;
  private readonly db: DatabaseSync;
  private readonly browserAccess: HostAccess;
  private readonly invitations = new Map<string, { readonly expires: number; readonly credentialClass: CredentialClass }>();
  constructor(state: AccessDatabase, mode: HostAccess['kind'] = 'paired') {
    this.db = state.database; this.hostId = state.hostId;
    this.browserAccess = mode === 'trusted'
      ? { kind: 'trusted', principal: { id: 'trusted-owner', hostId: this.hostId, credentialClass: 'browser-development' } }
      : { kind: 'paired' };
  }
  invite(credentialClass: CredentialClass, now = Date.now()): string {
    for (const [key, invitation] of this.invitations) if (invitation.expires <= now) this.invitations.delete(key);
    if (this.invitations.size >= 32) throw new Error('Outstanding pairing invitation limit');
    const code = randomBytes(INVITATION_CODE_BYTES).toString('base64url');
    this.invitations.set(digest(code), { expires: now + 300_000, credentialClass });
    return code;
  }
  pair(code: string, credentialClass: CredentialClass, now = Date.now()): { readonly principal: Principal; readonly secret: string } {
    const key = digest(code), invitation = this.invitations.get(key);
    if (!invitation || invitation.expires <= now || invitation.credentialClass !== credentialClass) {
      throw new Error('Invalid or expired pairing invitation');
    }
    const secret = randomBytes(DEVICE_SECRET_BYTES).toString('base64url');
    const principal = { id: randomUUID(), hostId: this.hostId, credentialClass };
    this.db.prepare("INSERT INTO service_devices(id,digest,host,credential_class,expires,policy,revoked) VALUES(?,?,?,?,?,'owner',0)")
      .run(principal.id, digest(secret), this.hostId, credentialClass, now + (credentialClass === 'native' ? 30 * 24 * 3_600_000 : 3_600_000));
    this.invitations.delete(key);
    return { principal, secret };
  }
  authenticate(secret: string | undefined, credentialClass: CredentialClass, now = Date.now()): Principal | null {
    if (this.browserAccess.kind === 'trusted' && credentialClass === 'browser-development') return this.browserAccess.principal;
    if (!secret || secret.length > 256) return null;
    const row = this.db.prepare(`SELECT id,host FROM service_devices WHERE digest=? AND ${ACTIVE_DEVICE}`).get(digest(secret), credentialClass, now);
    if (!row || typeof row.id !== 'string' || row.host !== this.hostId) return null;
    return { id: row.id, hostId: this.hostId, credentialClass };
  }
  authorized(principal: Principal, credentialClass: CredentialClass, now = Date.now()): boolean {
    if (this.browserAccess.kind === 'trusted' && credentialClass === 'browser-development') {
      const owner = this.browserAccess.principal;
      return principal.id === owner.id && principal.hostId === owner.hostId && principal.credentialClass === owner.credentialClass;
    }
    return principal.hostId === this.hostId && principal.credentialClass === credentialClass && Boolean(this.db.prepare(`SELECT 1 FROM service_devices WHERE id=? AND host=? AND ${ACTIVE_DEVICE}`).get(principal.id, this.hostId, credentialClass, now));
  }
  devices(after = '', now = Date.now()): readonly { readonly id: string; readonly revoked: boolean; readonly expires: number; readonly active: boolean }[] {
    return this.db.prepare('SELECT id,revoked,expires FROM service_devices WHERE id>? ORDER BY id LIMIT 100').all(after).map(row => {
      if (typeof row.id !== 'string' || typeof row.expires !== 'number') throw new Error('Invalid device record');
      return { id: row.id, revoked: row.revoked === 1, expires: row.expires, active: row.revoked !== 1 && row.expires > now };
    });
  }
  revoke(id: string): void {
    if (!this.db.prepare('SELECT 1 FROM service_devices WHERE id=?').get(id)) throw new Error('Unknown device');
    this.db.prepare('UPDATE service_devices SET revoked=1 WHERE id=?').run(id);
  }
  close(): void { this.db.close(); }
}
