import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { parseArgs, runBenchmark, wireMessages, presets } from '../benchmarks/long-horizon-understanding/runner.ts';
import { scenario, premises, pressureDocuments, consolePng } from '../benchmarks/long-horizon-understanding/fixtures.ts';
import { expected, scoreResponse } from '../benchmarks/long-horizon-understanding/oracles.ts';

test('CLI validates bounded pressure and sequential live opt-in; all presets are ready',()=>{
  assert.deepEqual(Object.keys(presets),['local-sequential','cloud-economical','stress-max']);
  for(const name of Object.keys(presets)){const o=parseArgs(['--preset',name]);assert.equal(o.live,false);assert.ok(o.spikeTokens===150000);}
  for(const spikes of [0,1,2,3,4,5])assert.equal(parseArgs(['--pressure-spikes',String(spikes)]).pressureSpikes,spikes);
  assert.equal(parseArgs(['--spike-ratio','0.5','--window','400000']).spikeTokens,200000);
  for(const args of [['--turns','80'],['--pressure-spikes','6'],['--pressure-spikes','-1'],['--spike-ratio','1'],['--window','64000'],['--spike-tokens','NaN'],['--live'],['--bad','yes'],['--spike-tokens','1','--spike-ratio','0.5']])assert.throws(()=>parseArgs(args));
});

test('frozen runtime premises have five deep tracks, 27 meter observations, and no oracle import',()=>{
  const p=premises(100),s=scenario(100,5);
  assert.equal(p.filter(x=>x.track==='architecture').length,4);
  assert.equal(p.filter(x=>x.id.startsWith('drift-')&&/^drift-\d+$/.test(x.id)).length,27);
  assert.equal(s.find(x=>x.probe==='ambiguity')!.turn,100);
  assert.ok(s.filter(x=>x.probe).every(x=>x.turn>80));
  for(const x of s.filter(x=>x.spike!==undefined)){assert.ok(s[x.turn].release!==undefined);assert.equal(s[x.turn].probe,undefined);}
  assert.equal(expected.drift.lastCentiLitres-expected.drift.firstCentiLitres,expected.drift.addedCentiLitres);
  const meter=p.filter(x=>/^drift-\d+$/.test(x.id)).map(x=>Number(/is ([\d.]+) litres/.exec(x.text)![1]));
  assert.equal(Math.round((meter.at(-1)!-meter[0])*100),3584);
  assert.equal(Math.round((meter.at(-1)!-meter.at(-2)!)*100),148);
  assert.deepEqual([...consolePng().subarray(0,8)],[137,80,78,71,13,10,26,10]);
  const fixtures=readFileSync(new URL('../benchmarks/long-horizon-understanding/fixtures.ts',import.meta.url),'utf8');
  assert.doesNotMatch(fixtures,/from ['"].*oracles/);
  for(const name of readdirSync(new URL('../src/',import.meta.url)).filter(n=>n.endsWith('.ts'))){const production=readFileSync(new URL(`../src/${name}`,import.meta.url),'utf8');for(const marker of ['Orion reservoir ledger observation','Nacre operations: Tuesday','Selka north cluster remains unprovisioned'])assert.ok(!production.includes(marker),`Fixture literal leaked into ${name}`);}
  assert.ok(pressureDocuments(150000,0).reduce((n,t)=>n+Buffer.byteLength(t),0)>=540000);
  assert.equal(scoreResponse('ambiguity','I will fetch the cedar cabinet key.').pass,false);
});

test('native provider adapter preserves image and call/result protocol without text flattening',()=>{
  const fake:any={systemPrompt:'policy',messages:[{role:'assistant',content:[{type:'toolCall',id:'call-1',name:'inspect_runtime',arguments:{service:'Juniper'}}]},{role:'tool',toolCallId:'call-1',content:'original runtime output'},{role:'user',content:[{type:'image',mimeType:'image/png',data:consolePng().toString('base64')}]}]};
  const wire=wireMessages(fake,'inspect');
  assert.equal(wire[1].tool_calls[0].id,'call-1');assert.equal(wire[2].role,'tool');assert.equal(wire[2].tool_call_id,'call-1');assert.match(wire[3].content[0].image_url.url,/^data:image\/png;base64,/);
  assert.equal(wire.at(-1).content,'inspect');
});

// Offline only: fail immediately if any accidental network/inference is added.
for(const [turns,spikes] of [[50,3],[50,5],[100,3],[100,5]])test(`real SQLite compiler/planner: ${turns} turns, ${spikes} actual 150k-wire spikes, immediate release, all originals`,{timeout:240000},async()=>{
  const old=globalThis.fetch;globalThis.fetch=async()=>{throw new Error('Offline benchmark must not invoke inference/network');};
  try {
    const o=parseArgs(['--turns',String(turns),'--pressure-spikes',String(spikes)]),report=await runBenchmark(o);
    console.log(JSON.stringify({turns,spikes,summary:report.summary,coverage:report.coverage.map(c=>({track:c.track,covered:c.covered,required:c.required,missing:c.checks.filter(x=>!x.present).map(x=>x.id)})),spikeWireTokens:report.events.filter(e=>e.kind==='pressure').map(e=>e.wireTextTokensHeuristic),releaseWireTokens:report.events.filter(e=>e.kind==='release').map(e=>e.wireTextTokensHeuristic)}));
    assert.equal(report.mode,'offline-real-engine');assert.equal(report.responses.length,0);
    assert.equal(report.summary.turns,turns);assert.equal(report.summary.tracks,5);assert.equal(report.summary.premisesCovered,41,JSON.stringify(report.coverage.flatMap(c=>c.checks.filter(x=>!x.present))));assert.equal(report.summary.premisesRequired,41);
    assert.equal(report.summary.allPremisesCovered,true);assert.equal(report.summary.spikes,spikes);assert.equal(report.summary.releases,spikes);
    assert.equal(report.summary.pressurePass,true);assert.equal(report.summary.releasePass,true);assert.equal(report.summary.protocolClosureObserved,true);assert.equal(report.summary.nativeImageAtDebugProbe,true);
    assert.ok(report.summary.verifiedSpans>100);
    const pressure=report.events.filter(e=>e.kind==='pressure');
    for(const e of pressure){assert.ok(e.wireTextTokensHeuristic>=150000);assert.ok(e.wireBytes>=540000);assert.equal(e.selectedPressureSources,12);const next=report.events[e.turn];assert.equal(next.release,e.spike);assert.equal(next.selectedPressureSources,0);assert.ok(next.wireTextTokensHeuristic>=2000&&next.wireTextTokensHeuristic<=10000);}
    for(const c of report.coverage){assert.equal(c.complete,true,JSON.stringify(c));assert.ok(c.originalSpanCount>0);}
  } finally {globalThis.fetch=old;}
});
