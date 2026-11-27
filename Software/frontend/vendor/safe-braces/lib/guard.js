'use strict';
const MAX_DEPTH = 128;
exports.MAX_DEPTH = MAX_DEPTH;
exports.assertAst = ast => {
  const active = new Set();
  const stack = [{ node: ast, depth: 0, leave: false }];
  let count = 0;
  while (stack.length) {
    const entry = stack.pop();
    const { node, depth } = entry;
    if (!node || typeof node !== 'object') continue;
    if (entry.leave) { active.delete(node); continue; }
    if (depth > MAX_DEPTH || active.has(node) || ++count > 100000) {
      throw new RangeError('Brace AST exceeds safe depth or node limit');
    }
    active.add(node);
    stack.push({ node, depth, leave: true });
    if (Array.isArray(node.nodes)) {
      if (node.nodes.length > 100000) throw new RangeError('Brace AST exceeds safe node limit');
      for (let i = node.nodes.length - 1; i >= 0; i--) {
        stack.push({ node: node.nodes[i], depth: depth + 1, leave: false });
      }
    }
  }
};
