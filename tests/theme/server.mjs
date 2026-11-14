import { createServer } from 'node:http';
import { once } from 'node:events';
import { build } from 'esbuild';

export async function createPreview(port = 0) {
  const result = await build({
    entryPoints: [new URL('./fixture.jsx', import.meta.url).pathname],
    outfile: 'fixture.js', bundle: true, write: false,
    define: { 'process.env.NODE_ENV': '"development"' },
  });
  const assets = new Map(result.outputFiles.map((file) => [file.path.endsWith('.css') ? '/fixture.css' : '/fixture.js', file.contents]));
  const html = '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>AgentUI theme workbench</title><link rel="stylesheet" href="/fixture.css"></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>';
  const server = createServer((request, response) => {
    if (request.url === '/') {
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      response.end(html);
    } else if (assets.has(request.url)) {
      response.setHeader('Content-Type', request.url.endsWith('.css') ? 'text/css' : 'text/javascript');
      response.end(assets.get(request.url));
    } else {
      response.writeHead(404).end();
    }
  });
  server.listen(port, '127.0.0.1');
  await once(server, 'listening');
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}
