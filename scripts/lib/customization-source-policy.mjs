import { isAbsolute } from 'node:path';
import { parseSync } from 'vite';

const literal = node => node?.type === 'Literal' && typeof node.value === 'string';
const calls = (node, names) => ['CallExpression', 'NewExpression'].includes(node.type) &&
  node.callee.type === 'Identifier' && names.includes(node.callee.name);
function specifier(node) {
  if (['ImportDeclaration', 'ExportNamedDeclaration', 'ExportAllDeclaration', 'ImportExpression'].includes(node.type)) return node.source;
  if (calls(node, ['require'])) return node.arguments[0];
}
const rules = {
  computedImport: node => node.type === 'ImportExpression' && !literal(node.source),
  computedRequire: node => node.type === 'CallExpression' && calls(node, ['require']) &&
    (node.arguments.length !== 1 || !literal(node.arguments[0])),
  requireMember: node => node.type === 'MemberExpression' && node.object.type === 'Identifier' && node.object.name === 'require',
  importOptions: node => node.type === 'ImportExpression' && node.options,
  requireCallForm: node => calls(node, ['require']) && (node.type !== 'CallExpression' || node.optional),
  evaluator: node => calls(node, ['eval', 'Function']),
  importMetaOtherThanUrl: (node, parent) => node.type === 'MetaProperty' && node.meta.name === 'import' &&
    !(parent?.type === 'MemberExpression' && parent.object === node && !parent.computed && parent.property.name === 'url'),
  ambientModule: node => node.type === 'TSImportEqualsDeclaration' ||
    (node.type === 'TSModuleDeclaration' && (node.kind === 'global' || node.id.type === 'Literal')),
  absoluteSpecifier: node => {
    const source = specifier(node);
    return literal(source) && (isAbsolute(source.value) || source.value.includes('\0'));
  },
  ambientReference: node => ['Line', 'Block'].includes(node.type) && /<reference\b|@jsx(?:ImportSource|Runtime)?\b/u.test(node.value),
};
export const sourcePolicies = {
  server: ['computedImport', 'computedRequire', 'requireMember'],
  desktop: ['absoluteSpecifier', 'computedImport', 'computedRequire', 'requireMember', 'importOptions',
    'requireCallForm', 'evaluator', 'importMetaOtherThanUrl', 'ambientModule', 'ambientReference'],
};
export function checkCustomizationSource(code, id, selected, failure) {
  const parsed = parseSync(id, code, { sourceType: 'module' });
  if (parsed.errors.length) throw failure('syntax');
  function visit(node, parent) {
    if (!node || typeof node !== 'object') return;
    for (const name of selected) if (rules[name](node, parent)) throw failure(name);
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(child => visit(child, node));
      else if (value && typeof value === 'object') visit(value, node);
    }
  }
  parsed.comments.forEach(comment => visit(comment));
  visit(parsed.program);
}
