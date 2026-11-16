import type { Transcript } from '@agentui/contracts/conversation';
import { activityStatus } from './activity-status.js';

export function CommandActivity({ transcript, connected, paused = false }: { readonly transcript: Transcript; readonly connected: boolean; readonly paused?: boolean }) {
  const commands = transcript.activities?.filter(activity => activity.kind === 'command');
  if (!commands?.length) return null;
  return <section className="command-activity" aria-label="Commands">
    <h2>Commands</h2>
    {commands.map(activity => <details key={activity.activityId} className="command-activity-row">
      <summary><code>{activity.command || 'Command'}</code><span>{activityStatus(activity, transcript, connected, paused)}</span></summary>
      <p className="command-directory">Working directory: {activity.cwd || 'Not provided'}</p>
      {activity.detailsTruncated && <p>Command details truncated.</p>}
      {activity.output ? <pre aria-label="Command output">{activity.output}</pre> : <p>No output captured.</p>}
      {activity.outputTruncated && <p>Output truncated. Showing the retained beginning.</p>}
    </details>)}
  </section>;
}
