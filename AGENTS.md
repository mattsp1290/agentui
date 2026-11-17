# Agent instructions

## Deployment model

AgentUI, Crew and Switchboard run for one user on a private NetBird or Tailscale network. The overlay network is the trust boundary.

- Do not add device pairing, invite links, device credentials, device lists or device revocation. Clients reach the host directly over the overlay network.
- Do not add attestation, attestation renewal or validity deadlines for the host, Crew or their runtimes.
- Do not treat pairing or attestation as acceptance criteria. If a bean, plan or review asks for them, flag it to the owner instead of implementing it.

Pairing was removed once and came back. Keep it out.

Credentials that AgentUI uses to call other services, such as the Crew owner token, stay protected. This rule covers how clients reach AgentUI, not how AgentUI reaches its providers.
