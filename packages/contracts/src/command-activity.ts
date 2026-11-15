import { record, identifier, count, utf8Bytes } from './decode.js';

export const COMMAND_OUTPUT_BYTES = 8_000;
export const COMMAND_TEXT_BYTES = 4_000;
export const COMMAND_CWD_BYTES = 1_000;
export type CommandObservation =
  | { readonly kind: 'running' | 'declined' }
  | { readonly kind: 'completed' | 'failed'; readonly exitCode: number | null };
export interface CommandActivity {
  readonly kind: 'command';
  readonly activityId: string;
  readonly runId: string;
  readonly revision: number;
  readonly command: string;
  readonly cwd: string;
  readonly detailsTruncated: boolean;
  readonly status: CommandObservation;
  readonly output: string;
  readonly outputTruncated: boolean;
}
export function escapedBytes(text: string): number { return utf8Bytes(JSON.stringify(text)) - 2; }
export function retainText(text: string, limit: number): { readonly text: string; readonly truncated: boolean } {
  let bytes = 0, offset = 0;
  for (const character of text) {
    const cost = escapedBytes(character);
    if (bytes + cost > limit) return { text: text.slice(0, offset), truncated: true };
    bytes += cost; offset += character.length;
  }
  return { text, truncated: false };
}
function boundedText(value: unknown, limit: number): string {
  if (typeof value !== 'string' || escapedBytes(value) > limit) throw new Error('Invalid command activity text');
  return value;
}
export function parseCommandActivity(value: unknown): CommandActivity {
  const input = record(value, ['kind', 'activityId', 'runId', 'revision', 'command', 'cwd', 'detailsTruncated', 'status', 'output', 'outputTruncated']);
  if (input.kind !== 'command' || typeof input.detailsTruncated !== 'boolean' || typeof input.outputTruncated !== 'boolean') {
    throw new Error('Invalid command activity');
  }
  const revision = count(input.revision);
  if (revision < 1) throw new Error('Invalid command revision');
  const observed = record(input.status);
  let status: CommandObservation;
  if (observed.kind === 'running' || observed.kind === 'declined') {
    record(observed, ['kind']); status = { kind: observed.kind };
  } else if (observed.kind === 'completed' || observed.kind === 'failed') {
    record(observed, ['kind', 'exitCode']);
    if (observed.exitCode !== null && (typeof observed.exitCode !== 'number' || !Number.isInteger(observed.exitCode) ||
      observed.exitCode < -2147483648 || observed.exitCode > 2147483647)) throw new Error('Invalid command exit code');
    status = { kind: observed.kind, exitCode: observed.exitCode };
  } else throw new Error('Invalid command status');
  return { kind: 'command', activityId: identifier(input.activityId), runId: identifier(input.runId), revision,
    command: boundedText(input.command, COMMAND_TEXT_BYTES), cwd: boundedText(input.cwd, COMMAND_CWD_BYTES),
    detailsTruncated: input.detailsTruncated, status, output: boundedText(input.output, COMMAND_OUTPUT_BYTES), outputTruncated: input.outputTruncated };
}
export function updateCommandActivity(activities: readonly CommandActivity[], next: CommandActivity): readonly CommandActivity[] {
  const previous = activities.find(item => item.activityId === next.activityId);
  if (!previous) return [...activities, next];
  if (next.revision < previous.revision) return activities;
  if (next.revision === previous.revision) {
    if (JSON.stringify(previous) !== JSON.stringify(next)) throw new Error('Conflicting command revision');
    return activities;
  }
  if (previous.runId !== next.runId || previous.command !== next.command || previous.cwd !== next.cwd ||
    previous.detailsTruncated !== next.detailsTruncated) throw new Error('Command identity changed');
  if (previous.status.kind !== 'running' && JSON.stringify(previous.status) !== JSON.stringify(next.status)) {
    throw new Error('Terminal command outcome changed');
  }
  return activities.map(item => item === previous ? next : item);
}
