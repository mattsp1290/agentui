# Example customization

This directory is a customization package that enables the two in-repository extensions, Crew (`extensions/crew`) and Coworkers (`extensions/coworkers`). AgentUI's default build contains no extensions; you enable them by connecting a customization repository such as this one.

`package.json` lists both extensions as same-repository references and carries one installation grant for each. `agentui-settings.json` holds the client settings that AgentUI stores in the connected repository. See [Committed customization sources](../../docs/customization/sources.md) for the format.

## Connect it

In AgentUI, open Settings and connect a customization repository with:

- **Repository**: the location of an AgentUI repository you can push to, for example your fork's SSH address or a local clone's absolute path.
- **Branch**: a dedicated branch, for example `customization`.
- **Subdirectory**: `examples/customization`.

AgentUI clones that branch on the machine that runs the launcher. When you turn an extension on or off, or change a setting, it commits the change to that branch and pushes it with that machine's git credentials. It never force-pushes.

Use a dedicated branch or a fork, not `main`. Connecting `main` or `master` makes AgentUI push its commits directly there, and the UI asks you to confirm that.

## Keep the branch current

The extension code that runs is the code on the connected branch, not the code in your AgentUI checkout. Every extension change merged to `main` reaches you only after you merge `main` into the connected branch.

The extensions on the connected branch must also target the running AgentUI's SDK version. After an AgentUI update that changes the SDK version, merge `main` into the connected branch; until then the build reports that the extensions target a different AgentUI version.

## Services and tokens

The two `service` addresses in `installations` are placeholders for a local setup: Crew at `http://127.0.0.1:18089` and Coworkers at `http://127.0.0.1:8787`. Change them to your services' addresses and commit the change to the connected branch. A host on another machine reaches each service over the private overlay network.

Grants name token variables and never hold a token. Set both variables in the shell that runs the launcher, then start AgentUI:

- `AGENTUI_EXTENSION_CREW_TOKEN`: the Crew owner token.
- `AGENTUI_EXTENSION_COWORKERS_TOKEN`: the value of the service's `CRABBER_COWORKERS_API_TOKEN`.

An extension whose token variable is missing stays listed as `Not configured`; the other one still loads.

Coworkers create and delete need `api.manage_coworkers: true` in the Coworkers service's configuration.
