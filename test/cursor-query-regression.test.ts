import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { analyzeRecallQuery, buildFtsQuery, scoreFacetCoverage } from '../src/retrieval.ts';

const oldBody=Array.from({length:18},(_,i)=>`    legacy_slot_${i} = archive_reader(value)`).join('\n');
const currentBody=Array.from({length:12},(_,i)=>`        local_${i} = payload`).join('\n');
const pythonPrefix=`# License, copyright and OldLicenseWitness are not active code\nfrom adapters import (\n    archive_reader as old_reader,\n    PayloadWriter as ActiveWriter,\n    DeferredWriter,\n)\nimport obsolete.module as old_module\n\ndef archived_task(value):\n    old_reader(value)\n    old_module.reset()\n${oldBody}\n\nclass PayloadSession:\n    def append_payload(self, payload):\n${currentBody}\n        text = "QuotedFakeWriter should not be a dependency"\n        # CommentOnlyWitness\n        return ActiveWriter(payload,\n`;

test('cursor prefixes prioritize tail, enclosing scopes and unused imports over old code',()=>{
 const q=analyzeRecallQuery(pythonPrefix),c=q.cursorContext!;assert.ok(c);
 assert.equal(c.language,'python');assert.deepEqual(c.enclosingIdentifiers,['PayloadSession','append_payload']);
 assert.deepEqual(c.importedIdentifiers,['old_reader','ActiveWriter','DeferredWriter','old_module']);
 assert.deepEqual(c.unusedImportedIdentifiers,['DeferredWriter']);
 assert.deepEqual(c.nearTailImportedIdentifiers,['ActiveWriter']);
 for(const name of ['PayloadSession','append_payload','ActiveWriter','DeferredWriter','payload'])assert.ok(c.primaryIdentifiers.includes(name),name);
 for(const name of ['old_reader','old_module','archived_task','OldLicenseWitness','QuotedFakeWriter','CommentOnlyWitness','legacy_slot_0'])assert.ok(!c.primaryIdentifiers.includes(name),name);
 assert.equal(q.facets.find(f=>f.surface==='archived_task')?.weight,0.2);
 assert.equal(q.facets.find(f=>f.surface==='ActiveWriter')?.weight,6);
 assert.ok(!q.facets.some(f=>f.surface==='QuotedFakeWriter'));
 assert.ok(scoreFacetCoverage(q,'ActiveWriter DeferredWriter append_payload').score>scoreFacetCoverage(q,'archived_task '+oldBody).score);
 assert.equal(scoreFacetCoverage(q,'archived_task').anchored,false);
 assert.equal(q.original,pythonPrefix);assert.equal(q.querySha256,createHash('sha256').update(pythonPrefix).digest('hex'));
});

test('multiline JS/TS aliases and namespace/default imports use bound names',()=>{
 const q=analyzeRecallQuery(`Complete the following code:\n\`\`\`typescript\n/* LicenseWitness */\nimport DefaultClient, {\n  wireValue as bindValue,\n  spareValue,\n  type WireShape as LocalShape\n} from "remote-license";\nimport * as namespaceClient from 'other';\nfunction historical() {\n  DefaultClient();\n}\nclass WorkSession {\n  append(payload: LocalShape) {\n${currentBody}\n    const description = \`PretendDependency\`;\n    // TailCommentWitness\n    namespaceClient.send(bindValue(\n`),c=q.cursorContext!;
 assert.ok(c);assert.equal(c.language,'javascript');
 assert.deepEqual(c.importedIdentifiers,['DefaultClient','bindValue','spareValue','LocalShape','namespaceClient']);
 assert.deepEqual(c.enclosingIdentifiers,['WorkSession','append']);
 assert.ok(c.primaryIdentifiers.includes('spareValue'));assert.ok(c.primaryIdentifiers.includes('namespaceClient'));
 for(const name of ['DefaultClient','historical','PretendDependency','TailCommentWitness','LicenseWitness','wireValue','WireShape'])assert.ok(!c.primaryIdentifiers.includes(name),name);
 assert.equal(q.facets.find(f=>f.surface==='namespaceClient')?.weight,6);
 assert.ok(!q.facets.some(f=>['PretendDependency','TailCommentWitness','remote-license'].includes(f.surface)));
});

test('closed quoted examples, prose, MC questions and JSON output schema do not activate cursor weighting',()=>{
 for(const query of [
  'What is the import of the new policy on CedarDB?',
  'Explain this code:\nimport stuff\ndef foo():\n    return stuff()',
  'Which line is correct?\nimport foo\nvalue = foo()',
  'Explain this import statement:\n```python\nfrom adapters import PayloadWriter\nwriter = PayloadWriter()\n```',
  'Which is correct?\nA. import evidence\nB. export records\nC. retain evidence',
  'What does this code return?\n```js\nconst result = work();\n```\nA. null\nB. true',
  'Complete the JSON output schema:\n```json\n{"import": "PayloadWriter", "properties": {"cursor": "string"}}\n```',
  'Name CedarDB owner. Return the answer object with fields:\n```json\n{"import": "string", "owner": "string"}\n```',
  'A quoted fragment:\n```python\ndef unfinished(x):\n    return work(\n```\nExplain why it fails.'
 ])assert.equal(analyzeRecallQuery(query).cursorContext,undefined,query);
 const prose=analyzeRecallQuery('Pela probe? Return the answer object with fields: sample, fault_code');
 assert.deepEqual(prose.substantiveTerms,['pela','probe']);assert.equal(prose.facets.find(f=>f.surface==='Pela')?.weight,3);
 assert.ok(scoreFacetCoverage('Which CedarDB configuration is current? A. retryMode B. workerId','CedarDB retryMode').score>scoreFacetCoverage('Which CedarDB configuration is current? A. retryMode B. workerId','unrelated').score);
});

test('completion intent accepts closed prefixes; unclosed fences need structural syntax',()=>{
 for(const query of [
  'Complete this function:\n```python\ndef push(value):\n    return send(\n```',
  '```js\nfunction append(value) {\n  send(\n',
  '```python\nfrom adapters import Sender\n',
  '```\nimport { Sender } from "transport";\nconst writer = new Sender(\n'
 ])assert.ok(analyzeRecallQuery(query).cursorContext,query);
 for(const query of ['```\nThe import of this policy is substantial.', '```python\n# def false_cursor(value):\n#    return ImportedThing(', '```js\n"function fake() {"'])assert.equal(analyzeRecallQuery(query).cursorContext,undefined,query);
});

test('mask ignores triple quoted docstrings, escapes and multiline comments near cursor',()=>{
 const q=analyzeRecallQuery(`import Writer\ndef stream(payload):\n    """FakeClass\n    from fictional import FakeImport\n    \\\""" not closed yet\n    """\n    note = 'Escaped\\\'QuoteWitness'\n    return Writer(payload,\n`),c=q.cursorContext!;
 assert.ok(c);assert.ok(c.primaryIdentifiers.includes('Writer'));
 for(const name of ['FakeClass','FakeImport','Escaped','QuoteWitness'])assert.ok(!c.primaryIdentifiers.includes(name),name);
});

test('large queries retain bounded tail scan, capped metadata and original identity',()=>{
 const query='# header\n'+('# old copyright material\n'.repeat(5000))+'from bindings import NextWriter\ndef current(payload):\n    return NextWriter(payload,\n';
 const q=analyzeRecallQuery(query,12),c=q.cursorContext!;
 assert.ok(c);assert.ok(c.scannedCharacters<=65536);assert.equal(c.truncated,true);assert.equal(q.truncated,true);
 assert.ok(c.primaryIdentifiers.includes('NextWriter'));assert.ok(q.facets.length<=12);
 assert.equal(q.original,query);assert.equal(q.querySha256,createHash('sha256').update(query).digest('hex'));
 assert.ok(buildFtsQuery(q,4).split(' OR ').length<=4);
});

test('tail is the last eight nonempty masked lines, not license or blank lines',()=>{
 const q=analyzeRecallQuery('from tools import Dormant\ndef active(value):\n    earlierWitness = value\n'+Array.from({length:8},(_,i)=>`    near_${i} = value\n\n# Boilerplate_${i}\n`).join(''));
 assert.ok(q.cursorContext);assert.ok(!q.cursorContext.tailIdentifiers.includes('earlierWitness'));
 assert.ok(q.cursorContext.primaryIdentifiers.includes('active'));assert.ok(q.cursorContext.primaryIdentifiers.includes('Dormant'));
 assert.ok(!q.cursorContext.primaryIdentifiers.some(n=>n.startsWith('Boilerplate')));
});


test('raw completion wrappers are not primary identifiers',()=>{
 const q=analyzeRecallQuery('Please complete the following code:\nfrom adapters import Writer\ndef append(payload):\n    return Writer(payload,');
 assert.ok(q.cursorContext);assert.ok(!q.cursorContext.primaryIdentifiers.includes('Please'));
 assert.ok(!q.facets.some(f=>f.surface==='following'));assert.ok(q.cursorContext.codeStart>0);
});

test('query prose stopwords remain usable code bindings',()=>{
 const q=analyzeRecallQuery('from module import find\ndef apply(item):\n    return find(item,');
 assert.ok(q.cursorContext?.primaryIdentifiers.includes('find'));
 assert.equal(q.facets.find(f=>f.surface==='find')?.weight,6);
 assert.equal(q.facets.find(f=>f.surface==='apply')?.weight,6);
 assert.ok(buildFtsQuery(q).includes('"find"'));
});

test('unfenced triple strings and block comment definitions are not cursor syntax',()=>{
 for(const query of ['"""\ndef pretend(value):\n    return FalseDependency(\n"""', '/*\nfunction pretend(value) {\n return FalseDependency(\n*/'])assert.equal(analyzeRecallQuery(query).cursorContext,undefined);
});

test('code review and explanation requests preserve question obligations instead of becoming completion',()=>{
 for(const query of ['```python\ndef foo(value):\n    return value\n```\nContinue the code review and explain the vulnerability.','Explain this unfinished example:\n```python\ndef foo(value):\n    return value\n']){
  const q=analyzeRecallQuery(query);assert.equal(q.cursorContext,undefined);assert.ok(q.facets.some(f=>/vulnerability|unfinished|example/.test(f.surface)));
 }
 const q=analyzeRecallQuery('Complete the next line, preserving transactional isolation.\n```python\nfrom adapter import StoreAdapter\ndef write(value):\n    StoreAdapter(\n```');assert.ok(q.cursorContext);assert.ok(q.facets.some(f=>f.surface==='isolation'&&f.weight>=1));
});
