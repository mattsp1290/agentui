# Persisted text reports

This in-process SDK 0.9 example registers a normal server extension. Each accepted send produces `response.txt` containing exactly its valid UTF-8 request text. Use Node 24 and build the workspace before importing it.

Set `AGENTUI_REPORT_DATABASE` to an absolute path in an existing private directory. The report provider owns this SQLite database exclusively until it closes. Keep it separate from the LocalHost database. The example needs no provider credentials.

```js
import { randomUUID } from 'node:crypto';
import { openReportExample } from '@agentui/example-generated-text-output';

process.env.AGENTUI_REPORT_DATABASE = '/private/reports.sqlite';
const example = await openReportExample({
  hostPath: '/private/host.sqlite',
  scope: { hostId: 'my-host', conversationId: 'reports' },
});
try {
  await example.send('A report.\n', randomUUID());
  const listing = await example.outputs();
  if (listing.kind === 'available') {
    for (const output of listing.outputs) {
      const result = await example.read(output.outputId);
      if (result.kind === 'available') console.log(new TextDecoder().decode(result.bytes));
    }
  }
} finally {
  await example.close();
}
```

The consumer loads the installed server entry with `loadServerExtension`, discovers its provider, creates the conversation through LocalHost, and uses the public output APIs. Reopen with the same database paths and logical scope to recover the original creation, receipts and output IDs. Reusing a command ID with changed text conflicts. Empty ordinary host sends remain rejected.

The provider retains the latest 32 payloads per conversation. Its immutable receipts outlive eviction. Exact submit replay and reconciliation return the original completed run without encoding, restoring bytes or changing retention. Reads never generate bytes. Valid provider outputs can contain zero through 65,536 UTF-8 bytes; LocalHost command size limits still apply to ordinary sends.

Creation refuses contexts whose complete 32-descriptor listing could exceed the host's 65,536-byte limit. Admission measures canonical UTF-8 bytes, including escaped scope characters, UUID references and maximum-payload metadata. Every accepted conversation can retain and list all 32 payloads. Startup enforces the same restriction without migrating existing storage.

One transaction admits capacity, encodes text, publishes bytes, evicts old payloads and persists the completed receipt. The provider confirms only after commit. Limits are 128 creations, 4,096 total receipts, 73,728 canonical request bytes per receipt, 16,384 canonical reply bytes per receipt and 64 MiB of combined request/reply bytes. Admission reserves a full 16,384-byte reply before encoding. Historical replay works at capacity. Capacity has no automatic cleanup or receipt deletion.

Startup rejects incompatible schemas or malformed persisted rows. This example has no migrations or recovery repair. Close the owner before inspecting its database. Keep database files private because requests and report bytes are stored as plaintext.

Run the focused checks after building with `node --test examples/generated-text-output/tests/*.test.mjs`. Capacity tests label directly seeded historical rows as fixtures. Fault tests inject failure after SQL eviction and after commit; they do not simulate a power failure. The packed test copies five exact first-party package archives and the third-party packages used by this runtime into an isolated consumer. It verifies that the final run resolves no files from the checkout. It does not claim an npm installation of the complete declared dependency closure.

A connected browser or Mac service client can list and read the same retained outputs. Both methods return the existing domain outcomes. Reads return newly owned `Uint8Array` bytes after exact length, fatal UTF-8 and SHA-256 verification. No browser cryptography API is required.

```js
import { createBrowserConnection } from '@agentui/client/service';

const connection = createBrowserConnection();
const listing = await connection.conversationOutputs(scope);
if (listing.kind === 'available') {
  for (const output of listing.outputs) {
    const result = await connection.readOutput(scope, output.outputId);
    if (result.kind === 'available') {
      console.log(new TextDecoder().decode(result.bytes));
    }
  }
}
```

Use the logical conversation scope returned by `connection.create`. Keep an output ID to read it again after reconnecting. `unsupported`, `unavailable` and `invalid` are domain values. Reads can also return `missing` after eviction. Transport or malformed-response failures reject the promise. A client timeout ends its wait and does not cancel the trusted provider's pending work.

Wire 11 is required on both client and host. Extension SDK 0.9 stays unchanged. The methods use the existing ordinary browser and Mac service routes. The focused HTTP test loads the installed report server entry and verifies create, send, reopen, replay and eviction. Its separately named SDK boundary fixture supplies zero and 65,536-byte payloads without weakening ordinary command limits.

Browser download, native Save, iOS integration and external backend outputs remain separate work. The native broker fixture exercises Rust HTTP execution with a private temporary Keychain; it does not qualify an installed Tauri window invocation.
