import { z } from 'zod';
import { CrewClient, CrewHttpError, CrewTransportError, CrewUnknownOutcomeError } from '@birbcrew/client';
import type { ExtensionOperation, ExtensionOperationCall, ExtensionOperationResult, ServerProviderCredentials } from '@agentui/sdk';
import { MAX_CREW_MEMBERS } from './provider.js';

/** Each operation's own deadline, below the host's 15-second reply deadline. */
const OPERATION_TIMEOUT_MS = 10_000;
const engineSchema = z.enum(['pi', 'claude', 'codex']);
const listInput = z.strictObject({});
/** Crew bounds `profile` in UTF-8 bytes (`x-maxUtf8Bytes: 128`), not UTF-16 code units. */
const profileSchema = z.string().min(1).refine(value => Buffer.byteLength(value, 'utf8') <= 128, 'profile too long');
const createInput = z.strictObject({ requestId: z.uuid(), engine: engineSchema, profile: profileSchema,
  instructions: z.string().min(1).max(16_384).optional() });
type Refusal = { readonly kind: 'refused'; readonly code: string };
const refused = (code: string): Refusal => ({ kind: 'refused', code });

/** Crew errors never cross the credential boundary: each is classified into a fixed refusal code inside the action. */
function refusal(error: unknown, create: boolean): Refusal {
  if (error instanceof CrewUnknownOutcomeError) return refused('unknown-outcome');
  if (error instanceof CrewTransportError) return refused('unreachable');
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

/** `members.list` and `members.create`, registered once per namespace. */
export function crewOperations(credentials: ServerProviderCredentials): Readonly<Record<string, ExtensionOperation>> {
  return {
    'members.list': operation(credentials, false, async (client, input, signal) => {
      if (!listInput.safeParse(input).success) return refused('invalid-input');
      const members: { memberId: string; engine: string; profile: string }[] = [];
      const seen = new Set<string>();
      let after: string | undefined, truncated = false;
      do {
        const page = await client.listMembers(after ? { after } : {}, { signal });
        for (const member of page.members) {
          if (members.length >= MAX_CREW_MEMBERS) { truncated = true; break; }
          members.push({ memberId: member.memberId, engine: member.engine, profile: member.profile });
        }
        if (truncated || !page.next) break;
        if (seen.has(page.next) || seen.size >= 100) return refused('rejected');
        seen.add(page.next); after = page.next;
      } while (after);
      return { kind: 'ok', output: { members, truncated } };
    }),
    'members.create': operation(credentials, true, async (client, input, signal) => {
      const parsed = createInput.safeParse(input);
      if (!parsed.success) return refused('invalid-input');
      const { requestId, engine, profile, instructions } = parsed.data;
      const created = await client.createMember({ requestId, engine, profile, ...(instructions === undefined ? {} : { instructions }) }, { signal });
      return { kind: 'ok', output: { member: { memberId: created.memberId, engine: created.engine, profile: created.profile } }, agentsChanged: true };
    }),
  };
}
