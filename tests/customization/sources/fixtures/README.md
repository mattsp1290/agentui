# Local tarball fixtures

`a.tgz` contains an authored `package/package.json` with name `a`, version `1.0.0`, and dependency `b` set to `file:./b.tgz`. `b.tgz` contains an authored manifest with name `b` and version `1.0.0`. Neither archive contains scripts or executable files.

The archives use USTAR headers, mode `0644`, zero timestamps, and gzip with no filename and a zero timestamp. Their only payloads are compact JSON manifests followed by a newline.

`npm-sibling-tarball-lock.json` is the unmodified output of npm 11.19.1's bundled Arborist 9.9.1 `buildIdealTree().meta.toJSON()`. The temporary root manifest has name `tarballs`, version `1.0.0`, package manager `npm@11.19.1`, and dependency `a` set to `file:vendor/a.tgz`.

Generation used Node 24.22.3 with offline mode, a private empty cache, and scripts disabled. It created no `node_modules`. Both edges had no error, and npm's bundled `from-path.js` returned the `vendor` directory for both installed tarball nodes. Each archive has its own SHA-512 lock integrity. Tests read the committed bytes and require no npm internals at runtime.
