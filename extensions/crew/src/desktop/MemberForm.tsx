import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { WorkspaceViewProps } from '@agentui/sdk/react';

const ENGINES = ['pi', 'claude', 'codex'] as const;
/** Crew limits `profile` to 128 UTF-8 bytes. */
const PROFILE_BYTES = 128;
const REFUSALS: Readonly<Record<string, string>> = {
  'unknown-profile': 'Crew has no profile with that name. Check the profile and try again.',
  'invalid-input': 'Check the engine, profile and instructions, then try again.',
  unauthorized: 'Crew refused the configured credential. Check AGENTUI_EXTENSION_CREW_TOKEN and restart AgentUI.',
  rejected: 'Crew rejected this member.',
};
/** Outcomes that leave it unknown whether Crew created the member. The retry reuses the same request. */
const UNKNOWN = new Set(['unreachable', 'unknown-outcome']);
const UNCONFIRMED = 'Crew may already have created this member. Retry to confirm it; the retry sends the same request and cannot create a second member. Cancel stops retrying; Crew may still have created the member, so check the member list.';
const NO_ID = 'Crew created the member but did not return its ID. Find it in the member list.';

const utf8Bytes = (value: string) => new TextEncoder().encode(value).byteLength;

/**
 * Each new member request gets a fresh requestId. Only a retry after an unknown outcome reuses it, and the fields stay
 * locked until that outcome is settled, so a reused requestId always carries the same body.
 */
export function MemberForm({ installationId, call, refresh, onCreated, onCancel }: {
  readonly installationId: string; readonly call: WorkspaceViewProps['call']; readonly refresh: WorkspaceViewProps['refresh'];
  readonly onCreated: (memberId: string) => void; readonly onCancel: () => void;
}) {
  const [unconfirmed, setUnconfirmed] = useState<string | null>(null);
  const [engine, setEngine] = useState<typeof ENGINES[number]>('codex');
  const [profile, setProfile] = useState('');
  const [instructions, setInstructions] = useState('');
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState('');
  const locked = pending || unconfirmed !== null;
  // A request that settles after Cancel or unmount must not close a newer form or change the selection.
  const active = useRef(true);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  const tooLong = utf8Bytes(profile.trim()) > PROFILE_BYTES;
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (pending || !profile.trim() || tooLong) return;
    const requestId = unconfirmed ?? crypto.randomUUID();
    setPending(true); setMessage(''); setUnconfirmed(requestId);
    const result = await call(installationId, 'members.create', { requestId, engine, profile: profile.trim(), ...(instructions.trim() ? { instructions } : {}) });
    if (result.kind === 'ok') {
      const output = result.output as { member?: { memberId?: unknown } } | null;
      await refresh();
      if (!active.current) return;
      setPending(false); setUnconfirmed(null);
      if (typeof output?.member?.memberId === 'string') { onCreated(output.member.memberId); return; }
      setProfile(''); setInstructions(''); setMessage(NO_ID);
      return;
    }
    if (!active.current) return;
    setPending(false);
    if (result.kind === 'refused' && !UNKNOWN.has(result.code)) {
      setUnconfirmed(null);
      setMessage(REFUSALS[result.code] ?? REFUSALS.rejected!);
      return;
    }
    setMessage(UNCONFIRMED);
  }
  return <form className="crew-member-form" aria-label="Add member" onSubmit={event => void submit(event)}>
    <h2>Add member</h2>
    <label>Engine<select value={engine} disabled={locked} onChange={event => setEngine(event.target.value as typeof ENGINES[number])}>
      {ENGINES.map(value => <option key={value} value={value}>{value}</option>)}
    </select></label>
    <label>Profile<input value={profile} required disabled={locked} aria-invalid={tooLong || undefined} onChange={event => setProfile(event.target.value)} /></label>
    {tooLong && <p className="crew-form-message">The profile is longer than Crew accepts ({PROFILE_BYTES} bytes).</p>}
    <label>Instructions<textarea value={instructions} rows={4} maxLength={16384} disabled={locked} onChange={event => setInstructions(event.target.value)} /></label>
    {message && <p role="alert" className="crew-form-message">{message}</p>}
    <div className="crew-form-actions">
      <button type="submit" disabled={pending || !profile.trim() || tooLong}>{pending ? 'Creating…' : unconfirmed ? 'Retry' : 'Create member'}</button>
      <button type="button" onClick={onCancel}>Cancel</button>
    </div>
  </form>;
}
