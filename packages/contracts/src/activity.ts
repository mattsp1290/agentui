import { record } from './decode.js';
import { canonicalJson } from './durable.js';
import { parseCommandActivity, validateCommandUpdate } from './command-activity.js';
import type { CommandActivity } from './command-activity.js';
import { parseFileChangeActivity, validateFileChangeUpdate } from './file-change-activity.js';
import type { FileChangeActivity } from './file-change-activity.js';

export type Activity = CommandActivity | FileChangeActivity;
export function parseActivity(value: unknown): Activity {
  return record(value).kind === 'file-change' ? parseFileChangeActivity(value) : parseCommandActivity(value);
}
export function updateActivity(activities: readonly Activity[], next: Activity): readonly Activity[] {
  const previous = activities.find(item => item.activityId === next.activityId);
  if (!previous) return [...activities, next];
  if (previous.runId !== next.runId || previous.kind !== next.kind) throw new Error('Activity identity changed');
  if (next.revision < previous.revision) return activities;
  if (next.revision === previous.revision) {
    if (canonicalJson(previous) !== canonicalJson(next)) throw new Error('Conflicting activity revision');
    return activities;
  }
  if (previous.kind === 'command' && next.kind === 'command') validateCommandUpdate(previous, next);
  if (previous.kind === 'file-change' && next.kind === 'file-change') validateFileChangeUpdate(previous, next);
  return activities.map(item => item === previous ? next : item);
}
