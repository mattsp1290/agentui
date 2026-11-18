import { useState, type FormEvent } from 'react';
import type { WorkspaceViewProps } from '@agentui/sdk/react';

const ENGINES = ['pi', 'claude', 'codex'] as const;
const REFUSALS: Readonly<Record<string, string>> = {
  'unknown-profile': 'Crew has no profile with that name. Check the profile and try again.',
  'invalid-input': 'Check the engine, profile and instructions, then try again.',
  unauthorized: 'Crew refused the configured credential. Check AGENTUI_EXTENSION_CREW_TOKEN and restart AgentUI.',
  unreachable: 'Crew could not be reached. Try again; the same request will not create a second member.',
  'unknown-outcome': 'Crew did not confirm the request. Try again; the same request will not create a second member.',
  rejected: 'Crew rejected this member.',
};
const FAILED = 'The member could not be created. Try again; the same request will not create a second member.';

/** One form instance keeps one requestId, so every retry asks Crew for the same member. */
export function MemberForm({ installationId, call, refresh, onCreated, onCancel }: {
  readonly installationId: string; readonly call: WorkspaceViewProps['call']; readonly refresh: WorkspaceViewProps['refresh'];
  readonly onCreated: (memberId: string) => void; readonly onCancel: () => void;
}) {
  const [requestId] = useState(() => crypto.randomUUID());
  const [engine, setEngine] = useState<typeof ENGINES[number]>('codex');
  const [profile, setProfile] = useState('');
  const [instructions, setInstructions] = useState('');
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState('');
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (pending || !profile.trim()) return;
    setPending(true); setMessage('');
    const result = await call(installationId, 'members.create', { requestId, engine, profile: profile.trim(), ...(instructions.trim() ? { instructions } : {}) });
    if (result.kind === 'ok') {
      const output = result.output as { member?: { memberId?: unknown } } | null;
      await refresh();
      setPending(false);
      if (typeof output?.member?.memberId === 'string') onCreated(output.member.memberId);
      return;
    }
    setPending(false);
    setMessage(result.kind === 'refused' ? REFUSALS[result.code] ?? REFUSALS.rejected! : FAILED);
  }
  return <form className="crew-member-form" aria-label="Add member" onSubmit={event => void submit(event)}>
    <h2>Add member</h2>
    <label>Engine<select value={engine} onChange={event => setEngine(event.target.value as typeof ENGINES[number])}>
      {ENGINES.map(value => <option key={value} value={value}>{value}</option>)}
    </select></label>
    <label>Profile<input value={profile} required maxLength={128} onChange={event => setProfile(event.target.value)} /></label>
    <label>Instructions<textarea value={instructions} rows={4} maxLength={16384} onChange={event => setInstructions(event.target.value)} /></label>
    {message && <p role="alert" className="crew-form-message">{message}</p>}
    <div className="crew-form-actions">
      <button type="submit" disabled={pending || !profile.trim()}>{pending ? 'Creating…' : 'Create member'}</button>
      <button type="button" onClick={onCancel}>Cancel</button>
    </div>
  </form>;
}
