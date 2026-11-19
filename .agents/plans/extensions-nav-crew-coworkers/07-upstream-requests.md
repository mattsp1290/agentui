# Upstream changes: debate verdicts and request map

The user allowed changes to Crew and crabber-coworkers only when they fit each repository's mission, and asked that subagents argue the question first. For each repository, one subagent argued that each candidate change belongs upstream and one argued that it does not. Both read the upstream source. The planning agent judged each item. This file records the verdicts. The request documents carry the contracts.

Nothing in this file is implemented or accepted upstream.

## Crew

Observed revision: `origin/main` at `775fd7299d186c2c75d9c59e9285ad66b2631c05`. Mission (README): "Crew runs durable Claude, Codex and Pi coding coworkers through their TypeScript SDKs."

| Candidate | For | Against | Verdict |
|---|---|---|---|
| Member name set at creation, and `GET /v1/members/{memberId}` | Strong. Instruction packs already have a `name`. Every other owner resource has a single-item read. A name written in the insert transaction does not touch the immutability trigger. | Weak. The opposing side conceded the read and could only note that a fixed name cannot be corrected. | Request it. |
| Update a member's instructions, engine or profile | Conceded by the supporting side. | Strong. `docs/member-instructions.md` records why instructions are fixed: engines replay the first-turn prompt differently, a restore could resurrect replaced text, and a fixed role needs no snapshot table. | Do not request. AgentUI models an edit as replace-then-retire (decision D8). The owner confirms that this satisfies "update" before WP9 (unresolved decision U3). |
| Rename a member after creation | Weak. Possible with an insert-only label table. | Moderate. Nothing in Crew models editable metadata. | Do not request. Recorded as unresolved decision U1 for the owner. |
| Hard delete a member | Conceded by the supporting side. | Strong. Conversations reference members, the audit trail has no deletion route, and a trigger forbids it. | Do not request. |
| Retire a member | Moderate to strong. Crew already uses state plus tombstone for routines, packs and memories. Retirement completes the documented "spawn another member" workflow and stops routines, which a client-side hide cannot do. | Weak. The opposing side conceded that a tombstone-style retire belongs in Crew. | Request it. |
| `GET /v1/profiles` | Moderate. Owners can only pick registered profiles, yet no route lists them. The member list already exposes profile names. | Moderate. Profiles are operator configuration. In a single-user deployment the operator is the owner. | Request a projection of engine and name only. |
| Client methods for the existing instructions route and for the items above | Strong. They wrap stable v1 routes. | Conceded. | Request `memberInstructions`, `member`, `retireMember` and `listProfiles`. |
| Client `listConversations` | Strong. It wraps a stable v1 route. | Conceded. | In mission, but not requested: no work package in this plan calls it. AgentUI lists conversations from its own catalog. |

Request document: `$HOME/.agents/projects/crew/requests/2026-11-17-member-management-for-agentui.md`.

Effect on this plan:

- WP5 and WP6 need nothing new from Crew.
- WP9 needs the U-Crew delivery. Gate G2 holds it.
- If the owner declines retire, Crew Delete stays disabled and the full-outcome success criterion for Crew cannot be met without a new decision from the owner.

## crabber-coworkers

Observed revision: `44ed2ad8326a4822a67a3eeca4087cfc98f03df8`. Mission (README): "A Rust port of the OpenDots idea of always-on AI coworkers, built on crabber. It answers prompts from configured coworkers on the command line, in Slack, and over an HTTP API, with durable conversations."

| Candidate | For | Against | Verdict |
|---|---|---|---|
| Create, update and delete coworkers over the API with durable storage and no restart | Moderate to strong. The vision file names persistent identity (name, role, instructions, history) as the first evaluation lens, and the ported product lets users create its agents. `docs/http-api.md` lists coworker creation among things the repository does not have yet, not among its stated non-goals. Stores and workspaces are already created on first use. | Strong on design cost: `config.json` is operator-owned and validated as a whole; the single token would gain the power to rewrite instructions; borb workers load configuration separately; Slack bindings need environment tokens. The AgentUI-side alternative (edit `config.json` and restart `serve`) fails when the service runs on another machine and interrupts Slack and in-flight requests. | Request it in the shape that answers the objections: API-managed coworkers in a separate store, `config.json` coworkers read-only with a `source` field, no Slack binding through the API, and two explicit owner decisions (borb, token scope). |
| `GET /v1/coworkers/{coworkerId}` with instruction text | Moderate. Update needs to read the current text. The token already reads every conversation. | Moderate. The list deliberately returns only bytes and digest. | Request it as a single-item read. The list stays unchanged. |
| Message and conversation times, recency ordering | Strong. The store already has the columns and the API already emits one RFC 3339 time. | Conceded. | In mission, but not requested: AgentUI's transcript and catalog have no time field to carry them, so no work package would consume them. |
| Reply streaming | Moderate, and blocked: the deferred AG-UI route waits on `crabber-agui` being consumable without a `[patch]` section, which `AGENTS.md` forbids. | Moderate. A home-grown stream would duplicate that crate. | Do not request. AgentUI polls (decision D7). |

Request document: `$HOME/.agents/projects/crabber-coworkers/requests/2026-11-17-coworker-management-api.md`.

Effect on this plan:

- WP7 and WP8 need nothing new upstream. They deliver list, read without instruction text, and chat.
- WP10 needs the U-Coworkers delivery. Gate G3 holds it.
- If the owner declines API-managed coworkers, Create, Edit and Delete stay disabled for Coworkers and the full-outcome success criterion for Coworkers cannot be met without a new decision from the owner.

## Upstream work packages

The owner of this repository owns both upstream repositories and treats upstream blockers as work to do, not as external waits. The upstream changes are therefore work packages of this plan. They run in the upstream repositories, not in AgentUI pull requests.

| WP | Repository | Input | Result | Prerequisite |
|---|---|---|---|---|
| U-Crew | Crew (`mattsp1290/crew`) | The Crew request document | The accepted items implemented on a Crew branch and merged by Crew's own process; a response file with the exact commit; a packed `@birbcrew/client` tarball at that commit | The owner's answer to U3 |
| U-Coworkers | crabber-coworkers (`mattsp1290/crabber-coworkers`) | The crabber-coworkers request document | The accepted items implemented and merged by that repository's own process; a response file with the exact commit; the regenerated OpenAPI document | The owner's answers to both parts of U2 |

Rules for both:

- Work from a fresh checkout of the upstream default branch. The local Crew checkout at `$HOME/git/crew` was 273 commits behind when this plan was written.
- Follow the upstream repository's own contributor rules, tests and review process. Each upstream change gets its own plan in that repository when the repository's rules ask for one.
- Write the response file at the path the request names. State accepted, declined or needs-decision per item, the delivered contract and the 40-character commit.
- U-Crew and U-Coworkers can run at any time after their owner decisions. They do not depend on WP1–WP8.

## Rules for the AgentUI implementer

- Do not implement upstream changes inside this repository's pull requests. Upstream work happens in U-Crew and U-Coworkers.
- Before WP9 or WP10, read the response file. Build against the delivered contract, not against the request text.
- Refresh a vendored pin before building on it. Record the exact upstream commit in the pull request.
