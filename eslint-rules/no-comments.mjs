const DIRECTIVE = /^\s*(eslint-disable|eslint-enable|eslint\s|global\s|globals\s|exported\s|@ts-(expect-error|ignore|nocheck|check)\b)/;
const TRIPLE_SLASH = /^\/\s*<reference\s/;

function isDirective(comment) {
  if (comment.type === 'Line' && TRIPLE_SLASH.test(comment.value)) return true;
  return DIRECTIVE.test(comment.value);
}

function removalRange(text, start, end) {
  const lineStart = text.lastIndexOf('\n', start - 1) + 1;
  let lineEnd = text.indexOf('\n', end);
  if (lineEnd === -1) lineEnd = text.length;
  const before = text.slice(lineStart, start);
  const after = text.slice(end, lineEnd);
  if (!before.trim() && !after.trim()) return [lineStart, Math.min(text.length, lineEnd + 1)];
  if (!after.trim()) {
    let s = start;
    while (s > lineStart && /[ \t]/.test(text[s - 1])) s--;
    return [s, end];
  }
  let e = end;
  while (e < lineEnd && /[ \t]/.test(text[e])) e++;
  return [start, e];
}

const rule = {
  meta: {
    type: 'suggestion',
    fixable: 'code',
    docs: { description: 'Proíbe comentários no código.' },
    messages: { comment: 'Comentários não são permitidos no código.' },
    schema: [],
  },
  create(context) {
    const source = context.sourceCode;
    const text = source.getText();
    const handled = new Set();
    return {
      JSXExpressionContainer(node) {
        if (node.expression.type !== 'JSXEmptyExpression') return;
        const inside = source.getCommentsInside(node);
        if (!inside.length) return;
        for (const c of inside) handled.add(c);
        context.report({ node, messageId: 'comment', fix: (fixer) => fixer.removeRange(removalRange(text, node.range[0], node.range[1])) });
      },
      'Program:exit'() {
        for (const c of source.getAllComments()) {
          if (handled.has(c) || isDirective(c)) continue;
          context.report({ loc: c.loc, messageId: 'comment', fix: (fixer) => fixer.removeRange(removalRange(text, c.range[0], c.range[1])) });
        }
      },
    };
  },
};

export default { meta: { name: 'local' }, rules: { 'no-comments': rule } };
