import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decomposeCodeSource, isDefinitionNode, lexicalCodeReferences, splitCorpusStreamIntoFiles, verifyPartitionConservation } from '../src/code-decomposer.ts';
import { structuralUnits } from '../src/structure.ts';
import { sha256 } from '../src/store.ts';

function check(text: string, originKey: string, maxBlockBytes = 4096) {
  const bytes = Buffer.from(text);
  const before = Buffer.from(bytes);
  const tree = decomposeCodeSource(bytes, { originKey, maxBlockBytes });
  assert.deepEqual(bytes, before, 'caller/L0 bytes must never be mutated');
  assert.equal(tree.rootSha256, sha256(before));
  assert.equal(verifyPartitionConservation(bytes, tree.root), true);
  assert.deepEqual(Buffer.concat(tree.flatNodes.filter(n => !n.children.length).map(n => bytes.subarray(n.byteStart, n.byteEnd))), bytes);
  for (const n of tree.flatNodes) {
    const slice = bytes.subarray(n.byteStart, n.byteEnd);
    assert.equal(n.sha256, sha256(slice));
    assert.deepEqual(Buffer.from(slice.toString()), slice);
    assert.equal(n.startLine, bytes.subarray(0, n.byteStart).toString().split('\n').length);
    assert.equal(n.endLine, bytes.subarray(0, Math.max(n.byteStart, n.byteEnd - 1)).toString().split('\n').length);
  }
  return tree;
}

const numberedPython = [
  '8 import os',
  '9 @decorate()',
  '10 class Library:',
  '11     @logged()',
  '12     def load(self, value=Default()):',
  '13         """é🙂',
  '14 def quoted():',
  '15     pass',
  '16         """',
  '17         # def commented():',
  '18         def nested():',
  '19             return helper()',
  '20         return nested()',
  '21 result = Library()',
].join('\r\n') + '\r\n';

test('numbered marker stream routes exact original file, decorated and nested definition spans', () => {
  const raw = 'outside 🙂\r\n[start of src/library.py]\r\n' + numberedPython + '[end of src/library.py]\r\nafter\r\n';
  const bytes = Buffer.from(raw);
  const files = splitCorpusStreamIntoFiles(raw, { includeLineNumbers: true });
  assert.equal(files.map(f => f.text).join(''), raw);
  for (const f of files) assert.equal(f.text, bytes.subarray(f.byteStart, f.byteEnd).toString());
  const file = files.find(f => f.segmentKind === 'file')!;
  assert.equal(file.path, 'src/library.py');
  assert.equal(file.verifiedPath, file.path);
  assert.equal(file.pathProvenance, 'explicit-marker');
  assert.equal(file.text, numberedPython);
  const tree = check(file.text, file.path, 70);
  const definitions = tree.flatNodes.filter(n => isDefinitionNode(n, file.text));
  assert.deepEqual(definitions.map(n => n.symbolName), ['Library', 'load', 'nested']);
  const cls = definitions[0], method = definitions[1], nested = definitions[2];
  assert.equal(method.parentId, cls.nodeId);
  assert.equal(nested.parentId, method.nodeId);
  const header = (n: typeof cls) => Buffer.from(file.text).subarray(n.headerByteStart, n.headerByteEnd).toString();
  assert.equal(header(cls), '9 @decorate()\r\n10 class Library:');
  assert.equal(header(method), '11     @logged()\r\n12     def load(self, value=Default()):');
  const units = structuralUnits(raw, 'repository.dump', 70);
  for (const name of ['Library', 'load', 'nested']) {
    const unit = units.find(u => u.kind === 'block' && u.symbolName === name)!;
    const node = definitions.find(n => n.symbolName === name)!;
    assert.ok(unit, name);
    assert.equal(unit.byteStart, file.byteStart + node.byteStart);
    assert.equal(unit.byteEnd, file.byteStart + node.byteEnd);
    assert.equal(unit.startLine, node.startLine! + 2);
    assert.equal(unit.endLine, node.endLine! + 2);
    assert.equal(unit.pathProvenance, 'explicit-marker');
    assert.equal(unit.pathVerified, true);
    assert.equal(sha256(bytes.subarray(unit.byteStart, unit.byteEnd)), node.sha256);
  }
  assert.deepEqual(units.find(u => u.kind === 'block' && u.symbolName === 'load')!.references, ['helper', 'nested']);
  assert.ok(!units.some(u => u.kind === 'block' && /quoted|commented/.test(u.symbolName)));
});

test('digit-width transitions do not change Python indentation or multiline signature coordinates', () => {
  const text = '98 @logged()\n99 def outer(\n100     value: str = "🙂",\n101 ):\n102     def inner():\n103         return value\n104     return inner()\n105 after = outer()\n';
  const tree = check(text, 'module.py');
  const outer = tree.flatNodes.find(n => n.symbolName === 'outer')!;
  const inner = tree.flatNodes.find(n => n.symbolName === 'inner')!;
  assert.ok(outer && inner);
  assert.equal(inner.parentId, outer.nodeId);
  assert.equal(Buffer.from(text).subarray(outer.headerByteStart, outer.headerByteEnd).toString(), text.slice(0, text.indexOf('101 ):') + '101 ):'.length));
  assert.equal(Buffer.from(text).subarray(outer.byteEnd).toString(), '105 after = outer()\n');
});

test('numbered brace-language methods and siblings retain names and exact slices', () => {
  const text = '8 import foo from "foo";\n9 class Example {\n10   load() { return helper("é🙂"); }\n11 }\n12 function other() { return 1; }\n';
  const tree = check(text, 'module.ts', 30);
  const defs = tree.flatNodes.filter(n => isDefinitionNode(n, text));
  assert.deepEqual(defs.map(n => n.symbolName), ['Example', 'load', 'other']);
  assert.equal(defs[1].parentId, defs[0].nodeId);
  assert.equal(Buffer.from(text).subarray(defs[1].byteStart, defs[1].byteEnd).toString(), '10   load() { return helper("é🙂"); }\n');
});

test('numbered prose, malformed sequences, unknown paths and documentation never enable numeric projection', () => {
  for (const text of [
    '1 This is a list.\n2 def proposed():\n3     pass\n',
    '1 def gap():\n3     pass\n',
    '2 def backwards():\n1     pass\n',
    '1 def duplicate():\n1     pass\n',
    '1 def mixed():\n    pass\n',
    '001 def padded():\n002     pass\n',
    '1. def dotted():\n2.     pass\n',
  ]) {
    assert.equal(structuralUnits(text, 'attachment').length, 0);
    const tree = check(text, 'README.md');
    assert.ok(!tree.flatNodes.some(n => isDefinitionNode(n, text)));
    if (!text.includes('This is a list')) assert.ok(!check(text, 'module.py').flatNodes.some(n => n.numberedLines));
  }
  const raw = '[start of README.md]\n1 # Overview\n2 ```python\n3 def example():\n4     pass\n5 ```\n[end of README.md]\n';
  assert.ok(!structuralUnits(raw, 'attachment').some(u => u.kind === 'block'));
  const unnumbered = check('def plain():\n    return 42\n', 'module.py');
  assert.ok(unnumbered.flatNodes.some(n => n.symbolName === 'plain'));
  assert.ok(!unnumbered.flatNodes.some(n => n.numberedLines));
});

test('lexical reference byte ranges use original UTF-8 rather than masked character widths', () => {
  for (const numbered of [false, true]) {
    const lines = ['# é🙂 comment', 'def host(arg=Default()):', '    note = "é🙂 ignored()"', '    return helper() + tail()', 'from package import value'];
    const text = lines.map((line, i) => (numbered ? `${i + 1} ` : '') + line).join('\r\n') + '\r\n';
    const tree = check(text, 'references.py');
    const headers = tree.flatNodes.filter(n => isDefinitionNode(n, text)).map(n => ({ byteStart: n.headerByteStart!, byteEnd: n.headerByteEnd! }));
    const refs = lexicalCodeReferences(text, 'python', [...headers, ...headers]);
    assert.ok(!refs.some(r => ['host', 'Default', 'ignored'].includes(r.name)));
    for (const name of ['helper', 'tail']) {
      const ref = refs.find(r => r.name === name)!;
      const index = text.indexOf(name + '(');
      assert.equal(ref.byteStart, Buffer.byteLength(text.slice(0, index)));
      assert.equal(ref.byteEnd, ref.byteStart + name.length + 1);
      assert.equal(Buffer.from(text).subarray(ref.byteStart, ref.byteEnd).toString(), name + '(');
    }
  }
  // Whitespace in the masked view may include original non-ASCII strings.
  const text = 'candidate "é🙂" (argument)\n';
  const ref = lexicalCodeReferences(text, 'python')[0];
  assert.equal(Buffer.from(text).subarray(ref.byteStart, ref.byteEnd).toString(), 'candidate "é🙂" (');
});

test('dense lexical references have linear original-byte coordinate work', () => {
  const text = 'value = "é🙂"; helper(); tail();\n'.repeat(12000);
  const original = Buffer.byteLength;
  let convertedCharacters = 0;
  Buffer.byteLength = ((value: string | Buffer, encoding?: BufferEncoding) => {
    if (typeof value === 'string') convertedCharacters += value.length;
    return original(value, encoding);
  }) as typeof Buffer.byteLength;
  try {
    const refs = lexicalCodeReferences(text, 'python');
    assert.equal(refs.length, 24000);
    assert.equal(refs.at(-1)!.byteStart, Buffer.from(text).lastIndexOf('tail'));
    assert.ok(convertedCharacters <= text.length * 2, `quadratic prefix conversions: ${convertedCharacters}`);
  } finally { Buffer.byteLength = original; }
});


test('numbered multiline decorators and quoted brace signatures remain grammar-only', () => {
  const text = '1 @decorate(\n2     mode="é🙂",\n3 )\n4 @logged()\n5 def load():\n6     return helper()\n';
  const tree = check(text, 'module.py');
  const fn = tree.flatNodes.find(n => n.symbolName === 'load')!;
  assert.ok(isDefinitionNode(fn, text));
  assert.equal(fn.byteStart, 0);
  assert.equal(Buffer.from(text).subarray(fn.headerByteStart, fn.headerByteEnd).toString(), text.slice(0, text.indexOf('5 def load():') + '5 def load():'.length));
  const refs = lexicalCodeReferences(text, 'python', [{ byteStart: fn.headerByteStart!, byteEnd: fn.headerByteEnd! }]);
  assert.deepEqual(refs.map(r => r.name), ['helper']);
  const braces = '1 const note = "function quoted() {";\n2 // function commented() {}\n3 function actual() { return 1; }\n';
  assert.deepEqual(check(braces, 'module.ts').flatNodes.filter(n => isDefinitionNode(n, braces)).map(n => n.symbolName), ['actual']);
  assert.ok(!decomposeCodeSource('1 function proposed() {}\n2 proposed();\n').flatNodes.some(n => n.numberedLines), 'implicit fallback grammar is not numbering evidence');
});
