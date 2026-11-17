import { EXTENSION_SDK_VERSION } from '@agentui/sdk';

export function syntheticReceipt() {
  const hash = 'a'.repeat(64), request = { id: 'original', reference: { repository: '/source', commit: 'b'.repeat(40) }, expectedSelectionRevision: 0 };
  const builder = { identity: hash, esbuildVersion: 'test' }, pin = { directory: '/artifact/attempt', artifactId: hash };
  const command = { id: 'attempt', requestId: request.id, source: request.reference, directory: pin.directory,
    toolchain: { kind: 'ready', node: process.execPath, entrySha256: hash, lockSha256: hash, builder } };
  const operation = { id: 'refresh.attempt', revision: 1, receiptDigest: hash, artifacts: 1, attemptId: null, outcome: { kind: 'staged' } };
  return { job: { request, ordinal: 1, build: { kind: 'built', command, pin, provenance: { root: hash, sdkVersion: EXTENSION_SDK_VERSION, builder,
    runtime: { engine: 'node', version: process.versions.node, modules: process.versions.modules, abiIdentity: hash } } },
    promotion: { kind: 'selected', command: { id: operation.id, expectedRevision: 0, selection: { version: 1, artifacts: [pin] } }, operation } },
    latestRequestId: request.id, selectionStatus: { kind: 'ready', desiredRevision: 1, desired: operation, operation, lastApplied: null, runtime: { kind: 'withheld' } } };
}
