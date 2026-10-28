// Test-local expectations: never used to generate queries or ingest evidence.
import type { ContextPlan } from '../../src/planner.ts';
import type { ContextForgeStore } from '../../src/store.ts';
import type { Observation } from './fixtures.ts';
import { canonicalJson } from '../../src/store.ts';
const required100:Record<number,number[]>={
 45:[5,10,15,20,25,35,40],47:[2,19,27,32,42],49:[4,9,14,24,29,34,44],51:[2,19,47,3,8,13,4,9,14,5,20,40],
 53:[3,8,13,18,23,28,33,38,43],92:[2,19,27,32,47,57,71,87],
 94:[4,9,14,24,29,34,54,64,79,89],
 96:[2,19,27,47,71,3,8,13,93,4,9,14,79,94,5,20,40,55,95,15],98:[3,8,13,18,23,28,33,38,43,48,53,60,63,68,73,78,83,88,93],
 100:[5,10,20,35,40,50,55,58,65,90,95]
};
export function requiredTurns(turn:number,count:number):number[] {
 if(count===100)return required100[turn]??[];
 const retained=(n:number)=>n<=40||n>=91;
 const midMap:Record<number,number>={31:51,33:53,35:45,37:47,39:49};
 if(turn in midMap)return required100[midMap[turn]].filter(n=>n<turn);
 if(![42,44,46,48,50].includes(turn))return [];
 const full=turn+50;
 return (required100[full]??[]).filter(n=>retained(n)&&n<full);
}
export function scorePremises(plan:ContextPlan,turn:number,count:number,originals:Observation[],store:ContextForgeStore) {
 const checks=requiredTurns(turn,count).map(n=>{
 const p=originals[n-1];
 const support=plan.receipt.selections.filter(s=>{
  const source=store.getSource(s.sourceId);if(!source||!['user','tool'].includes(source.role??''))return false;
  const raw=s.provenanceSpanIds.map(id=>store.readEvidenceSpan(id).text).join('');
  const delivered=s.renderedMessageIndexes.map(i=>canonicalJson(plan.messages[i])).join('');
  return raw.includes(p.text)&&delivered.includes(p.text);
 });
 return {originalTurn:n,anchor:p.anchor,present:support.length>0,sourceIds:[...new Set(support.map(s=>s.sourceId))],spanIds:[...new Set(support.flatMap(s=>s.provenanceSpanIds))]};
 });
 return {turn,required:checks.length,covered:checks.filter(c=>c.present).length,allPremisesCovered:checks.length>0&&checks.every(c=>c.present),checks};
}
// All values are independently frozen, not derived from runtime generator output.
export const expected={
 scaling:{initialExponent:'0.31',correctedExponent:'0.22',rooflineTokensPerSecond:'200000'},
 assay:{gain:'4.184000',observations:20,firstJ:'120.000000000000000000',lastJ:'122.345678991234567901',driftJ:'2.345678991234567901',finalReagentG:'0.200000000000000020',finalSolventG:'0.400000000000000060'},
 consensus:{n:7,f:2,quorum:5,safety:'durable promise before acknowledgement',liveness:'eventual synchrony'},
 clinical:{oldSensitivity:'0.82',sensitivity:'0.91',externalAUROC:null,exception:'washout>=14 AND confirmatory negative'}
} as const;
export function decimalUnits(text:string):bigint {
 if(!/^-?\d+(?:\.\d{1,18})?$/.test(text))throw new Error('Expected decimal with <=18 places');
 const negative=text.startsWith('-'),[whole,fraction='']=text.replace(/^-/,'').split('.');
 return (BigInt(whole)*10n**18n+BigInt(fraction.padEnd(18,'0')))*(negative?-1n:1n);
}
export function verifyAssayArithmetic(rows:Observation[]) {
 const ledger=rows.filter(r=>r.track==='calorimetry-assay');
 const values=ledger.map(r=>{
 const readings=[...r.text.matchAll(/read (-?\d+\.\d+) (g|J)/g)];
 if(readings.length!==4)throw new Error('Missing original decimal readings');
 const [tare,reagent,solvent,enthalpy]=readings.map(m=>decimalUnits(m[1]));
 return {reagent:reagent-tare,solvent:solvent-reagent,enthalpy};
 });
 const last=values.at(-1)!;
 return {observations:values.length,pass:values.length===20&&values[0].enthalpy===decimalUnits(expected.assay.firstJ)&&last.enthalpy===decimalUnits(expected.assay.lastJ)&&last.enthalpy-values[0].enthalpy===decimalUnits(expected.assay.driftJ)&&last.reagent===decimalUnits(expected.assay.finalReagentG)&&last.solvent===decimalUnits(expected.assay.finalSolventG)&&values.slice(1).every((v,i)=>v.enthalpy-values[i].enthalpy===123456789012345679n)};
}
export function scoreResponse(track:string,response:string) {
 const checks:Record<string,RegExp[]>={
 'scaling-law':[/0\.31/,/0\.22/,/warmup/i,/200[,.]?000|1\.6/i],
 'calorimetry-assay':[/4\.184/,/reject|retain/i,/subtract|difference/i],
 'distributed-consensus':[/durable|persist/i,/quorum|certificate/i,/eventual|conditional/i],
 'clinical-cohort':[/0\.91/,/both|conjunct|\bAND\b/,/sealed|unknown|abstain/i],
 'cross-track-synthesis':[/warmup/i,/calibrat/i,/sealed|unknown/i,/fenc|promise/i]
 };
 return {rubric:'lexical-screen-not-comprehension-proof',pass:(checks[track]??[]).every(re=>re.test(response)),hasCitation:/\[span:[^\]]+\]/.test(response),requiresHumanReview:true};
}
