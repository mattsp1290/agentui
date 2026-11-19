import type { CrewClient } from '@birbcrew/client';

/** The host rejects a discovery with more agents than this, and `members.list` truncates at it. */
export const MAX_CREW_MEMBERS = 1000;
/** Crew's member pagination is invalid past this many distinct cursors. */
const MAX_MEMBER_PAGES = 100;
export type CrewMemberPage = Awaited<ReturnType<CrewClient['listMembers']>>['members'];
export type MemberPages<T> = { readonly kind: 'stopped'; readonly value: T } | { readonly kind: 'end' } | { readonly kind: 'invalid' };

/**
 * Reads Crew's member pages in order. Stops at the first page for which `visit` returns a value, or after the last page.
 * Returns `invalid` when a cursor repeats or the cursors run past 100 pages. Each request gets its own `signal()`.
 */
export async function eachMemberPage<T>(client: CrewClient, signal: () => AbortSignal,
  visit: (members: CrewMemberPage) => T | undefined): Promise<MemberPages<T>> {
  const seen = new Set<string>();
  let after: string | undefined;
  for (;;) {
    const page = await client.listMembers(after ? { after } : {}, { signal: signal() });
    const value = visit(page.members);
    if (value !== undefined) return { kind: 'stopped', value };
    if (!page.next) return { kind: 'end' };
    if (seen.has(page.next) || seen.size >= MAX_MEMBER_PAGES) return { kind: 'invalid' };
    seen.add(page.next); after = page.next;
  }
}
