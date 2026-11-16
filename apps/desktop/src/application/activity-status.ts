import type { Activity, Transcript } from '@agentui/contracts/conversation';

export function activityStatus(activity: Activity, transcript: Transcript, connected: boolean, paused: boolean): string {
  const observed = activity.status;
  if (observed.kind === 'running' || observed.kind === 'unknown') {
    const run = transcript.currentRun;
    if (!run || run.runId !== activity.runId || run.kind === 'ended') return 'Outcome not observed';
    if (observed.kind === 'unknown') return 'Outcome not observed';
    if (paused) return 'Last observed running · updates paused';
    return connected ? 'Running' : 'Last observed running · reconnecting';
  }
  const label = observed.kind === 'completed' ? 'Completed' : observed.kind === 'failed' ? 'Failed' : 'Declined';
  return 'exitCode' in observed && observed.exitCode !== null ? `${label} · exit ${observed.exitCode}` : label;
}
