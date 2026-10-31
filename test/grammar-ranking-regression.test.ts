import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decomposeCodeSource, isDefinitionNode, maskCode, rankRepositoryAstBlocksBlind, splitCorpusStreamIntoFiles } from '../src/code-decomposer.ts';
import { structuralUnits } from '../src/structure.ts';

function conserved(text: string, path: string) {
  const tree = decomposeCodeSource(text, { originKey: path });
  assert.equal(tree.partitionVerified, true);
  assert.equal(Buffer.concat(tree.flatNodes.filter(n => !n.children.length).map(n => Buffer.from(text).subarray(n.byteStart, n.byteEnd))).toString(), text);
  return tree;
}

test('nontriple strings and prose apostrophes cannot mask definitions on later lines', () => {
  for (const [path, definition] of [['sample.py', 'def library():\n    return "done"\n'], ['sample.ts', 'function library() { return "done"; }\n']]) {
    for (const prefix of ["It's malformed prose\n", '"unterminated\r\n']) {
      const text = prefix + definition + "'another broken quote\n";
      const masked = maskCode(text, path.endsWith('.py'));
      assert.equal(masked.length, text.length);
      assert.deepEqual([...masked.matchAll(/[\r\n]/g)].map(m => m.index), [...text.matchAll(/[\r\n]/g)].map(m => m.index));
      assert.ok(conserved(text, path).flatNodes.some(n => n.symbolName === 'library'), path + prefix);
    }
  }
  const docstring = '"""\ndef fake():\n    pass\n"""\ndef real():\n    pass\n';
  const tree = conserved(docstring, 'sample.py');
  assert.ok(!tree.flatNodes.some(n => n.symbolName === 'fake'));
  const prefixed = conserved("note = r'not_a_call()'\ndef real():\n    pass\n", 'sample.py');
  assert.ok(prefixed.flatNodes.some(n => n.symbolName === 'real'));
  assert.ok(tree.flatNodes.some(n => n.symbolName === 'real'));
});

test('only grammar definitions rescue stop words; prose and commented signatures do not', () => {
  const prose = 'The function get(value) is useful.\nclass set\n```python\ndef get(): pass\n```\n';
  const unknown = rankRepositoryAstBlocksBlind([{ path: 'attachment', text: 'function get() {}' }], 'get');
  assert.equal(unknown.blocks[0].score, rankRepositoryAstBlocksBlind([{ path: 'attachment', text: 'function get() {}' }], 'the').blocks[0].score);
  for (const text of [prose, '# def get():\n# class set:\n', '"""def get():\nclass set:\n"""\n']) {
    const path = text === prose ? 'README.md' : 'comments.py';
    const result = rankRepositoryAstBlocksBlind([{ path, text }], 'get set');
    const baseline = rankRepositoryAstBlocksBlind([{ path, text }], 'the');
    assert.deepEqual(result.blocks.map(b => b.score), baseline.blocks.map(b => b.score));
  }
  for (const path of ['sample.py', 'sample.ts']) {
    for (const name of ['get', 'set', 'library']) {
      const definition = path.endsWith('.py') ? `def ${name}():\n    return 1\n` : `function ${name}() { return 1; }\n`;
      const tree = conserved(definition, path);
      assert.ok(tree.flatNodes.some(n => n.symbolName === name && isDefinitionNode(n, definition)));
      const rank = (query: string) => rankRepositoryAstBlocksBlind([{ path, text: definition }], query).blocks[0].score;
      assert.ok(rank(name) > rank('the'), name);
    }
  }
  const malformed = 'class prose words\ndef actual():\n    pass\n';
  assert.ok(!conserved(malformed, 'sample.py').flatNodes.some(n => n.symbolName === 'prose'));
});

test('declaration headers, decorators, comments and strings are not lexical reference edges', () => {
  for (const [path, text, names] of [
    ['sample.py', '@decorate()\nclass Library(Base):\n    def get(self, arg=Default()):\n        # fake()\n        note = "quoted()"\n        return helper(arg)\n    def set(self):\n        return get()\n', ['Library', 'get', 'set']],
    ['sample.ts', 'class Library { get(arg = Default()) { /* fake() */ const note = "quoted()"; return helper(arg); } set() { return get(); } }\n', ['Library', 'get', 'set']],
  ] as const) {
    const units = structuralUnits(text, path);
    const cls = units.find(u => u.kind === 'block' && u.symbolName === 'Library')!;
    assert.ok(cls);
    assert.deepEqual(cls.references, ['get', 'helper']);
    const get = units.find(u => u.kind === 'block' && u.symbolName === 'get')!;
    assert.deepEqual(get.references, ['helper']);
    for (const header of units.filter(u => u.symbolName.endsWith('::header'))) assert.deepEqual(header.references, []);
    for (const name of names) assert.ok(units.some(u => u.symbolName === name));
  }
});

test('class header scores do not change when unrelated bodies cross the closure threshold', () => {
  const score = (padding: number) => {
    const text = `class Library:\n    def irrelevant(self):\n        note = "${'x'.repeat(padding)}"\n        return note\n`;
    const result = rankRepositoryAstBlocksBlind([{ path: 'sample.py', text }], 'Library', { maxBlockBytes: 180 });
    return Math.max(...result.blocks.map(b => b.score));
  };
  assert.equal(score(0), score(400));
  const text = 'class Library:\n    def get(self):\n        return 1\n    def set(self):\n        return 2\n';
  const result = rankRepositoryAstBlocksBlind([{ path: 'sample.py', text }], 'get');
  assert.equal(result.blocks.length, 1);
  assert.ok(result.blocks[0].text.endsWith(text), 'closure follows ranking and still renders the complete fitting class');
});

test('lexical-only neighbors cannot outrank a direct definition and never claim resolved calls', () => {
  const files = [
    { path: 'target.py', text: 'def RareTarget():\n    return helper_bridge()\n' },
    { path: 'helper.py', text: 'def helper_bridge():\n    return 0\n' },
    { path: 'decoy.py', text: 'def helper_bridge():\n    return 1\n' },
  ];
  const result = rankRepositoryAstBlocksBlind(files, 'RareTarget');
  const direct = result.blocks.find(b => b.originKey === 'target.py')!;
  for (const other of result.blocks.filter(b => b !== direct)) assert.ok(other.score < direct.score);
  assert.ok(result.blocks.every(b => !/CALLEE|CALL-GRAPH/.test(b.text)));
  const scores = rankRepositoryAstBlocksBlind(files, 'RareTarget').blocks.map(b => b.score);
  assert.deepEqual(result.blocks.map(b => b.score), scores);
});

test('unknown mixed streams infer exact section/code ranges without fabricating file paths', () => {
  const text = 'preamble 🙂\r\n# Overview\r\nThe implementation is defined in `src/not-real.py`.\r\n```python\r\ndef sample(): pass\r\n```\r\n\r\nimport os\r\ndef library():\r\n    return 7\r\n# Further notes\r\nSome prose.\r\n';
  for (const options of [{}, { defaultOriginKey: 'attachment-123' }]) {
    const files = splitCorpusStreamIntoFiles(text, options);
    assert.ok(files.length >= 3);
    assert.equal(files.map(f => f.text).join(''), text);
    for (const file of files) {
      assert.equal(file.segmentKind, 'inferred');
      assert.equal(file.pathProvenance, 'inferred');
      assert.equal(file.verifiedPath, undefined);
      assert.ok(file.inferredLabel);
      assert.ok(!/\.py$|\.md$|src\//.test(file.path));
      assert.equal(file.text, Buffer.from(text).subarray(file.byteStart, file.byteEnd).toString());
      assert.equal(file.startLine, Buffer.from(text).subarray(0, file.byteStart).toString().split('\n').length);
      assert.equal(file.endLine, Buffer.from(text).subarray(0, file.byteEnd - 1).toString().split('\n').length);
    }
    const code = files.find(f => f.grammarId === 'python')!;
    assert.ok(code.text.includes('def library():'));
    assert.ok(!code.text.includes('def sample():'));
  }
  const units = structuralUnits(text, 'attachment-123');
  assert.ok(units.some(u => u.kind === 'block' && u.symbolName === 'library' && u.segmentKind === 'inferred' && u.inferredLabel && !u.pathVerified));
  assert.ok(!units.some(u => u.kind === 'block' && u.symbolName === 'sample'));
  assert.equal(splitCorpusStreamIntoFiles(text, { defaultOriginKey: 'README.md' }).length, 1);
  assert.equal(splitCorpusStreamIntoFiles(text, { defaultOriginKey: 'actual.py' }).length, 1);
});

test('inferred grammar survives into section-level ranking rather than silently becoming Markdown', () => {
  const text = '# Overview\nDocumentation.\n\ndef get():\n    return helper()\n';
  const files = splitCorpusStreamIntoFiles(text);
  const hits = rankRepositoryAstBlocksBlind(files, 'get').blocks;
  assert.ok(hits.some(b=>b.symbolPath.endsWith('::get')), JSON.stringify(hits));
});

test('escaped triple delimiters and valid single-string continuations do not expose fake definitions', () => {
  const text = 'value = """escaped \\"""\ndef fake():\n    pass\n"""\ndef real():\n    pass\n';
  const tree = conserved(text, 'sample.py');
  assert.ok(!tree.flatNodes.some(n=>n.symbolName==='fake'));
  assert.ok(tree.flatNodes.some(n=>n.symbolName==='real'));
  const continuation = "value = 'first\\\ndef hidden():\\\nend'\ndef actual():\n    pass\n";
  const next = conserved(continuation, 'sample.py');
  assert.ok(!next.flatNodes.some(n=>n.symbolName==='hidden'));
  assert.ok(next.flatNodes.some(n=>n.symbolName==='actual'));
});

test('query-named enclosing identity favors its matching method over same-named methods elsewhere', () => {
  const text = 'class TargetOperation:\n    def database_backwards(self):\n        return 1\n    def extra(self):\n        return "'+ 'x'.repeat(800) +'"\n\nclass OtherOperation:\n    def database_backwards(self):\n        return 2\n';
  const ranked=rankRepositoryAstBlocksBlind([{path:'operations.py',text}], 'TargetOperation database_backwards', {maxBlockBytes:180});
  const target=ranked.blocks.find(b=>b.symbolPath.includes('TargetOperation::database_backwards'))!;
  assert.ok(target);
  for(const other of ranked.blocks.filter(b=>b.symbolPath.includes('OtherOperation')))assert.ok(target.score>other.score);
});

test('repeated inferred labels retain separate source identities and exact quote hashes', () => {
 const text='# A\ndef repeated():\n    return 111\n# B\ndef repeated():\n    return "a much longer second definition"\n';
 const files=splitCorpusStreamIntoFiles(text);
 const hits=rankRepositoryAstBlocksBlind(files,'repeated').blocks.filter(b=>b.symbolPath.endsWith('::repeated'));
 assert.equal(hits.length,2);assert.equal(new Set(hits.map(b=>b.sourceIndex)).size,2);
 for(const b of hits){const bytes=Buffer.from(files[b.sourceIndex!].text).subarray(b.byteStart,b.byteEnd);assert.ok(b.text.endsWith(bytes.toString()));assert.equal(b.sha256,conserved(bytes.toString(),'sample.py').rootSha256);}
});
test('supported inferred TypeScript declarations pass structural eligibility',()=>{
 for(const text of ['const get = () => 1;\n','abstract class Library {}\n','namespace Library {}\n'])assert.ok(structuralUnits(text,'attachment').length,text);
});
