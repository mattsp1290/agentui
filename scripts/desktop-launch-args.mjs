function validateDesktopArgs(args) {
  if (args.length === 0) return;
  if (args.length !== 2 || args[0] !== '--host-url') {
    throw new Error('Use --host-url http://127.0.0.1:PORT/browser.html');
  }
  let url;
  try { url = new URL(args[1]); }
  catch { throw new Error('Use --host-url http://127.0.0.1:PORT/browser.html'); }
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password ||
    url.pathname !== '/browser.html' || url.search || url.hash || args[1].includes('?') || args[1].includes('#')) {
    throw new Error('The desktop host must use http://127.0.0.1:PORT/browser.html');
  }
}

try { validateDesktopArgs(process.argv.slice(2)); }
catch (error) {
  process.stderr.write(`Cannot connect to AgentUI host: ${error.message}\n`);
  process.exitCode = 1;
}
