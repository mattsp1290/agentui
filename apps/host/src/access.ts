import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { chmodSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

export type CredentialClass = 'browser-development' | 'native';
export interface Principal { readonly id: string; readonly hostId: string; readonly credentialClass: CredentialClass }
const digest = (value: string): string => createHash('sha256').update(value).digest('hex');

export class Access {
  readonly hostId: string;
  private readonly db: DatabaseSync;
  private readonly invitations = new Map<string, { readonly expires: number; readonly credentialClass: CredentialClass }>();
  private attempts = 0;
  private attemptWindow = 0;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    try {
      chmodSync(path, 0o600);
      this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL;
        CREATE TABLE IF NOT EXISTS service_schema (singleton INTEGER PRIMARY KEY CHECK(singleton=1), version INTEGER NOT NULL);
        INSERT OR IGNORE INTO service_schema(singleton,version) VALUES(1,1);
        CREATE TABLE IF NOT EXISTS service_identity (singleton INTEGER PRIMARY KEY CHECK(singleton=1), host TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS service_devices (id TEXT PRIMARY KEY, digest TEXT NOT NULL UNIQUE, host TEXT NOT NULL,
          credential_class TEXT NOT NULL CHECK(credential_class IN ('browser-development','native')), expires INTEGER NOT NULL,
          policy TEXT NOT NULL CHECK(policy='owner'), revoked INTEGER NOT NULL CHECK(revoked IN (0,1)));`);
      if (this.db.prepare('SELECT version FROM service_schema WHERE singleton=1').get()?.version !== 1 ||
        !this.db.prepare('PRAGMA table_info(service_devices)').all().some(row => row.name === 'credential_class')) throw new Error('Unsupported host access schema');
      this.db.prepare('INSERT OR IGNORE INTO service_identity(singleton,host) VALUES(1,?)').run(randomUUID());
      const host = this.db.prepare('SELECT host FROM service_identity WHERE singleton=1').get()?.host;
      if (typeof host !== 'string' || !host) throw new Error('Invalid persisted host identity');
      if (this.db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='conversations'").get() &&
        this.db.prepare('SELECT 1 FROM conversations WHERE host<>? LIMIT 1').get(host)) throw new Error('Conversation host identity differs from persisted service identity');
      this.hostId = host;
    } catch (error) { this.db.close(); throw error; }
  }
  invite(credentialClass: CredentialClass, now = Date.now()): string {
    for (const [key, invitation] of this.invitations) if (invitation.expires <= now) this.invitations.delete(key);
    if (this.invitations.size >= 32) throw new Error('Outstanding pairing invitation limit');
    const code = randomBytes(24).toString('base64url');
    this.invitations.set(digest(code), { expires: now + 300_000, credentialClass });
    return code;
  }
  pair(code: string, credentialClass: CredentialClass, now = Date.now()): { readonly principal: Principal; readonly secret: string } {
    if (now - this.attemptWindow >= 60_000) { this.attemptWindow = now; this.attempts = 0; }
    if (++this.attempts > 20) throw new Error('Pairing attempt limit');
    const key = digest(code), invitation = this.invitations.get(key);
    if (!invitation || invitation.expires <= now || invitation.credentialClass !== credentialClass) throw new Error('Invalid or expired pairing invitation');
    const secret = randomBytes(32).toString('base64url');
    const principal = { id: randomUUID(), hostId: this.hostId, credentialClass };
    this.db.prepare("INSERT INTO service_devices(id,digest,host,credential_class,expires,policy,revoked) VALUES(?,?,?,?,?,'owner',0)")
      .run(principal.id, digest(secret), this.hostId, credentialClass, now + 3_600_000);
    this.invitations.delete(key);
    return { principal, secret };
  }
  authenticate(secret: string | undefined, credentialClass: CredentialClass, now = Date.now()): Principal | null {
    if (!secret || secret.length > 256) return null;
    const row = this.db.prepare("SELECT id,host FROM service_devices WHERE digest=? AND credential_class=? AND expires>? AND revoked=0 AND policy='owner'").get(digest(secret), credentialClass, now);
    if (!row || typeof row.id !== 'string' || row.host !== this.hostId) return null;
    return { id: row.id, hostId: this.hostId, credentialClass };
  }
  authorized(principal: Principal, credentialClass: CredentialClass, now = Date.now()): boolean {
    return principal.hostId === this.hostId && principal.credentialClass === credentialClass && Boolean(this.db.prepare("SELECT 1 FROM service_devices WHERE id=? AND host=? AND credential_class=? AND expires>? AND revoked=0 AND policy='owner'").get(principal.id, this.hostId, credentialClass, now));
  }
  devices(after = ''): readonly { readonly id: string; readonly revoked: boolean }[] {
    return this.db.prepare('SELECT id,revoked FROM service_devices WHERE id>? ORDER BY id LIMIT 100').all(after).map(row => {
      if (typeof row.id !== 'string') throw new Error('Invalid device record');
      return { id: row.id, revoked: row.revoked === 1 };
    });
  }
  revoke(id: string): void {
    if (!this.db.prepare('SELECT 1 FROM service_devices WHERE id=?').get(id)) throw new Error('Unknown device');
    this.db.prepare('UPDATE service_devices SET revoked=1 WHERE id=?').run(id);
  }
  close(): void { this.db.close(); }
}
