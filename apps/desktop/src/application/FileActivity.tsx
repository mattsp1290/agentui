import type { Transcript } from '@agentui/contracts/conversation';
import { activityStatus } from './activity-status.js';

export function FileActivity({ transcript, connected, paused = false }: { readonly transcript: Transcript; readonly connected: boolean; readonly paused?: boolean }) {
  const files = transcript.activities?.filter(activity => activity.kind === 'file-change');
  if (!files?.length) return null;
  return <section className="command-activity" aria-label="File changes">
    <h2>File changes</h2>
    {files.map(activity => <details key={activity.activityId} className="command-activity-row">
      <summary><code>{activity.changes.map(change => change.path || 'Path not provided').join(', ') || 'File change'}</code>
        <span>{activityStatus(activity, transcript, connected, paused)}</span></summary>
      {activity.changes.map((change, index) => <div key={index}>
        <p>{change.operation === 'add' ? 'Add' : change.operation === 'delete' ? 'Delete' : 'Update'} <code>{change.path || 'Path not provided'}</code>
          {change.operation === 'update' && change.movedTo !== null && <> → <code>{change.movedTo || 'Destination not provided'}</code></>}</p>
        {change.detailsTruncated && <p>File path details truncated.</p>}
        {change.patch ? <><p>Reported patch</p><pre aria-label="Reported patch">{change.patch}</pre></> : <p>No reported patch retained.</p>}
        {change.patchTruncated && <p>Reported patch truncated. Showing the retained beginning.</p>}
      </div>)}
      {activity.changes.length === 0 && <p>No file changes reported.</p>}
      {activity.omittedChanges > 0 && <p>{activity.omittedChanges} additional file changes omitted.</p>}
    </details>)}
  </section>;
}
