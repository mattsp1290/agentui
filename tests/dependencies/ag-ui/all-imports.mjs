for (const name of [
  '@ag-ui/core',
  '@ag-ui/proto',
  '@ag-ui/encoder',
  '@ag-ui/client',
  '@ag-ui/codex-sdk',
  '@ag-ui/pi',
]) {
  await import(name);
  console.log('PASS installed import ' + name);
}
