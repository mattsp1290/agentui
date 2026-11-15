# Host secret providers

`@agentui/sdk` exports `SecretProvider` for operator-trusted host adapters.
The contract reads a string from a backend-specific reference.
It does not create, update, list, delete, or persist secrets.

```ts
export interface SecretProvider {
	readonly resolve: (reference: string) => Promise<string>;
}
```

The reference identifies a stored value within the selected backend.
The adapter interprets its format.
It contains metadata, never the backend's password, bearer token, or other bootstrap credential.
The adapter captures its authenticated backend client during construction.
This keeps backend SDK types and bootstrap identity outside the public contract.

## Host integration

`secretResolver` from `@agentui/host` adapts a provider and reference to the existing installation credential resolver.
Its input is `{ provider: SecretProvider, reference: string }`.
Its result is `() => Promise<string>`.
The following excerpt assumes an operator-created `provider` and the installation's existing binding fields.

```ts
import { secretResolver } from '@agentui/host';
import type { SecretProvider } from '@agentui/sdk';

function authentication(provider: SecretProvider): {
	readonly kind: 'secret';
	readonly revision: string;
	readonly resolve: () => Promise<string>;
} {
	return {
		kind: 'secret',
		revision: 'selected-backend-1',
		resolve: secretResolver({ provider, reference: 'production/crew/api-key' }),
	};
}
```

`secretResolver` rejects blank references when constructed.
Each call resolves the selected reference again without caching its value.
It preserves valid secret strings exactly, including leading or trailing whitespace.
A nonstring or blank result rejects with `Secret resolution refused`.
A backend exception produces the same fixed error without its message or cause.

The existing host authority resolves credentials only after admitting a credential handle.
It checks the installation again after resolution and before the provider action.
Revocation during an awaited read prevents that action.
Closing the authority drains admitted reads and actions before releasing it.
The authority stores grant metadata in SQLite, never the resolved secret or backend reference.
Its external failure remains `Provider credential use refused`.
Read failures do not delete credentials or fall back to another backend.

The installation's `revision` names the operator's admitted credential selection.
It is independent of the backend's current value or version.
A backend can return a rotated value on the next read without rewriting that revision.
Changing the selected backend or reference requires the operator to change the installation revision.

## Adapter responsibilities

Kubernetes Secrets, Azure Key Vault, and HashiCorp Vault adapters can implement this read contract through their own clients.
This delivery includes the interface and host integration, not those adapters.
The adapter owns backend identity, reference validation, TLS verification, access policy, timeouts, and any backend cache.
References can select an immutable backend version when that backend supports one.
The generic interface imposes no version, compare-and-swap, lease, or retention guarantee.

A fresh target still needs an independent way to authenticate to its chosen backend.
Examples include workload identity, an OS-protected bootstrap credential, or interactive unlock.
A token stored inside the same vault it unlocks cannot supply that initial identity.
Provider names do not prove encrypted storage or encrypted backups.
Kubernetes stores Secrets unencrypted in etcd by default unless encryption at rest is configured.
See [Kubernetes Secret security](https://kubernetes.io/docs/concepts/configuration/secret/#information-security-for-secrets).

The adapter and its callers are full-trust host code.
They can retain or copy returned values.
The contract cannot enforce erasure, prevent a compromised running host from reading a secret, or make arbitrary backend logs safe.
Resolved values and backend errors stay outside client projections, URLs, diagnostics, repository configuration, and customization artifacts.
The bundled native credential path remains separate.

## Native provider login remains separate

This contract supplies API keys and existing tokens for host-side use.
It does not own a provider's OAuth login, refresh, logout, or mutable auth files.
Codex subscription credentials require a native provider storage integration that preserves refresh updates with one authoritative writer.
A secret reader alone does not make a copied `auth.json` safe or durable.
Secure input, Mac Keychain storage, encrypted Linux persistence, and native subscription setup remain following work.
