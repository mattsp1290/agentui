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
  private readonly attempts = new Map<string, { readonly start: number; failures: number }>();
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
  pair(code: string, credentialClass: CredentialClass, now = Date.now(), source = 'local'): { readonly principal: Principal; readonly secret: string } {
    const key = digest(code), invitation = this.invitations.get(key);
    if (!invitation || invitation.expires <= now || invitation.credentialClass !== credentialClass) {
      for (const [key, window] of this.attempts) if (now - window.start >= 60_000) this.attempts.delete(key);
      let window = this.attempts.get(source);
      if (!window) {
        if (this.attempts.size >= 64) throw new Error('Pairing attempt limit');
        window = { start: now, failures: 0 }; this.attempts.set(source, window);
      }
      if (++window.failures > 20) throw new Error('Pairing attempt limit');
      throw new Error('Invalid or expired pairing invitation');
    }
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
  devices(after = ''): readonly { readonly id: string; readonly revoked: boolean; readonly expires: number; readonly active: boolean }[] {
    return this.db.prepare('SELECT id,revoked,expires FROM service_devices WHERE id>? ORDER BY id LIMIT 100').all(after).map(row => {
      if (typeof row.id !== 'string' || typeof row.expires !== 'number') throw new Error('Invalid device record');
      return { id: row.id, revoked: row.revoked === 1, expires: row.expires, active: row.revoked !== 1 && row.expires > Date.now() };
    });
  }
  revoke(id: string): void {
    if (!this.db.prepare('SELECT 1 FROM service_devices WHERE id=?').get(id)) throw new Error('Unknown device');
    this.db.prepare('UPDATE service_devices SET revoked=1 WHERE id=?').run(id);
  }
  close(): void { this.db.close(); }
}
