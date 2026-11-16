import { useEffect, useState } from 'react';
import type { OutboxEntry } from '@agentui/client';
import type { ConversationPermission } from '@agentui/contracts';
import type { ConversationActions, PermissionState } from './application-controller.js';

export function ConversationPermissions({ state, actions, enabled, outbox }: {
  readonly outbox: readonly OutboxEntry[];
  readonly state: PermissionState; readonly actions: ConversationActions; readonly enabled: boolean;
}) {
  const [confirming, setConfirming] = useState<ConversationPermission | null>(null);
  const [error, setError] = useState('');
  const listing = 'listing' in state ? state.listing : null;
  const fresh = enabled && state.kind === 'fresh';
  const unresolved = new Set(outbox.flatMap(entry => entry.command.body.kind === 'revoke-permission' ? [entry.command.body.permissionId] : []));
  useEffect(() => {
    const refresh = () => { if (enabled) void actions.permissions.read().catch(() => {}); };
    window.addEventListener('focus', refresh);
    return () => window.removeEventListener('focus', refresh);
  }, [actions, enabled]);
  async function revoke(permission: ConversationPermission) {
    setConfirming(null);
    setError('');
    try { await actions.commands.revokePermission(permission.permissionId, permission.scope); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Revocation failed. Refresh permissions.'); }
  }
  function refresh() {
    setConfirming(null);
    setError('');
    void actions.permissions.read().catch(() => {});
  }
  return <section aria-label="Permissions" className="permissions-panel" onFocus={event => {
    if (!event.currentTarget.contains(event.relatedTarget) && enabled && state.kind === 'stale') refresh();
  }}>
    <h2>Permissions</h2>
    {state.kind !== 'fresh' && <p role="status">{state.reason}</p>}
    {listing && <>
      <p>Last checked <time dateTime={listing.observedAt}>{new Date(listing.observedAt).toLocaleString()}</time>{state.kind !== 'fresh' ? ' · Refresh required' : ''}</p>
      {listing.permissions.length === 0 && <p>No active work-item permissions were found.</p>}
      {listing.permissions.map(permission => <div key={permission.permissionId}>
        <h3>{permission.actionLabel} · {permission.scope === 'agent' ? 'All conversations for this member' : 'This conversation'}</h3>
        <p>{permission.detail}</p>
        {unresolved.has(permission.permissionId) && <p>The earlier revoke acknowledgement is unknown. Revoke again sends a new command. Its result leaves the earlier acknowledgement unknown.</p>}
        <button type="button" disabled={!fresh} onClick={() => permission.scope === 'agent' ? setConfirming(permission) : void revoke(permission)}>
          {unresolved.has(permission.permissionId) ? 'Revoke again' : permission.scope === 'agent' ? 'Revoke for this member in all conversations' : 'Revoke for this conversation'}
        </button>
      </div>)}
      {listing.permissions.length > 0 && <p>These permissions cover future owner-initiated work items, including different notes. Changing the model or profile keeps them. Revocation applies to later proposals. Already-approved work may finish. Any remaining member permission still applies across conversations.</p>}
    </>}
    {confirming && fresh && listing?.permissions.some(row => row.permissionId === confirming.permissionId && row.scope === 'agent') &&
      <div role="group" aria-label="Confirm all-conversations revocation">
        <p>Revoke this member’s work-item permission in all conversations? Already-approved work may finish.</p>
        <button type="button" onClick={() => void revoke(confirming)}>Confirm revoke in all conversations</button>
        <button type="button" onClick={() => setConfirming(null)}>Keep permission</button>
      </div>}
    {error && <p role="alert">{error}</p>}
    <button type="button" disabled={!enabled || state.kind === 'loading'} onClick={refresh}>Refresh permissions</button>
  </section>;
}
