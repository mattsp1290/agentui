import MagicString from 'magic-string';

const marker = /__VITE_CSS_URL__[\da-f]+__/u;
const markers = /(\\*)(__VITE_CSS_URL__[\da-f]+__)/gu;

// Vite replaces CSS markers inside double-quoted strings with concatenations.
// Group their entire expression before replacement to preserve operator precedence.
export function cssUrlExpressions() {
  return { name: 'agentui-css-url-expressions', enforce: 'pre', renderChunk: { order: 'pre', handler(code) {
    if (!marker.test(code)) return;
    const output = new MagicString(code);
    let changed = false;
    const walk = (node, parent) => {
      if (!node || typeof node !== 'object') return;
      if (node.type === 'Literal' && typeof node.value === 'string' && marker.test(node.value)) {
        const key = parent?.key === node && !parent.computed;
        output.overwrite(node.start, node.end, `${key ? '[' : '('}${JSON.stringify(node.value)}${key ? ']' : ')'}`);
        changed = true;
        return;
      }
      if (node.type === 'TemplateLiteral') {
        for (const quasi of node.quasis) {
          if (!marker.test(quasi.value.raw)) continue;
          if (parent?.type === 'TaggedTemplateExpression') this.error('Reserved CSS URL markers are unsupported in tagged template raw text.');
          const raw = quasi.value.raw.replace(markers, (_match, slashes, value) =>
            `${slashes.length % 2 ? slashes.slice(0, -1) : slashes}\${(${JSON.stringify(value)})}`);
          output.overwrite(quasi.start, quasi.end, raw);
          changed = true;
        }
        for (const expression of node.expressions) walk(expression, node);
        return;
      }
      for (const value of Object.values(node)) {
        if (Array.isArray(value)) for (const child of value) walk(child, node);
        else if (value && typeof value === 'object') walk(value, node);
      }
    };
    walk(this.parse(code), null);
    if (changed) return { code: output.toString(), map: output.generateMap({ hires: true }) };
  } } };
}
