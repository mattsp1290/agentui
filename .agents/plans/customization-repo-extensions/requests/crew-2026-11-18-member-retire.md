# Retire a member

Requested by: AgentUI planning session for the plan `customization-repo-extensions`.
Date: 2026-11-18.
Target repository: existing Crew (`mattsp1290/crew`).
Status: proposed. No implementation exists. On 2026-11-18 the owner confirmed in the AgentUI planning session that retire (member hidden, history kept, cannot be undone) is acceptable as the Delete action.
Priority: blocking for AgentUI work package WP10 only.
Decision owner: Matt (owner of both repositories).
Relation to earlier request: this carves item 3 (retire), the matching client method and the capability block out of `2026-11-17-member-management-for-agentui.md` and asks for them first. The other items of that request stay proposed and are not needed by this plan.

## Consumers and evidence

Planned consumer: AgentUI work package WP10 (Delete in the Crew workspace). The owner asked for delete support on 2026-11-18 and stated that it needs changes in all three repositories. Nothing in AgentUI calls a retire route today.

Observed Crew revision: `origin/main` at `775fd7299d186c2c75d9c59e9285ad66b2631c05`.

## Background

A Crew member cannot be deleted. A trigger forbids it, conversations reference members, and the audit trail has no deletion route. Crew already uses state plus tombstone for routines, instruction packs and memories. A for-and-against debate recorded in the AgentUI plan `extensions-nav-crew-coworkers` concluded that a tombstone-style retire fits Crew's mission and that hard delete does not. AgentUI presents retire as its Delete action and tells the user that history is kept.

## Requested contract

1. `POST /v1/members/{memberId}/retire` with body `{}`. Idempotent like grant revoke: repeating it returns the same record.
2. Record retirement in an insert-only table so the `members` row stays immutable.
3. After retirement, refuse a new conversation, a handoff that targets the member, and routine creation or firing with `409 member_retired`. Keep existing conversations and history readable. Let in-flight requests finish.
4. `GET /v1/members` omits retired members by default. A strict query parameter includes them.
5. Record an audit event.
6. Client package: `retireMember({memberId})`, guarded by the capability.
7. Advertise the feature in a versioned capability block, following the `handoffs` and `standingGrants` pattern. Keep `apiVersion` at `"1"`.

## Exclusions

- Hard delete, and any change to a member's instructions, engine or profile.
- Member name, single-member read and profile listing. They remain in the earlier request.
- Authentication, the loopback bind, the AG-UI observation route, frontend tools.

## Acceptance criteria

- `npm run check:openapi` passes with the regenerated document. Crew's root `package.json` declares `"os": ["linux"]`, so these gates run on Linux.
- A consumer test creates a member, opens a conversation, retires the member, observes `409 member_retired` on a new conversation, reads the old conversation, and observes that the default member list omits the member.
- A server without the capability block works with the new client: `retireMember` reports unsupported without a protocol error.
- A packed `@birbcrew/client` tarball exists at an exact Crew commit that AgentUI can vendor under `vendor/crew-client/<commit>/`.

## Affected AgentUI work packages

- WP9 (upstream work package U-Crew) implements this request in the Crew repository.
- WP10 adopts it and is blocked until the response names an exact commit and tarball.

## Response and unblock

Respond at `$HOME/.agents/projects/crew/responses/2026-11-18-member-retire.md`. State accepted, declined or needs-decision per numbered item, the delivered contract, and the exact 40-character commit. Owner acceptance is separate from implementation delivery.
