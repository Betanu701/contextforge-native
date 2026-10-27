// Runtime inputs only. No expected answers or scoring rules belong in this module.
import { deflateSync } from 'node:zlib';
import type { AcceptedMessage } from '../../src/types.ts';
export const FIXTURE_VERSION = 'long-horizon-v1';
export type Track = 'architecture'|'implicit'|'debugging'|'drift'|'ambiguity';
export interface Premise { id:string; track:Track; text:string; turn:number; protocol?:boolean }
export interface ScenarioTurn { turn:number; query:string; premises:Premise[]; probe?:Track; image?:boolean; spike?:number; release?:number; pendingContext?:string }
export function premises(turns:number):Premise[] {
  const at=(n:number)=>Math.max(1,Math.floor(n*turns/100));
  const rows:Premise[]=[
    {id:'arch-start',track:'architecture',turn:1,text:'Aster archive Plan A proposes parallel shard writes without fencing; proposal only, not adopted.'},
    {id:'arch-failure',track:'architecture',turn:at(12),protocol:true,text:'Aster load-test log: Plan A failed under reconnecting stale writers. Duplicate commits appeared at epoch boundaries; p99=910ms, duplicate_count=19. EXPLAIN shows concurrent write fanout, not disk saturation.'},
    {id:'arch-reverse',track:'architecture',turn:at(20),text:'Aster decision: reject Plan A after the measured duplicate commits. Adopt Plan B serialized writes with a temporary epoch fence on every write.'},
    {id:'arch-return',track:'architecture',turn:at(65),text:'Aster config diff: remove the temporary fence on steady-state writes only. Keep the epoch fence for reconnecting writers because stale leases can survive a reconnect. Plan B remains active; this is a partial rollback, not Plan A restoration.'},
    {id:'implicit-a',track:'implicit',turn:at(8),text:'Nacre operations: Tuesday 18:00–22:00 changes are prohibited. The sole exception permits failback when all three replicas are caught up AND temperature is below 70C; a two-replica majority is insufficient.'},
    {id:'implicit-b',track:'implicit',turn:at(27),text:'Nacre maintenance runbook: outside that interval a normal majority suffices. During the restricted interval the thermal and replication tests are conjunctive, even if delaying means a slower service.'},
    {id:'debug-tool',track:'debugging',turn:at(5),protocol:true,text:'Juniper error trace: gateway GET /health => ECONNREFUSED 8120; direct GET localhost:8119/health => 200. PID 744 effective LISTEN_PORT=8119. Retries did not help.'},
    {id:'debug-image',track:'debugging',turn:at(35),text:'Juniper deployment diagram: original console image top row is the gateway destination; bottom row is the process listener. The network arrow connects those two endpoints.'},
    {id:'debug-config',track:'debugging',turn:at(68),text:'Juniper configuration specification: service.yaml sets LISTEN_PORT=8120 and timeout_ms=900. launcher.sh sources legacy.env AFTER service.yaml; legacy.env exports LISTEN_PORT=8119 and timeout_ms=120. Later assignments win. Public routing and timeout_ms=900 must remain unchanged in the intended deployment.'},
    {id:'amb-first',track:'ambiguity',turn:at(4),text:'Selka east cluster uses quorum=3 and timeout_ms=900. Selka west cluster uses quorum=5 and timeout_ms=1200. Both siblings are provisioned; their settings are not defaults for other clusters.'},
    {id:'amb-second',track:'ambiguity',turn:at(82),text:'Selka north cluster remains unprovisioned. Its quorum was explicitly left undecided; only its planned timeout_ms=900 is agreed. No east/west inheritance rule was approved.'},
    {id:'drift-scale',track:'drift',turn:at(38),text:'The Orion lab balance was not tared: the empty vessel read 218.5 g, after resin it read 643.75 g, and after solvent it read 901.25 g'},
    {id:'drift-reject',track:'drift',turn:at(48),text:'Orion RFC-42 proposed retry_limit=9 but was rejected after duplicate flushes. Existing retry_limit=3 remains active.'},
    {id:'drift-correct',track:'drift',turn:at(60),text:'Orion config correction: batch_size=64 replaces batch_size=128; retry_limit=3 is unchanged. Test runner: 42 passed, duplicate_flush=0.'},
  ];
  for(let i=0;i<27;i++) rows.push({id:`drift-${i}`,track:'drift',turn:at(5+i*2),text:`Orion reservoir ledger observation ${String(i+1).padStart(2,'0')}: cumulative delivered volume is ${(10000+i*137+(i%3)*11)/100} litres. This is a meter total, not a per-delivery quantity.`});
  return rows.sort((a,b)=>a.turn-b.turn||a.id.localeCompare(b.id));
}
export const questions:Record<Track,string>={
  architecture:'Aster archive: may we remove the remaining reconnecting-writer fence? Explain the active plan, partial rollback, original load-test failure, and why the proposed change would or would not restore that failure. Cite original evidence.',
  implicit:'Nacre: it is Tuesday 20:15, temperature is 66C, two replicas are current and the third is behind. May the operator execute failback now? What if the third catches up? Explain using the earlier operations and maintenance evidence.',
  debugging:'Juniper incident: synthesize the original error trace, deployment diagram and configuration specification. Explain the three-hop root cause and give exact port and timeout parameters, narrow edit, restart and verification. Cite originals.',
  drift:'Orion: reconstruct all reservoir ledger observations 01 through 27; give net addition, last increment and final reading. Also calculate resin and solvent net added amounts from the untared lab balance, with separate numeric resin, solvent and unit fields. Explain active batch_size and retry_limit versus rejected and superseded episodes. Cite original evidence.',
  ambiguity:'Selka north has planned timeout 900; can we diagnose its quorum as 3 from sibling telemetry? Give known and unknown fields and explain whether action is justified from the original north/east/west provisioning evidence.',
};
export function scenario(turns:number,spikes:number):ScenarioTurn[] {
  const p=premises(turns), tracks=Object.keys(questions) as Track[];
  const probeAt=turns===100?[84,88,92,96,100]:[42,44,46,48,50];
  // Every spike has an immediate non-probe next turn; no overlap or last-turn spike.
  const spikeAt=[...Array(spikes)].map((_,i)=>Math.floor((i+1)*(turns*0.72)/(spikes+1))+2);
  return Array.from({length:turns},(_,i)=>{
    const turn=i+1, current=p.filter(r=>r.turn===turn), probe=tracks[probeAt.indexOf(turn)];
    const spike=spikeAt.indexOf(turn), release=spikeAt.indexOf(turn-1);
    const observed=current.filter(p=>!p.protocol).map(p=>p.text).join('\n');
    const base=probe?questions[probe]:spike>=0?'Read these telemetry documents and acknowledge receipt.':release>=0?'Thanks!':current.some(p=>p.protocol)?'Juniper runtime inspection completed. Inspect the native tool result.':observed?'':`Routine turn ${turn}: unrelated wind station maintenance is complete. Acknowledge briefly.`;
    return {turn,premises:current,...(probe?{probe}:{}),...(current.some(p=>p.id==='debug-image')||probe==='debugging'?{image:true}:{}),...(spike>=0?{spike}:{}),...(release>=0?{release}:{}),...((spike<0)?{pendingContext:[observed,'Current work log: '+('sample stable; queue normal; checksum valid; '.repeat(165))].filter(Boolean).join('\n')}:observed?{pendingContext:observed}:{}),query:spike>=0||release>=0?base:[base,observed].filter(Boolean).join('\n')};
  });
}
// A real, deterministic PNG console, not a base64 placeholder. Native image delivery
// is scored independently from captions. Text is rasterized with a tiny bitmap font.
export function consolePng():Buffer {
  const font:Record<string,string>={E:'111101110100111',D:'110101101101110',G:'111100101101111',R:'110101110101101',U:'101101101101111',N:'101111111111101','8':'111101111101111','1':'010110010010111','2':'111001111100111','0':'111101101101111','9':'111101111001111',' ':'000000000000000',':':'000010000010000'};
  const w=260,h=60,bytes=Buffer.alloc(h*(1+w*3),255);
  for(let y=0;y<h;y++)bytes[y*(1+w*3)]=0;
  for(const [text,top] of [['EDGE:8120',5],['RUN:8119',32]] as const)for(let k=0;k<text.length;k++)for(let y=0;y<5;y++)for(let x=0;x<3;x++)if(font[text[k]]?.[y*3+x]==='1')for(let dy=0;dy<3;dy++)for(let dx=0;dx<3;dx++){const pos=(top+y*3+dy)*(1+w*3)+1+(8+k*14+x*3+dx)*3;bytes.fill(20,pos,pos+3);}
  const crc=(b:Buffer)=>{let c=0xffffffff;for(const x of b){c^=x;for(let i=0;i<8;i++)c=(c>>>1)^((c&1)?0xedb88320:0);}return (c^0xffffffff)>>>0;};
  const chunk=(type:string,data:Buffer)=>{const t=Buffer.from(type),size=Buffer.alloc(4),sum=Buffer.alloc(4);size.writeUInt32BE(data.length);sum.writeUInt32BE(crc(Buffer.concat([t,data])));return Buffer.concat([size,t,data,sum]);};
  const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(w);ihdr.writeUInt32BE(h,4);ihdr[8]=8;ihdr[9]=2;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),chunk('IHDR',ihdr),chunk('IDAT',deflateSync(bytes)),chunk('IEND',Buffer.alloc(0))]);
}
export function protocolMessages(p:Premise):AcceptedMessage[] {
  const id=`inspect-${p.id}`;
  return [{id:`call-${p.id}`,role:'assistant',content:[{type:'toolCall',id,name:'inspect_runtime',arguments:{service:p.track==='architecture'?'Aster':'Juniper'}}]}, {id:`result-${p.id}`,role:'tool',toolCallId:id,content:p.text}, {id:`follow-call-${p.id}`,role:'assistant',content:[{type:'toolCall',id:id+'-verify',name:'run_tests',arguments:{suite:'config-diff-and-explain'}}]}, {id:`follow-result-${p.id}`,role:'tool',toolCallId:id+'-verify',content:'Configuration diff inspected; database EXPLAIN: indexed scan, no disk saturation. Test runner: 42 passed, 0 skipped.'}];
}
export function pressureDocuments(tokens:number,index:number):string[] {
  // Real source bytes enter the assembled messages; never simulate pressure by
  // changing a receipt or charging fictional media tokens.
  const bytes=Math.ceil(tokens*3.6),count=12;
  return Array.from({length:count},(_,i)=>{const prefix=`PRESSURE_${index}_${i} telemetry batch\n`;const line=`zone=${i} sample=steady latency=17ms checksum=ok temperature=42C no_incident=true; `;return prefix+line.repeat(Math.ceil((Math.ceil(bytes/count)-prefix.length)/line.length)).slice(0,Math.ceil(bytes/count)-prefix.length);});
}
