# Released local image records

These exact records were produced by the public client and BrowserViewStorage from released commit `8ce356c13e474ba0efad3b9534c6b79c26971cfa`, running in Chromium 159.0.8154.6 with real IndexedDB and Web Locks. `capture-summary.json` records the source commit, runtime, PNG validation, and SHA-256 hashes. The browser upgrade test checks those hashes before importing the records.

The three cases preserve an interrupted upload, a ready attachment, and a pending image command with a newer draft. The upload and submission ports were deterministic local test doubles. These fixtures qualify released client persistence, not host validation or transport.

The JSON encodes each actual Uint8Array value as a `type` and `bytes` wrapper. Restore that wrapper to Uint8Array before inserting it. All keys and other values are the original exported records. The PNG is the complete 70-byte repository sample. Every PNG chunk CRC passed and Chromium decoded it as 1 by 1 before selection.

Full immutable source and output manifests, build and capture logs, observations, and the producer remain in `.audit/frontend-send-capture/released-local-image-fixture/` in the integration audit. The archived invalid-PNG first attempt is not used by these fixtures.
