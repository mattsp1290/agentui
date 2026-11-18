import type { Json } from '@agentui/contracts';

// The output of `members.list`, shared by the server operation and the desktop workspace. No node or Crew imports: the
// desktop bundle imports this module. Type aliases, not interfaces, so the outputs are assignable to `Json`.
export type MemberSummary = { readonly memberId: string; readonly engine: string; readonly profile: string };
export type MembersListOutput = { readonly members: readonly MemberSummary[]; readonly truncated: boolean };

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isMember = (value: unknown): value is MemberSummary => isRecord(value) &&
  typeof value.memberId === 'string' && typeof value.engine === 'string' && typeof value.profile === 'string';

/** Reads a `members.list` output, keeping well-formed members; `null` when the output itself is malformed. */
export function membersListOutput(value: Json): MembersListOutput | null {
  if (!isRecord(value) || !Array.isArray(value.members) || typeof value.truncated !== 'boolean') return null;
  return { members: value.members.filter(isMember), truncated: value.truncated };
}
