import { isAbsolute } from 'node:path';
import { parseSync } from 'vite';

const literal = node => node?.type === 'Literal' && typeof node.value === 'string';
const calls = (node, names) => ['CallExpression', 'NewExpression'].includes(node.type) &&
  node.callee.type === 'Identifier' && names.includes(node.callee.name);
const expression = node => ['ParenthesizedExpression', 'TSAsExpression', 'TSSatisfiesExpression', 'TSNonNullExpression', 'TSTypeAssertion'].includes(node?.type) ? expression(node.expression) : node;
const named = (node, names) => expression(node)?.type === 'Identifier' && names.includes(expression(node).name);
const metaUrl = node => {
  const value = expression(node);
  return value?.type === 'MemberExpression' && !value.computed && value.property.name === 'url' &&
    value.object.type === 'MetaProperty' && value.object.meta.name === 'import';
};
const assetUrl = node => node?.type === 'NewExpression' && named(node.callee, ['URL']) && metaUrl(node.arguments[1]);
const staticUrl = node => {
  const value = expression(node);
  return literal(value) ? value.value : value?.type === 'TemplateLiteral' && value.expressions.length === 0 ? value.quasis[0].value.cooked : undefined;
};
export const isWorkerRequest = specifier => /(?:\?|&)(?:worker|sharedworker)(?:&|$)/u.test(specifier);
function specifier(node) {
  if (['ImportDeclaration', 'ExportNamedDeclaration', 'ExportAllDeclaration', 'ImportExpression'].includes(node.type)) return node.source;
  if (calls(node, ['require'])) return node.arguments[0];
}
const rules = {
  unsupportedWorker: node => {
    const source = specifier(node);
    return (literal(source) && isWorkerRequest(source.value)) ||
      (node.type === 'NewExpression' && named(node.callee, ['Worker', 'SharedWorker']) && assetUrl(expression(node.arguments[0])));
  },
  computedAssetUrl: node => assetUrl(node) && (node.arguments.length !== 2 || staticUrl(node.arguments[0]) === undefined),
  unsupportedAssetUrl: node => {
    if (!assetUrl(node)) return false;
    const source = expression(node.arguments[0]), value = staticUrl(source);
    return value !== undefined && (!/^\.\.?\//u.test(value) || /[\\\0]/u.test(value) ||
      (source.raw ?? source.quasis[0].value.raw).includes('\\'));
  },
  computedImport: node => node.type === 'ImportExpression' && !literal(node.source),
  computedRequire: node => node.type === 'CallExpression' && calls(node, ['require']) &&
    (node.arguments.length !== 1 || !literal(node.arguments[0])),
  requireMember: node => node.type === 'MemberExpression' && node.object.type === 'Identifier' && node.object.name === 'require',
  importOptions: node => node.type === 'ImportExpression' && node.options,
  requireCallForm: node => calls(node, ['require']) && (node.type !== 'CallExpression' || node.optional),
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
    'requireCallForm', 'importMetaOtherThanUrl', 'ambientModule', 'ambientReference', 'unsupportedWorker', 'computedAssetUrl', 'unsupportedAssetUrl'],
};
export function checkCustomizationSource(code, id, selected, failure) {
  const parsed = parseSync(id, code, { sourceType: 'module' });
  if (parsed.errors.length) throw failure('syntax');
  const assetUrls = [];
  function visit(node, parent) {
    if (!node || typeof node !== 'object') return;
    for (const name of selected) if (rules[name](node, parent)) throw failure(name);
    if (assetUrl(node) && staticUrl(node.arguments[0]) !== undefined) assetUrls.push(staticUrl(node.arguments[0]));
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(child => visit(child, node));
      else if (value && typeof value === 'object') visit(value, node);
    }
  }
  parsed.comments.forEach(comment => visit(comment));
  visit(parsed.program);
  return { assetUrls };
}
