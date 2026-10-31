import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
// Same original fixture roots in source and compiled-test executions.
const repositoryUrl = new URL(import.meta.url.includes('/dist/test/') ? '../../' : '../', import.meta.url);
import { decomposeCodeSource, splitCorpusStreamIntoFiles, rankRepositoryAstBlocksBlind, verifyPartitionConservation } from '../src/code-decomposer.ts';
import { sha256 } from '../src/store.ts';

function check(text: string, originKey: string, maxBlockBytes = 4096) {
  const bytes = Buffer.from(text);
  const tree = decomposeCodeSource(bytes, { originKey, maxBlockBytes });
  assert.equal(tree.partitionVerified, true);
  assert.equal(verifyPartitionConservation(bytes, tree.root), true);
  const leaves = tree.flatNodes.filter(n => !n.children.length);
  assert.deepEqual(Buffer.concat(leaves.map(n => bytes.subarray(n.byteStart, n.byteEnd))), bytes);
  for (const n of tree.flatNodes) {
    const slice = bytes.subarray(n.byteStart, n.byteEnd);
    assert.equal(n.sha256, sha256(slice));
    assert.deepEqual(Buffer.from(slice.toString('utf8')), slice, 'No split inside a Unicode scalar');
    assert.equal(n.startLine, bytes.subarray(0, n.byteStart).toString().split('\n').length);
    assert.equal(n.endLine, bytes.subarray(0, Math.max(n.byteStart, n.byteEnd - 1)).toString().split('\n').length);
    for (const c of n.children) {
      assert.equal(c.parentId, n.nodeId);
      assert.equal(c.depth, n.depth + 1);
    }
  }
  for (const n of leaves) assert.ok(n.byteEnd - n.byteStart <= Math.max(maxBlockBytes, 4));
  return tree;
}

for (const [extension, definition, prefix, name] of [
  ['py', 'def library(value):\n    return value\n', '# preamble\nimport os\n\n', 'library'],
  ['ts', 'export function library(value: string) {\n  return value;\n}\n', '// preamble\nimport x from "x";\n\n', 'library'],
  ['py', 'class Library:\n    pass\n', '# preamble\n', 'Library'],
  ['ts', 'class Library {\n  value = 1;\n}\n', '// preamble\n', 'Library'],
] as const) {
  test(`${extension} whole ${name} is preserved identically at byte zero and after a preamble`, () => {
    for (const preamble of ['', prefix]) {
      const tree = check(preamble + definition, `source.${extension}`);
      const unit = tree.flatNodes.find(n => n.kind === 'block' && n.symbolName === name)!;
      assert.ok(unit);
      assert.equal(unit.byteStart, Buffer.byteLength(preamble));
      assert.equal(unit.byteEnd, Buffer.byteLength(preamble + definition));
      assert.equal(unit.children.length, 0);
      assert.ok(unit.headerByteEnd! > unit.headerByteStart!);
    }
  });
}

test('classes over the old 2200-byte threshold retain whole identity and enumerate small methods', () => {
  const source = 'class RenderEngine:\n    def __init__(self):\n        self.note = "' + 'x'.repeat(2400) + '"\n    def forward(self):\n        return self.note\n';
  const tree = check(source, 'model.py', 4096);
  const cls = tree.flatNodes.find(n => n.symbolName === 'RenderEngine')!;
  assert.equal(cls.byteEnd, Buffer.byteLength(source));
  assert.deepEqual(cls.subTokens, ['render', 'engine']);
  for (const name of ['__init__', 'forward']) {
    const method = tree.flatNodes.find(n => n.symbolName === name)!;
    assert.equal(method.parentId, cls.nodeId);
    assert.equal(method.children.length, 0);
  }
  assert.ok(!tree.flatNodes.some(n => n.kind === 'part'));
});

test('Python decorators, multiline signatures, dedented epilogues and fake docstring definitions', () => {
  const text = '# π\n@decorate\ndef load_audio(\n    value: str,\n) -> str:\n    """\ndef fake():\n    nope\n    """\n    return value\nresult = load_audio("x")\n';
  const tree = check(text, 'audio.py');
  const fn = tree.flatNodes.find(n => n.symbolName === 'load_audio')!;
  assert.equal(fn.byteStart, Buffer.byteLength('# π\n'));
  assert.equal(Buffer.from(text).subarray(fn.headerByteStart, fn.headerByteEnd).toString(), '@decorate\ndef load_audio(\n    value: str,\n) -> str:');
  assert.ok(!tree.flatNodes.some(n => n.symbolName === 'fake'));
  assert.equal(Buffer.from(text).subarray(fn.byteEnd).toString(), 'result = load_audio("x")\n');
});

test('same-line and nested brace methods retain exact parent/child byte ranges', () => {
  const text = 'class Library { get(){ return "😀"; } set(value){ return value; } }\nfunction last(){return 0;}';
  const tree = check(text, 'units.ts');
  const cls = tree.flatNodes.find(n => n.symbolName === 'Library')!;
  for (const name of ['get', 'set']) {
    const n = tree.flatNodes.find(n => n.symbolName === name)!;
    assert.equal(n.parentId, cls.nodeId);
    assert.equal(n.children.length, 0);
    assert.ok(Buffer.from(text).subarray(n.headerByteStart, n.headerByteEnd).toString().includes(`${name}(`));
  }
  assert.ok(tree.flatNodes.some(n => n.symbolName === 'last'));
});

test('giant single-line inputs and partial-line bodies always reach UTF-8-safe partitioning', () => {
  for (const budget of [1, 2, 3, 4, 17, 256]) {
    for (const [text, path] of [
      ['😀é中'.repeat(90), 'data.txt'],
      ['function large(){return "' + '😀é中'.repeat(90) + '";}', 'large.ts'],
      ['def large(): return "' + '😀é中'.repeat(90) + '"', 'large.py'],
    ]) {
      const tree = check(text, path, budget);
      assert.ok(tree.flatNodes.some(n => n.kind === 'part'));
      for (const parent of tree.flatNodes.filter(n => n.partIds)) {
        const parts = parent.children;
        assert.deepEqual(parent.partIds, parts.map(n => n.nodeId));
        parts.forEach((part, idx) => {
          assert.equal(part.partOfId, parent.nodeId);
          assert.equal(part.partIndex, idx + 1);
          assert.equal(part.totalParts, parts.length);
          assert.equal(part.previousPartId, parts[idx - 1]?.nodeId);
          assert.equal(part.nextPartId, parts[idx + 1]?.nodeId);
        });
      }
    }
  }
});

test('invalid partition budgets reject immediately, including empty input', () => {
  for (const maxBlockBytes of [0, -1, NaN, Infinity, 0.5]) {
    assert.throws(() => decomposeCodeSource('', { maxBlockBytes }), RangeError);
  }
  assert.equal(decomposeCodeSource('', { maxBlockBytes: 1 }).partitionVerified, true);
});

test('stream markers, outside bytes, CRLF, Unicode and trailing newlines are exactly conserved', () => {
  const text = 'intro 😀\r\n\n[start of src/a.py]\r\ndef first(): return 1\r\n[end of src/a.py]\r\nBETWEEN\n[start of README.md]\n# Readme\n```python\ndef sample(): pass\n```\n[end of README.md]\ntrailing\n';
  const segments = splitCorpusStreamIntoFiles(text, { includeLineNumbers: true });
  assert.equal(segments.map(s => s.text).join(''), text);
  let cursor = 0;
  for (const s of segments) {
    assert.equal(s.byteStart, cursor);
    assert.equal(s.text, Buffer.from(text).subarray(s.byteStart, s.byteEnd).toString());
    assert.equal(s.startLine, Buffer.from(text).subarray(0, s.byteStart).toString().split('\n').length);
    assert.equal(s.endLine, Buffer.from(text).subarray(0, s.byteEnd - 1).toString().split('\n').length);
    cursor = s.byteEnd;
  }
  assert.equal(cursor, Buffer.byteLength(text));
  assert.equal(segments.filter(s => s.segmentKind === 'marker').length, 4);
  const code = segments.find(s => s.segmentKind === 'file' && s.path === 'src/a.py')!;
  assert.equal(code.verifiedPath, 'src/a.py');
  assert.equal(code.pathProvenance, 'explicit-marker');
  const readme = segments.find(s => s.segmentKind === 'file' && s.path === 'README.md')!;
  assert.equal(readme.isOrientationDoc, true);
  assert.equal(decomposeCodeSource(readme.text, { originKey: readme.path }).grammarId, 'markdown');
});

test('inferred labels never claim verified paths, long files never split by line count', () => {
  const text = 'This function is defined in `src/claims.py`.\n' + 'value = 1\n'.repeat(2100);
  const segments = splitCorpusStreamIntoFiles(text);
  assert.equal(segments.length, 1);
  assert.equal(segments[0].text, text);
  assert.equal(segments[0].verifiedPath, undefined);
  assert.equal(segments[0].inferredLabel, 'unclassified source');
  assert.ok(!segments[0].path.includes('src/claims.py'));
  assert.equal(segments[0].segmentKind, 'inferred');
  const known = splitCorpusStreamIntoFiles(text, { defaultOriginKey: 'actual.py' });
  assert.equal(known[0].verifiedPath, 'actual.py');
  assert.equal(known[0].pathProvenance, 'caller');
});

test('README fenced definitions and fake file markers remain Markdown', () => {
  const text = '# README\n```python\n[start of fake.py]\ndef sample(): pass\n[end of fake.py]\n```\n' + 'documentation\n'.repeat(2100);
  const files = splitCorpusStreamIntoFiles(text, { defaultOriginKey: 'README.md' });
  assert.equal(files.length, 1);
  assert.equal(files[0].isOrientationDoc, true);
  assert.equal(files[0].text, text);
  const tree = check(text, 'README.md');
  assert.equal(tree.grammarId, 'markdown');
  assert.ok(!tree.flatNodes.some(n => n.symbolName === 'sample'));
});

test('unmatched stream markers, no final newline and empty input conserve bytes', () => {
  for (const text of ['', 'a', 'a\n', '[start of a.py]\nbody', '[end of absent.py]\n', '[start of a.py]\n[end of wrong.py]']) {
    assert.equal(splitCorpusStreamIntoFiles(text).map(s => s.text).join(''), text);
  }
});

test('deterministic identifiers, metadata and embedded SQL are retained', () => {
  const source = readFileSync(new URL('src/schema.ts', repositoryUrl), 'utf8');
  const a = check(source, 'schema.ts', 2048);
  const b = decomposeCodeSource(source, { originKey: 'schema.ts', maxBlockBytes: 2048 });
  assert.deepEqual(a, b);
  assert.ok(a.flatNodes.some(n => n.kind === 'embedded_string' && n.grammarId === 'sql'));
  assert.ok(a.flatNodes.some(n => n.symbolName === 'blobs'));
});

test('plain English definitions survive rank filtering and method names have no special multipliers', () => {
  const rank = (name: string) => rankRepositoryAstBlocksBlind([
    { path: 'sample.py', text: `def ${name}(value):\n    return value + 1\n` },
  ], 'Explain implementation').blocks[0].score;
  assert.equal(rank('__init__'), rank('forward'));
  assert.equal(rank('forward'), rank('__call__'));
  const files = [{ path: 'sample.py', text: 'def library(value):\n    return value + 1\n\ndef unrelated(value):\n    return value - 1\n' }];
  const result = rankRepositoryAstBlocksBlind(files, 'library');
  assert.ok(result.blocks.find(n => n.symbolPath.endsWith('::library'))!.score > result.blocks.find(n => n.symbolPath.endsWith('::unrelated'))!.score);
});


test('type-literal parameters and expression-bodied arrows are whole structural definitions', () => {
  const text = 'function single(value: {name: string}) { return value; }\nconst map = (value: string) => value;\n';
  const tree = check(text, 'typed.ts');
  const fn = tree.flatNodes.find(n => n.symbolName === 'single')!;
  assert.equal(Buffer.from(text).subarray(fn.byteStart, fn.byteEnd).toString(), text.split('\n')[0] + '\n');
  assert.equal(Buffer.from(text).subarray(fn.headerByteStart, fn.headerByteEnd).toString(), 'function single(value: {name: string}) {');
  assert.ok(tree.flatNodes.some(n => n.symbolName === 'map'));
});

test('every repository source conserves bytes and keeps structural headers within nodes', () => {
  const directory = new URL('src/', repositoryUrl);
  for (const name of readdirSync(directory).filter(name => name.endsWith('.ts'))) {
    const source = readFileSync(new URL(name, directory), 'utf8');
    const tree = check(source, `src/${name}`);
    for (const node of tree.flatNodes) {
      if (node.headerByteStart === undefined) continue;
      assert.ok(node.headerByteStart >= node.byteStart, `${name}: header before ${node.symbolPath}`);
      assert.ok(node.headerByteEnd! >= node.headerByteStart, `${name}: inverted header ${node.symbolPath}`);
      assert.ok(node.headerByteEnd! <= node.byteEnd, `${name}: header after ${node.symbolPath}`);
    }
  }
});

test('nested arrow declarations and same-line templates never create crossing structural spans', () => {
  for (const source of [
    'function outer() {\n  const issue=(code:string)=>issues.push({code});\n  if (ready) {\n    for (const entry of entries) {\n      consume(entry);\n    }\n  }\n}\n',
    'function first() {} const sql = `SELECT name FROM things`;\n',
    'const first = `SELECT name FROM things`; const second = `SELECT value FROM things`;\n',
  ]) {
    const tree = check(source, 'overlap.ts', 32);
    for (const node of tree.flatNodes) {
      if (node.headerByteEnd !== undefined) {
        assert.ok(node.headerByteEnd >= node.byteStart);
        assert.ok(node.headerByteEnd <= node.byteEnd);
      }
    }
  }
});

test('known code suffixes override Markdown headings and orientation-like paths', () => {
  for (const path of ['script.py', 'docs/example.py', 'README.py', 'example.ts', 'example.sql']) {
    const source = '# Python comment\ndef library():\n    pass\n';
    const direct = splitCorpusStreamIntoFiles(source, { defaultOriginKey: path });
    assert.equal(direct[0].isOrientationDoc, false, path);
    const marked = splitCorpusStreamIntoFiles(`[start of ${path}]\n${source}[end of ${path}]\n`);
    assert.equal(marked.find(file => file.segmentKind === 'file')!.isOrientationDoc, false, path);
  }
  assert.equal(splitCorpusStreamIntoFiles('# Heading\n', { defaultOriginKey: 'unknown' })[0].isOrientationDoc, true);
});

test('ranker selects a fitting class as a whole rather than isolated method/header fragments', () => {
  const text = 'class RenderEngine:\n    def __init__(self):\n        self.value = 1\n    def forward(self):\n        return self.value\n';
  const result = rankRepositoryAstBlocksBlind([{ path: 'model.py', text }], 'RenderEngine');
  assert.equal(result.blocks.length, 1);
  assert.ok(result.blocks[0].text.includes(text));
});
