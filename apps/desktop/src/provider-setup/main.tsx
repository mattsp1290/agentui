import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { invoke } from '@tauri-apps/api/core';
import { record } from '@agentui/contracts/decode';
import './setup.css';

type Storage = 'absent' | 'saved' | 'locked' | 'denied' | 'unavailable';
type Host = 'missing-key' | 'ready' | 'unavailable';
type SetupStatus = { readonly target: string; readonly storage: Storage; readonly host: Host };
type State =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly status: SetupStatus }
  | { readonly kind: 'working'; readonly status: SetupStatus | null }
  | { readonly kind: 'failed'; readonly status: SetupStatus | null; readonly message: string };
type Command = { readonly kind: 'status' | 'connect-saved' } | { readonly kind: 'save-and-connect'; readonly apiKey: string };

const storageDescriptions: Record<Storage, string> = {
  absent: 'No OpenCode Go key is saved for this workspace and target.',
  saved: 'An OpenCode Go key is saved in macOS Keychain for this workspace and target.',
  locked: 'Keychain is locked. Unlock your login Keychain, then connect your saved key.',
  denied: 'Keychain is locked or access was denied. Unlock your login Keychain, then connect your saved key and allow access when macOS asks.',
  unavailable: 'Keychain is unavailable or its saved record cannot be read. Restore Keychain access before saving or connecting.',
};
const hostDescriptions: Record<Host, string> = {
  'missing-key': 'Pi needs your OpenCode Go API key before it can chat.',
  ready: 'Pi is configured for this host session. Send a message to check that OpenCode Go accepts your subscription key.',
  unavailable: 'Pi could not start. Check the host runtime, then try connecting again.',
};
const errors: Readonly<Record<string, string>> = {
  'keychain-locked': 'Keychain is locked. Unlock your login Keychain and try again.',
  'keychain-denied': 'macOS denied Keychain access. Try again and allow AgentUI access when asked.',
  'keychain-unavailable': 'AgentUI could not save or read the key in Keychain. Check Keychain access and try again. No plaintext fallback is used.',
  'key-absent': 'No saved key exists for this workspace and target. Enter your OpenCode Go API key.',
  'invalid-key': 'Enter a nonempty API key without line breaks, up to 4096 bytes.',
  'restart-required': 'Your new key is saved in Keychain. Pi is already connected with a different key. Close AgentUI, launch it again, then select Connect saved key to use the new key.',
  'host-unavailable': 'AgentUI could not connect Pi to the host. Keep the launcher running, check its connection, then try again. A key already saved in Keychain is retained.',
  'setup-unavailable': 'This window has no active launcher session. Close it and start AgentUI with ./agentui.',
};

function status(value: unknown): SetupStatus {
  const result = record(value), host = record(result.host);
  if (typeof result.target !== 'string') throw new Error('Invalid setup status');
  const storage = result.storage;
  if (storage !== 'absent' && storage !== 'saved' && storage !== 'locked' && storage !== 'denied' && storage !== 'unavailable') throw new Error('Invalid setup storage');
  if (host.kind !== 'missing-key' && host.kind !== 'ready' && host.kind !== 'unavailable') throw new Error('Invalid host status');
  return { target: result.target, storage, host: host.kind };
}

function ProviderSetup() {
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [key, setKey] = useState('');
  const pending = useRef(false);
  const alive = useRef(true);
  const current = state.kind === 'loading' ? null : state.status;
  const busy = state.kind === 'loading' || state.kind === 'working';
  async function run(command: Command): Promise<void> {
    if (pending.current) return;
    pending.current = true;
    setState({ kind: 'working', status: current });
    try {
      const received = status(await invoke<unknown>('provider_setup', { command }));
      if (alive.current) setState({ kind: 'ready', status: received });
    } catch (cause) {
      const code = typeof cause === 'string' ? cause : '';
      const refreshed = command.kind === 'status' ? current
        : await invoke<unknown>('provider_setup', { command: { kind: 'status' } }).then(status).catch(() => current);
      if (alive.current) setState({ kind: 'failed', status: refreshed,
        message: errors[code] ?? 'Protected Pi setup did not complete. Keep the launcher running and try again.' });
    } finally { pending.current = false; }
  }
  useEffect(() => {
    void run({ kind: 'status' });
    return () => { alive.current = false; };
  }, []);
  return <main>
    <p className="eyebrow">AGENTUI · PROTECTED SETUP</p>
    <h1>Set up Pi</h1>
    <p>Use your OpenCode Go subscription with GLM 5.3.</p>
    <p>AgentUI includes the compatible Pi SDK. Your installed Pi command is not used for this chat integration.</p>
    {current && <section aria-label="Pi setup status">
      <h2>Target · {current.target}</h2>
      <p role="status">{hostDescriptions[current.host]}</p>
      <p>{storageDescriptions[current.storage]}</p>
    </section>}
    {state.kind === 'failed' && <p role="alert">{state.message}</p>}
    {busy && <p role="status">{state.kind === 'loading' ? 'Checking setup…' : 'Updating protected setup…'}</p>}
    <form onSubmit={event => {
      event.preventDefault();
      const apiKey = key;
      setKey('');
      void run({ kind: 'save-and-connect', apiKey });
    }}>
      <label htmlFor="opencode-go-key">OpenCode Go API key</label>
      <input id="opencode-go-key" type="password" value={key} onChange={event => setKey(event.target.value)}
        autoComplete="off" autoCapitalize="none" spellCheck={false} maxLength={4096} disabled={busy} />
      <p className="hint">Saved in macOS Keychain on this Mac. Delivered only to this launcher host session. The chat page does not receive your key.</p>
      <button disabled={busy || !key.trim()}>Save in Keychain and connect</button>
    </form>
    <div className="actions">
      <button type="button" disabled={busy || current?.storage === 'absent'} onClick={() => void run({ kind: 'connect-saved' })}>Connect saved key</button>
      <button type="button" disabled={busy} onClick={() => void run({ kind: 'status' })}>Check setup</button>
    </div>
    <p className="hint">Connecting a saved key may ask for Keychain authorization. No key is stored in chat history or browser storage.</p>
    <p>Return to chat and select Reconnect to refresh Pi. Pi provides text chat without tools or file access.</p>
  </main>;
}

const root = document.getElementById('root');
if (!root) throw new Error('Provider setup container is missing');
createRoot(root).render(<ProviderSetup />);
