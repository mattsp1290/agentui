import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { WorkspaceViewProps } from '@agentui/sdk/react';

const ENGINES = ['pi', 'claude', 'codex'] as const;
/** Crew limits `profile` to 128 UTF-8 bytes and `instructions` to 16,384 UTF-8 bytes without control characters but tab and newline. */
const PROFILE_BYTES = 128;
const INSTRUCTIONS_BYTES = 16_384;
const DISALLOWED_CONTROL = /(?![\t\n])\p{Cc}/u;
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
/**
 * Host failures that prove this attempt never reached the operation. They settle a first attempt: Crew cannot have created
 * the member. They do not settle a retry, because the earlier attempt with the same requestId may still have created it.
 * Every other failure, including a host `unavailable` (it also answers an admitted call aborted mid-flight), leaves the
 * outcome unknown.
 */
const NOT_SENT: Readonly<Record<string, { readonly first: string; readonly retry: string }>> = {
  'unknown-extension': { first: 'AgentUI could not reach the Crew extension. Refresh and try again.', retry: 'AgentUI could not reach the Crew extension' },
  'unknown-installation': { first: 'This Crew installation is no longer configured. Refresh and try again.', retry: 'this Crew installation is no longer configured' },
  'unknown-operation': { first: 'This Crew installation cannot add members. Refresh and try again.', retry: 'this Crew installation cannot add members' },
  'too-large': { first: 'The instructions are too long for Crew. Shorten them and try again.', retry: 'the request was too large for Crew' },
};

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
  // Instructions are sent as typed, and only when they are not blank.
  const sentInstructions = instructions.trim() ? instructions : '';
  const instructionsTooLong = utf8Bytes(sentInstructions) > INSTRUCTIONS_BYTES;
  const instructionsControl = DISALLOWED_CONTROL.test(sentInstructions);
  const invalid = tooLong || instructionsTooLong || instructionsControl;
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (pending || !profile.trim() || invalid) return;
    const retrying = unconfirmed !== null;
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
    const notSent = result.kind === 'failed' ? NOT_SENT[result.cause] : undefined;
    if (notSent && !retrying) {
      setUnconfirmed(null);
      setMessage(notSent.first);
      return;
    }
    // A retry that was not sent leaves the earlier outcome unknown: keep its requestId and the locked fields.
    if (notSent) { setMessage(`The retry was not sent: ${notSent.retry}. ${UNCONFIRMED}`); return; }
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
    <label>Instructions<textarea value={instructions} rows={4} maxLength={INSTRUCTIONS_BYTES} disabled={locked} aria-invalid={instructionsTooLong || instructionsControl || undefined} onChange={event => setInstructions(event.target.value)} /></label>
    {instructionsTooLong && <p className="crew-form-message">The instructions are longer than Crew accepts ({INSTRUCTIONS_BYTES} bytes).</p>}
    {instructionsControl && <p className="crew-form-message">The instructions contain control characters Crew does not accept. Only tabs and line breaks are allowed.</p>}
    {message && <p role="alert" className="crew-form-message">{message}</p>}
    <div className="crew-form-actions">
      <button type="submit" disabled={pending || !profile.trim() || invalid}>{pending ? 'Creating…' : unconfirmed ? 'Retry' : 'Create member'}</button>
      <button type="button" onClick={onCancel}>Cancel</button>
    </div>
  </form>;
}
