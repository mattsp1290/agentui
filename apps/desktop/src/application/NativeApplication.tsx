import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { macAccess, createMacConnection } from '@agentui/client/mac';
import type { MacAccess, MacNativeInvoke } from '@agentui/client/mac';
import { ThemeScope, Surface } from '@agentui/ui-primitives/desktop';
import { BrowserApplication } from '../shell/BrowserApplication.js';
import { createApplicationController } from './application-controller.js';
import type { ApplicationController } from './application-controller.js';
import { BrowserViewStorage } from './browser-storage.js';
import { record } from '@agentui/contracts/decode';

type Session = { readonly id: string; readonly access: MacAccess; readonly controller: ApplicationController };
const nativeInvoke: MacNativeInvoke = command => invoke('native_access', { command });
export function NativeApplication() {
  const [session, setSession] = useState<Session | null>(null);
  const current = useRef<Session | null>(null);
  const pending = useRef(false);
  const alive = useRef(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [invitation, setInvitation] = useState('');
  const [forgetSessionId, setForgetSessionId] = useState<Session['id'] | null>(null);
  const forgetButton = useRef<HTMLButtonElement>(null);
  async function replace(command: Parameters<typeof macAccess>[0]): Promise<void> {
    if (pending.current) return;
    setForgetSessionId(null);
    pending.current = true; setBusy(true); setError('');
    try {
      const action = command.kind === 'status' ? command : { ...command, observation: (await macAccess({ kind: 'status' }, nativeInvoke)).observation };
      const access = await macAccess(action, nativeInvoke);
      await current.current?.controller.dispose();
      if (!alive.current) return;
      const controller = createApplicationController({ createConnection: options => createMacConnection(access, nativeInvoke, options), createId: () => crypto.randomUUID(),
        ownedViewStorage: { open: failure => BrowserViewStorage.reopen('native-mac-default', failure, true), reopen: BrowserViewStorage.reopen } });
      current.current = { id: crypto.randomUUID(), access, controller };
      setSession(current.current);
    } catch (cause) { if (alive.current) setError(cause instanceof Error ? cause.message : 'Native access unavailable. Restore Keychain access, then reconnect.'); }
    finally { pending.current = false; if (alive.current) setBusy(false); }
  }
  useEffect(() => {
    void replace({ kind: 'status' });
    return () => { alive.current = false; void current.current?.controller.dispose(); };
  }, []);
  const controls = <section aria-label="Mac connection">
    <p>Protected pairing on this Mac. New native access lasts 30 days unless revoked. Re-pair explicitly after expiry.</p>
    {error && <p role="alert">{error}</p>}
    <form onSubmit={event => {
      event.preventDefault(); const text = invitation; setInvitation('');
      try {
        const value = record(JSON.parse(text));
        if (session) void replace({ kind: 'pair', observation: session.access.observation, invitation: { version: 1, ...value } });
      } catch { setError('Paste the native invitation JSON from invite-native.'); }
    }}>
      <label htmlFor="native-invitation">Native pairing invitation</label>
      <p>Paste the invitation value object from the host's invite-native command.</p>
      <input id="native-invitation" value={invitation} onChange={event => setInvitation(event.target.value)} autoComplete="off" maxLength={4096} disabled={busy} />
      <button disabled={busy || !session || session.access.kind === 'unreadable' || !invitation.trim()}>Pair this Mac</button>
    </form>
    {session && <>
      <button ref={forgetButton} type="button" disabled={busy} onClick={() => setForgetSessionId(session.id)}>Forget local pairing</button>
      {forgetSessionId === session.id && <div role="group" aria-labelledby="forget-local-pairing-question">
        <p id="forget-local-pairing-question">Forget local pairing?</p>
        <p>Drafts and unresolved commands stay saved. Remote device access is not revoked.</p>
        <button type="button" autoFocus disabled={busy} onClick={() => { setForgetSessionId(null); forgetButton.current?.focus(); }}>Cancel</button>
        <button type="button" disabled={busy} onClick={() => void replace({ kind: 'forget', observation: session.access.observation })}>Forget pairing</button>
      </div>}
    </>}
    <p>Forgetting is local. Use the host device revoke command to revoke server access. No command is replayed on reconnect.</p>
    {busy && <p role="status">Updating native connection…</p>}
  </section>;
  return session?.access.kind === 'ready'
    ? <BrowserApplication key={session.id} controller={session.controller} connectionControls={controls} suspended={busy} reconnect={() => void replace({ kind: 'status' })} />
    : <ThemeScope className="desktop-shell"><Surface className="landing"><h1>Connect this Mac</h1>
        {session?.access.kind === 'unreadable' && <p role="alert">The protected record is unreadable. Restore Keychain access, or explicitly discard this local pairing.</p>}
        {controls}<button disabled={busy} onClick={() => void replace({ kind: 'status' })}>Reconnect</button>
      </Surface></ThemeScope>;
}
