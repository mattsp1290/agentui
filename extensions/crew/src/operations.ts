import { z } from 'zod';
import { CrewClient, CrewHttpError, CrewTransportError, CrewUnknownOutcomeError } from '@birbcrew/client';
import type { ExtensionOperation, ExtensionOperationCall, ExtensionOperationResult, ServerProviderCredentials } from '@agentui/sdk';
import { eachMemberPage, MAX_CREW_MEMBERS } from './members.js';
import type { MemberSummary, MembersCreateOutput, MembersListOutput } from './operation-output.js';

/** Each operation's own deadline, below the host's 15-second reply deadline. */
const OPERATION_TIMEOUT_MS = 10_000;
const engineSchema = z.enum(['pi', 'claude', 'codex']);
const listInput = z.strictObject({});
/** Crew bounds `profile` in UTF-8 bytes (`x-maxUtf8Bytes: 128`), not UTF-16 code units. */
const profileSchema = z.string().min(1).refine(value => Buffer.byteLength(value, 'utf8') <= 128, 'profile too long');
/** Crew bounds `instructions` to 16,384 UTF-8 bytes of well-formed text with no control characters but tab and newline. */
const DISALLOWED_CONTROL = /(?![\t\n])\p{Cc}/u;
const instructionsSchema = z.string().min(1).refine(value => value.isWellFormed() && !DISALLOWED_CONTROL.test(value) &&
  Buffer.byteLength(value, 'utf8') <= 16_384, 'instructions not accepted by Crew');
const createInput = z.strictObject({ requestId: z.uuid(), engine: engineSchema, profile: profileSchema,
  instructions: instructionsSchema.optional() });
/** Keeps `members.list` well under the host's 256,000-byte operation output limit. */
const LIST_BUDGET_BYTES = 200_000;
type Refusal = { readonly kind: 'refused'; readonly code: string };
const refused = (code: string): Refusal => ({ kind: 'refused', code });

/** `listMembers` sends no command, so an aborted fetch throws the signal reason rather than `CrewTransportError`. */
function aborted(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');
}

/** Crew errors never cross the credential boundary: each is classified into a fixed refusal code inside the action. */
function refusal(error: unknown, create: boolean): Refusal {
  if (error instanceof CrewUnknownOutcomeError) return refused('unknown-outcome');
  if (error instanceof CrewTransportError || aborted(error)) return refused(create ? 'unknown-outcome' : 'unreachable');
  if (error instanceof CrewHttpError) {
    if (error.code === 'unknown_profile') return refused('unknown-profile');
    if (error.status === 401 || error.status === 403) return refused('unauthorized');
    if (error.status >= 400 && error.status < 500) return refused('rejected');
    return refused(create ? 'unknown-outcome' : 'unreachable');
  }
  return refused(create ? 'unknown-outcome' : 'rejected');
}

function operation(credentials: ServerProviderCredentials, create: boolean,
  run: (client: CrewClient, input: unknown, signal: AbortSignal) => Promise<ExtensionOperationResult>): ExtensionOperation {
  return {
    async run(call: ExtensionOperationCall): Promise<ExtensionOperationResult> {
      if (!call.credential) return refused('unauthorized');
      const signal = AbortSignal.any([call.signal, AbortSignal.timeout(OPERATION_TIMEOUT_MS)]);
      try {
        return await credentials.use({ credential: call.credential, service: call.installation.service }, async token => {
          try { return await run(new CrewClient({ baseUrl: call.installation.service, token }), call.input, signal); }
          catch (error) { return refusal(error, create); }
        });
      } catch { return refused('unauthorized'); }
    },
  };
}

/**
 * Collects listed members into `members` in Crew order, cut by count and by a byte budget for the encoded output. The
 * returned visitor stops the page walk, so `members.list` reports `truncated`, at the first member that does not fit.
 */
export function listedMembers(members: MemberSummary[]): (page: readonly Pick<MemberSummary, 'memberId' | 'engine' | 'profile'>[]) => 'truncated' | undefined {
  let bytes = 0;
  return page => {
    for (const member of page) {
      if (members.length >= MAX_CREW_MEMBERS) return 'truncated';
      const item = { memberId: member.memberId, engine: member.engine, profile: member.profile };
      bytes += Buffer.byteLength(JSON.stringify(item)) + 1;
      if (bytes > LIST_BUDGET_BYTES) return 'truncated';
      members.push(item);
    }
    return undefined;
  };
}

/** `members.list` and `members.create`, registered once per namespace. */
export function crewOperations(credentials: ServerProviderCredentials): Readonly<Record<string, ExtensionOperation>> {
  return {
    'members.list': operation(credentials, false, async (client, input, signal) => {
      if (!listInput.safeParse(input).success) return refused('invalid-input');
      const members: MemberSummary[] = [];
      const visit = listedMembers(members);
      const read = await eachMemberPage(client, () => signal, visit);
      if (read.kind === 'invalid') return refused('rejected');
      const output: MembersListOutput = { members, truncated: read.kind === 'stopped' };
      return { kind: 'ok', output };
    }),
    'members.create': operation(credentials, true, async (client, input, signal) => {
      const parsed = createInput.safeParse(input);
      if (!parsed.success) return refused('invalid-input');
      const { requestId, engine, profile, instructions } = parsed.data;
      const created = await client.createMember({ requestId, engine, profile, ...(instructions === undefined ? {} : { instructions }) }, { signal });
      const output: MembersCreateOutput = { member: { memberId: created.memberId, engine: created.engine, profile: created.profile } };
      return { kind: 'ok', output, agentsChanged: true };
    }),
  };
}
