import type { CommandActivity as Activity, Transcript } from '@agentui/contracts/conversation';

function status(activity: Activity, transcript: Transcript, connected: boolean): string {
  const observed = activity.status;
  if (observed.kind === 'running') {
    const run = transcript.currentRun;
    if (!run || run.runId !== activity.runId || run.kind === 'ended') return 'Outcome not observed';
    return connected ? 'Running' : 'Last observed running · reconnecting';
  }
  const label = observed.kind === 'completed' ? 'Completed' : observed.kind === 'failed' ? 'Failed' : 'Declined';
  return 'exitCode' in observed && observed.exitCode !== null ? `${label} · exit ${observed.exitCode}` : label;
}
export function CommandActivity({ transcript, connected }: { readonly transcript: Transcript; readonly connected: boolean }) {
  if (!transcript.activities?.length) return null;
  return <section className="command-activity" aria-label="Commands">
    <h2>Commands</h2>
    {transcript.activities.map(activity => <details key={activity.activityId} className="command-activity-row">
      <summary><code>{activity.command || 'Command'}</code><span>{status(activity, transcript, connected)}</span></summary>
      <p className="command-directory">Working directory: {activity.cwd || 'Not provided'}</p>
      {activity.detailsTruncated && <p>Command details truncated.</p>}
      {activity.output ? <pre aria-label="Command output">{activity.output}</pre> : <p>No output captured.</p>}
      {activity.outputTruncated && <p>Output truncated. Showing the retained beginning.</p>}
    </details>)}
  </section>;
}
