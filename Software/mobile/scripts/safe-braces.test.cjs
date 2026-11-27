const assert = require('node:assert/strict');
const test = require('node:test');
const braces = require('braces');

test('compatible brace expansion, ranges, compilation and stringify', () => {
  assert.deepEqual(braces.expand('file-{a,b}-{1..3}'), ['file-a-1','file-a-2','file-a-3','file-b-1','file-b-2','file-b-3']);
  assert.equal(braces.stringify(braces.parse('a{b,c}d')), 'a{b,c}d');
  assert.equal(braces.compile(braces.parse('a{b,c}d')), 'a(b|c)d');
  assert.deepEqual(require('micromatch')(['a.js','b.ts','c.txt'], '*.{js,ts}'), ['a.js','b.ts']);
});

test('deep and unclosed attacker patterns fail with controlled RangeError', () => {
  for (const input of ['{'.repeat(3000) + 'a,b' + '}'.repeat(3000), '('.repeat(3000), '{'.repeat(3000)]) {
    for (const operation of [braces.parse, braces.compile, braces.expand, braces.stringify]) {
      const invoke = operation === braces.parse ? () => operation(input) : () => operation(braces.parse(input));
      assert.throws(invoke, error => error instanceof RangeError && /safe nesting depth/.test(error.message));
    }
  }
});

test('public AST operations reject deep and cyclic ASTs before walking', () => {
  const ast = { type: 'root', nodes: [] };
  let cursor = ast;
  for (let i = 0; i < 10000; i++) { const child = { type: 'brace', nodes: [] }; cursor.nodes.push(child); cursor = child; }
  const cyclic = { type: 'root', nodes: [] }; cyclic.nodes.push(cyclic);
  for (const input of [ast, cyclic]) {
    for (const operation of [braces.compile, braces.expand, braces.stringify]) {
      assert.throws(() => operation(input), /safe depth or node limit/);
    }
  }
});
