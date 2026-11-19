import type { Json } from '@agentui/contracts';

// The output of `coworkers.list`, shared by the server operation and the desktop workspace. No node imports: the desktop
// bundle imports this module. Type aliases, not interfaces, so the outputs are assignable to `Json`.
export type CoworkerSummary = { readonly coworkerId: string; readonly name: string; readonly role: string; readonly workspace: string;
  readonly slack: boolean; readonly instructionsBytes: number };
export type CoworkersListOutput = { readonly management: boolean; readonly coworkers: readonly CoworkerSummary[]; readonly truncated: boolean };

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isCoworker = (value: unknown): value is CoworkerSummary => isRecord(value) && typeof value.coworkerId === 'string' &&
  typeof value.name === 'string' && typeof value.role === 'string' && typeof value.workspace === 'string' &&
  typeof value.slack === 'boolean' && typeof value.instructionsBytes === 'number';

/** Reads a `coworkers.list` output, keeping well-formed coworkers; `null` when the output itself is malformed. */
export function coworkersListOutput(value: Json): CoworkersListOutput | null {
  if (!isRecord(value) || !Array.isArray(value.coworkers) || typeof value.management !== 'boolean' || typeof value.truncated !== 'boolean') return null;
  return { management: value.management, coworkers: value.coworkers.filter(isCoworker), truncated: value.truncated };
}
