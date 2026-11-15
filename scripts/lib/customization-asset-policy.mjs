import { readFile, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import valueParser from 'postcss-value-parser';

export function within(root, file) {
  const path = relative(root, file);
  return path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

async function checkFile(file, roots) {
  const path = await realpath(file);
  if (!roots.some(root => within(root, path)) || !(await stat(path)).isFile()) throw new Error('Unsupported customization asset outside prepared files');
}

export async function checkCustomizationAsset(reference, importer, roots) {
  try {
    if (isAbsolute(reference) || /^[a-z][a-z\d+.-]*:/iu.test(reference) || /[\\\0]/u.test(reference)) throw new Error('Unsupported path');
    const path = resolve(dirname(importer), reference);
    const clean = path.replace(/[?#].*$/u, '');
    if (path.includes(`${sep}node_modules${sep}`) && path.includes('#') && path.indexOf('#') < (path.indexOf('?') < 0 ? path.length : path.indexOf('?'))) {
      try { await checkFile(path.split('?')[0], roots); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    await checkFile(clean, roots);
  } catch {
    throw new Error(`Unsupported customization asset: ${reference}`);
  }
}

export function customizationCssPolicy(roots) {
  const checkedDirectories = new Set();
  async function checkAssetOwners(file) {
    for (const path of new Set([file, await realpath(file)])) {
      let directory = dirname(path);
      while (roots.some(root => within(root, directory))) {
        if (!checkedDirectories.has(directory)) {
          try {
            const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
            if (manifest?.browser !== null && typeof manifest?.browser === 'object') throw new Error('Unsupported customization CSS browser mappings');
          } catch (error) { if (error.code !== 'ENOENT') throw error; }
          checkedDirectories.add(directory);
        }
        directory = dirname(directory);
      }
    }
  }
  return {
    postcssPlugin: 'agentui-committed-customization-css',
    async OnceExit(root, { result }) {
      if (!roots.some(directory => within(directory, root.source.input.file))) return;
      for (const message of result.messages) {
        if (message.type === 'dependency') await checkFile(message.file, roots);
      }
      const assets = [], sources = new Set();
      root.walkDecls(declaration => {
        const importer = declaration.source.input.file;
        sources.add(importer);
        valueParser(declaration.value).walk(node => {
          if (node.type !== 'function') return;
          if (node.value.toLowerCase().endsWith('image-set')) throw new Error('Unsupported customization CSS image-set');
          if (node.value.toLowerCase() !== 'url') return;
          const values = node.nodes.filter(value => value.type !== 'space' && value.type !== 'comment');
          if (node.unclosed || values.length !== 1 || !['word', 'string'].includes(values[0].type)) throw new Error('Unsupported customization CSS URL');
          const reference = values[0].value;
          if (/^(?:https?:\/\/|data:|\/\/|#)/iu.test(reference)) return false;
          if (!reference || /[\\\0]/u.test(reference)) throw new Error('Unsupported customization CSS URL');
          const decoded = decodeURI(reference).split('#')[0];
          if (decoded.startsWith('@vite/')) throw new Error('Unsupported customization CSS URL alias');
          assets.push({ reference: decoded, importer });
          return false;
        });
      });
      for (const source of sources) await checkFile(source.replace(/[?#].*$/u, ''), roots);
      for (const asset of assets) {
        await checkCustomizationAsset(asset.reference, asset.importer, roots);
        await checkAssetOwners(asset.importer.replace(/[?#].*$/u, ''));
        await checkAssetOwners(resolve(dirname(asset.importer), asset.reference).replace(/[?#].*$/u, ''));
      }
    },
  };
}
