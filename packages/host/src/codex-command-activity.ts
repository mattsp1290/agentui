import { createHash } from 'node:crypto';
import { canonicalJson } from '@agentui/contracts';
import { COMMAND_OUTPUT_BYTES, COMMAND_TEXT_BYTES, COMMAND_CWD_BYTES, escapedBytes, retainText } from '@agentui/contracts/conversation';
import type { CommandActivity, CommandObservation, TranscriptEvent } from '@agentui/contracts/conversation';
import { object, nonempty } from './codec.js';

type Entry = { activity: CommandActivity; authoritative: boolean; published: CommandActivity | null };
export function createCommandActivity(runId: string, publish: (event: TranscriptEvent) => void) {
  const entries = new Map<string, Entry>();
  const early = new Map<string, { text: string; truncated: boolean }>();
  function delta(itemId: string, text: string): void {
    const entry = entries.get(itemId);
    if (entry?.authoritative) return;
    if (entry) {
      const retained = retainText(text, COMMAND_OUTPUT_BYTES - escapedBytes(entry.activity.output));
      entry.activity = { ...entry.activity, output: entry.activity.output + retained.text,
        outputTruncated: entry.activity.outputTruncated || retained.truncated };
    } else {
      if (!early.has(itemId) && early.size >= 8) return;
      const previous = early.get(itemId) ?? { text: '', truncated: false };
      const total = [...early.values()].reduce((bytes, value) => bytes + escapedBytes(value.text), 0);
      const retained = retainText(text, Math.min(COMMAND_OUTPUT_BYTES - escapedBytes(previous.text), 16_000 - total));
      early.set(itemId, { text: previous.text + retained.text, truncated: previous.truncated || retained.truncated });
    }
  }
  function observe(method: string, value: unknown): boolean {
    const params = object(value);
    if (method === 'item/commandExecution/outputDelta') {
      if (typeof params.delta !== 'string') throw new Error('Invalid Codex command output');
      delta(createHash('sha256').update(nonempty(params.itemId)).digest('hex'), params.delta);
      return true;
    }
    const item = object(params.item);
    if (item.type !== 'commandExecution') return false;
    const nativeId = nonempty(item.id);
    const id = createHash('sha256').update(nativeId).digest('hex');
    if (typeof item.command !== 'string' || typeof item.cwd !== 'string') throw new Error('Invalid Codex command details');
    let status: CommandObservation;
    switch (item.status) {
      case 'inProgress': status = { kind: 'running' }; break;
      case 'declined': status = { kind: 'declined' }; break;
      case 'completed': case 'failed': {
        const exitCode = item.exitCode ?? null;
        if (exitCode !== null && (typeof exitCode !== 'number' || !Number.isInteger(exitCode) ||
          exitCode < -2147483648 || exitCode > 2147483647)) throw new Error('Invalid Codex command exit code');
        status = { kind: item.status, exitCode }; break;
      }
      default: throw new Error('Invalid Codex command status');
    }
    if (item.aggregatedOutput != null && typeof item.aggregatedOutput !== 'string') throw new Error('Invalid Codex command aggregate');
    const previous = entries.get(id);
    const command = retainText(item.command, COMMAND_TEXT_BYTES), cwd = retainText(item.cwd, COMMAND_CWD_BYTES);
    const detailsTruncated = command.truncated || cwd.truncated;
    if (previous && (previous.activity.command !== command.text || previous.activity.cwd !== cwd.text ||
      previous.activity.detailsTruncated !== detailsTruncated)) throw new Error('Codex command identity changed');
    if (previous && previous.activity.status.kind !== 'running') {
      if (status.kind === 'running') return true;
      if (canonicalJson(previous.activity.status) !== canonicalJson(status)) throw new Error('Contradictory Codex command outcome');
    }
    const authoritative = status.kind !== 'running' && typeof item.aggregatedOutput === 'string';
    const retained = typeof item.aggregatedOutput === 'string' && (authoritative || !previous)
      ? retainText(item.aggregatedOutput, COMMAND_OUTPUT_BYTES)
      : { text: previous?.activity.output ?? early.get(id)?.text ?? '', truncated: previous?.activity.outputTruncated ?? early.get(id)?.truncated ?? false };
    if (previous?.authoritative && authoritative && (previous.activity.output !== retained.text || previous.activity.outputTruncated !== retained.truncated)) {
      throw new Error('Contradictory Codex command output');
    }
    const activity: CommandActivity = { kind: 'command', activityId: createHash('sha256').update(JSON.stringify([runId, nativeId])).digest('hex'),
      runId, revision: previous?.activity.revision ?? 1, command: command.text, cwd: cwd.text, detailsTruncated,
      status, output: retained.text, outputTruncated: retained.truncated };
    entries.set(id, { activity, authoritative: previous?.authoritative || authoritative, published: previous?.published ?? null });
    early.delete(id);
    return true;
  }
  function flush(): void {
    for (const entry of entries.values()) {
      if (entry.published && canonicalJson(entry.activity) === canonicalJson(entry.published)) continue;
      const activity = { ...entry.activity, revision: (entry.published?.revision ?? 0) + 1 };
      publish({ kind: 'command-updated', activity });
      entry.activity = activity; entry.published = activity;
    }
  }
  return { observe, flush };
}
