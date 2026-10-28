import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ContextForgeStore } from '../src/store.ts';
import { ContextForgeCompiler } from '../src/compiler.ts';
import { spawnSync } from 'node:child_process';
import { parseArgs, runBenchmark, verifyManifest, wireMessages, pressureSupportSourceIds } from '../benchmarks/deep-research-100turns/runner.ts';
import { observations, scenario, TRACKS, pressureDocuments } from '../benchmarks/deep-research-100turns/fixtures.ts';
import { expected, decimalUnits, verifyAssayArithmetic, requiredTurns, scorePremises } from '../benchmarks/deep-research-100turns/oracles.ts';
import { classifyQueryDemand } from '../src/planner.ts';
import { analyzeRecallQuery } from '../src/retrieval.ts';

test('deep research CLI defaults to offline 100 turns and requires explicit bounded pressure',()=>{
 assert.equal(parseArgs([]).turns,100);assert.equal(parseArgs([]).pressureSpikes,3);
 for(let n=0;n<=5;n++)assert.equal(parseArgs(['--pressure-spikes',String(n)]).pressureSpikes,n);
 assert.equal(parseArgs(['--spike-ratio','0.92']).spikeTokens,241173);
 for(const a of [['--live'],['--endpoint','http://invalid'],['--turns','99'],['--pressure-spikes','6'],['--pressure-spikes','1.2'],['--spike-ratio','1'],['--spike-ratio','NaN'],['--spike-tokens','0'],['--window','64000'],['--turns','50','--turns','100'],['--spike-tokens','150000','--spike-ratio','0.92']])assert.throws(()=>parseArgs(a));
 const r=spawnSync(process.execPath,['benchmarks/deep-research-100turns/run-live.mjs'],{encoding:'utf8'});assert.equal(r.status,1);assert.match(r.stderr,/No inference performed/);
});

test('100 distinct detailed observations, 20 per track, zero filler, separated frozen oracles',()=>{
 verifyManifest();const rows=observations(),s=scenario();
 assert.equal(rows.length,100);assert.equal(new Set(rows.map(r=>r.text)).size,100);
 for(const t of TRACKS)assert.equal(rows.filter(r=>r.track===t).length,20);
 assert.match(rows[1].text,/0\.31/);assert.match(rows[18].text,/microbatch/);assert.match(rows[46].text,/0\.22/);assert.match(rows[70].text,/200000/);
 assert.equal(rows[57].track,'clinical-cohort');assert.match(rows[57].text,/numerical calibration/);
 for(const row of s){assert.ok(row.text.length>400);assert.ok(row.query.length>500);assert.ok(analyzeRecallQuery(row.query).substantiveTerms.length>0);const d=classifyQueryDemand(row.query);assert.notEqual(d.primary,'conversational');assert.ok(d.signals.includes('substantive_evidence_query'));assert.doesNotMatch(row.query,/acknowledge|routine turn/i);}
 assert.equal(s.filter(r=>r.checkpoint).length,10);assert.deepEqual(s.filter(r=>r.checkpoint).map(r=>r.turn),[45,47,49,51,53,92,94,96,98,100]);
 for(const c of s.filter(r=>r.checkpoint)){assert.equal(c.track,c.checkpoint);const refs=requiredTurns(c.turn,100);assert.ok(refs.length>=5);assert.ok(refs.every(n=>n<c.turn));for(const n of refs)assert.ok(c.query.includes(rows[n-1].anchor));}
 assert.ok(s[95].query.includes(rows[14].anchor),'81-turn cross-track synthesis dependency');
 for(const lag of [10,30,60,85])assert.ok(s[98].query.includes(rows[98-lag].anchor),`Turn 99 reference ${lag} turns back`);
 for(const count of [50,100])for(let spikes=0;spikes<=5;spikes++){const turns=scenario(count,spikes);assert.equal(turns.length,count);assert.equal(turns.filter(r=>r.checkpoint).length,10);for(const t of TRACKS)assert.equal(turns.filter(r=>r.track===t).length,count/5);for(const r of turns.filter(r=>r.spike!==undefined)){assert.equal(r.checkpoint,undefined);assert.equal(turns[r.turn].release,r.spike);}}
 const fixture=readFileSync(new URL('../benchmarks/deep-research-100turns/fixtures.ts',import.meta.url),'utf8');assert.doesNotMatch(fixture,/from ['"].*oracles/);
 for(const file of readdirSync(new URL('../src/',import.meta.url)).filter(n=>n.endsWith('.ts'))){const text=readFileSync(new URL('../src/'+file,import.meta.url),'utf8');for(const marker of ['MoERun','ThermoRun','CohortRun','BULK_LITERATURE_'])assert.ok(!text.includes(marker),`Production leakage in ${file}`);}
 const offline=readFileSync(new URL('../benchmarks/deep-research-100turns/runner.ts',import.meta.url),'utf8');assert.doesNotMatch(offline,/\bfetch\s*\(|from ['"].*live-runner/);
 assert.ok(pressureDocuments(150000,0).reduce((n,t)=>n+Buffer.byteLength(t),0)>=540000);
});

test('exact eighteen-place untared subtraction, 20-step cumulative ledger and negative premise control',()=>{
 assert.equal(verifyAssayArithmetic(observations()).pass,true);
 assert.equal(decimalUnits(expected.assay.lastJ)-decimalUnits(expected.assay.firstJ),decimalUnits(expected.assay.driftJ));
 assert.equal(decimalUnits('1000000000000.200000000000000021')-decimalUnits('1000000000000.000000000000000001'),decimalUnits(expected.assay.finalReagentG));
 assert.throws(()=>decimalUnits('0.0000000000000000001'));
 // Also exercise the production generic compiler, not just oracle arithmetic.
 const directory=mkdtempSync(join(tmpdir(),'cf-deep-decimal-')),store=new ContextForgeStore(join(directory,'store.sqlite'));
 try {
  const source=store.ingestSource({originKey:'tail-balance',kind:'document',role:'user',text:observations()[97].text});new ContextForgeCompiler(store).compile();
  const facts=store.db.prepare("SELECT f.node_id,f.object_json,n.canonical_json FROM facts f JOIN derived_nodes n USING(node_id) WHERE f.predicate='net_mass'").all();
  for(const value of [expected.assay.finalReagentG,expected.assay.finalSolventG]){const fact=facts.find(f=>JSON.parse(String(f.object_json)).value===value);assert.ok(fact,`Compiler lost exact net mass ${value}`);assert.equal(JSON.parse(String(fact.canonical_json)).formula.rounding,'exact_decimal');assert.ok(store.getProvenance(String(fact.node_id)).some(p=>p.sourceId===source.sourceId));}
 }finally{store.close();rmSync(directory,{recursive:true,force:true});}

 const fake:any={receipt:{selections:[]},messages:[]};const negative=scorePremises(fake,100,100,observations(),{} as any);assert.equal(negative.covered,0);assert.equal(negative.allPremisesCovered,false);
});

test('pressure leakage includes secondary original provenance, not just primary sources',()=>{
 const plan:any={receipt:{selections:[{sourceId:'notebook',provenanceSpanIds:['secondary-bulk-span']}]}};
 const store:any={readEvidenceSpan:()=>({sourceId:'dump'}),getSource:(id:string)=>({originKey:id==='dump'?'bulk-2-4':'MoERun002'})};
 assert.deepEqual([...pressureSupportSourceIds(plan,store)],['dump']);
});

test('invalid live admission is rejected before the injected dispatcher can spend',async()=>{
 let calls=0;
 const options=parseArgs(['--pressure-spikes','0','--window','16384','--research-budget','3000','--max-output','20000']);
 await assert.rejects(runBenchmark(options,async()=>{calls++;return {response:'not reached',usage:null,latencyMs:0};}),/before dispatch/);
 assert.equal(calls,0);
});

test('wire adapter retains genuine protocol call/result pairing',()=>{
 const p:any={systemPrompt:'policy',messages:[{role:'assistant',content:[{type:'toolCall',id:'q',name:'inspect_experiment',arguments:{notebook:'record'}}]},{role:'tool',toolCallId:'q',content:'original counterexample'}]};
 const w=wireMessages(p,'untared observation','analyze safety');assert.equal(w[1].tool_calls[0].id,'q');assert.equal(w[2].tool_call_id,'q');assert.equal(w.at(-1).content,'untared observation\n\nanalyze safety');
});

for(const args of [[],['--turns','50','--pressure-spikes','0'],['--turns','50','--pressure-spikes','5','--spike-ratio','0.92']])test(`offline real-engine substantive research: ${args.join(' ')||'100 turns, 3 x 150k'}`,{timeout:900000},async()=>{
 const previous=globalThis.fetch;globalThis.fetch=async()=>{throw new Error('NO NETWORK OR MODEL INFERENCE ALLOWED');};
 try {
  const options=parseArgs(args),r=await runBenchmark(options);
  console.log(JSON.stringify({deepResearch:options,summary:r.summary,coverage:r.coverage.map(c=>({turn:c.turn,covered:c.covered,required:c.required,missing:c.checks.filter(x=>!x.present).map(x=>x.anchor)})),spikeTokens:r.events.filter(e=>e.spike!==null).map(e=>e.wireTokensHeuristic)}));
  assert.equal(r.pass,true);assert.equal(r.mode,'offline-real-engine');assert.equal(r.responses.length,0);assert.equal(r.summary.turns,options.turns);
  assert.equal(r.summary.fillerTurns,0);assert.equal(r.summary.conversationalTurns,0);assert.equal(r.summary.substantiveTurns,options.turns);assert.equal(r.summary.checkpoints,10);assert.equal(r.summary.allPremisesCovered,true);
  for(const c of r.coverage){assert.equal(c.covered,c.required);assert.equal(c.pressureLeakage,false);for(const p of c.checks){assert.ok(p.sourceIds.length>0);assert.ok(p.spanIds.length>0);}}
  assert.equal(r.summary.bounded,true);assert.ok(r.summary.nonSpikeMaxWireTokens<=14000);assert.equal(r.summary.noPressureLeakage,true);assert.equal(r.summary.spikes,options.pressureSpikes);assert.equal(r.summary.pressurePass,true);assert.equal(r.summary.releasePass,true);assert.equal(r.summary.withinWindow,true);assert.equal(r.summary.protocolClosureObserved,true);
  for(const e of r.events){assert.ok(e.optionalRetrievalSelections>0);assert.ok(e.expansionStages>0);assert.ok(e.substantiveTerms>0);if(e.spike!==null){assert.ok(e.wireTokensHeuristic>=options.spikeTokens);assert.equal(e.fullyAdmittedPressureDocuments,12);assert.equal(e.bulkMarkers.length,12);const next=r.events[e.turn];assert.equal(next.release,e.spike);assert.equal(next.bulkMarkers.length,0);assert.equal(next.selectedPressureSources,0);assert.ok(next.pressureSourcesArchived>0);}}
  if(options.turns===100){assert.equal(r.summary.premisesRequired,108);assert.ok(r.events[98].wireTokensHeuristic<=14000);assert.equal(r.events[98].pressureSourcesArchived,36);}
 }finally{globalThis.fetch=previous;}
});
