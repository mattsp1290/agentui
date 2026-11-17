import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { macConnect, createMacConnection } from '@agentui/client/mac';
import type { MacAccess, MacNativeInvoke } from '@agentui/client/mac';
import { ThemeScope, Surface } from '@agentui/ui-primitives/desktop';
import { BrowserApplication } from '../shell/BrowserApplication.js';
import { createApplicationController } from './application-controller.js';
import type { ApplicationController } from './application-controller.js';
import { BrowserViewStorage } from './browser-storage.js';

type Session = { readonly id: string; readonly access: MacAccess; readonly controller: ApplicationController };
const nativeInvoke: MacNativeInvoke = command => invoke('native_access', { command });
export function NativeApplication() {
  const [session, setSession] = useState<Session | null>(null);
  const current = useRef<Session | null>(null);
  const pending = useRef(false);
  const alive = useRef(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function connect(): Promise<void> {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError('');
    try {
      const access = await macConnect(nativeInvoke);
      await current.current?.controller.dispose();
      if (!alive.current) return;
      const controller = createApplicationController({ createConnection: () => createMacConnection(access, nativeInvoke), createId: () => crypto.randomUUID(),
        ownedViewStorage: { open: failure => BrowserViewStorage.reopen('native-mac-default', failure, true), reopen: BrowserViewStorage.reopen } });
      current.current = { id: crypto.randomUUID(), access, controller };
      setSession(current.current);
    } catch (cause) { if (alive.current) setError(cause instanceof Error ? cause.message : 'Native connection unavailable. Reconnect, or restart AgentUI if the problem continues. Local work is retained.'); }
    finally { pending.current = false; if (alive.current) setBusy(false); }
  }
  useEffect(() => {
    void connect();
    return () => { alive.current = false; void current.current?.controller.dispose(); };
  }, []);
  const controls = <section aria-label="Mac connection">
    <p>This Mac connects directly to the AgentUI host on this computer. Your chats, drafts, and unresolved commands stay saved. No command is replayed on reconnect.</p>
    {error && <p role="alert">{error}</p>}
    {busy && <p role="status">Connecting to the local host…</p>}
  </section>;
  return session
    ? <BrowserApplication key={session.id} controller={session.controller} connection={{ kind: 'native', controls, reconnect: () => void connect() }} suspended={busy} />
    : <ThemeScope className="desktop-shell"><Surface className="landing"><h1>Connect this Mac</h1>
        <p>Start the AgentUI host on this Mac, then reconnect.</p>
        {controls}<button disabled={busy} onClick={() => void connect()}>Reconnect</button>
      </Surface></ThemeScope>;
}
