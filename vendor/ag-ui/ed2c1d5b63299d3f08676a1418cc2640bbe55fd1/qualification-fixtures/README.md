# Controlled upstream fixtures

These files are byte-for-byte copies from `mattsp1290/ag-ui` source `ed2c1d5b63299d3f08676a1418cc2640bbe55fd1`. `provenance.json` records each original path, SHA-256, byte count, raw line count and task unit. They exercise public package exports; no private production module is imported.

The Pi adapter fixture has 348 lines and belongs to `agentui-iqml`. The Pi HTTP fixture has 435 lines and belongs to `agentui-ed5a`. Their donor attribution is preserved by [Pi provenance](../notices/ag-ui-pi.PROVENANCE.md) and [MIT notice](../notices/ag-ui-pi.LICENSE). They derive from the source integration's `test/adapter.test.ts` and `test/example.test.ts`. Together they execute 15 controlled-provider tests.

The 90-line Codex executable belongs to acquisition unit `agentui-wtdo`. It comes from `integrations/community/codex-sdk/typescript/examples/testing/codex-exec.mjs`; see its [MIT notice](../notices/ag-ui-codex-sdk.LICENSE). It requires explicit test mode and a temporary fixture directory. It emits controlled local process events and never invokes the native CLI.

All 873 executable fixture lines count toward the full change's raw implementation/test total. The Pi units were split before retention because their 783 unchanged lines alone exceed the single-unit 750-line limit. The fixture files remain unchanged so source attribution and behavior can be checked directly.
