// Scoring data: never imported by the fixture generator or transmitted to a model.
import type { Track, Premise } from './fixtures.ts';
import type { ContextPlan } from '../../src/planner.ts';
import { canonicalJson } from '../../src/store.ts';
import type { ContextForgeStore } from '../../src/store.ts';
export const expected={
  architecture:{current:'Plan B',remainingHook:'epoch fence for reconnecting writers',cause:'duplicate commits'},
  implicit:{decision:'wait',exception:'all three replicas current and below 70C'},
  debugging:{publicPort:8120,effectivePort:8119,healthStatus:200,rootCause:'legacy.env overrides service.yaml',fix:'update stale override and restart'},
  drift:{observations:27,firstCentiLitres:10000,lastCentiLitres:13584,addedCentiLitres:3584,finalIncrementCentiLitres:148},
  ambiguity:{action:'abstain',knownTimeout:900,quorum:null},
} as const;
export function scorePremises(plan:ContextPlan,rows:Premise[],track:Track,store:ContextForgeStore) {
  const required=rows.filter(p=>p.track===track);
  const checks=required.map(p=>{
    const support=plan.receipt.selections.filter(s=>{
      const source=store.getSource(s.sourceId);
      if(!source||!['user','tool'].includes(source.role??''))return false;
      const original=s.provenanceSpanIds.map(id=>store.readEvidenceSpan(id).text).join('');
      const delivered=s.renderedMessageIndexes.map(i=>canonicalJson(plan.messages[i])).join('');
      return original.includes(p.text)&&delivered.includes(p.text);
    });
    return {id:p.id,present:support.length>0,wireTextPresent:canonicalJson(plan.messages).includes(p.text),hostTranscriptSupport:support.some(s=>store.getSource(s.sourceId)?.originSystem==='host'),rawArchiveSupport:support.some(s=>store.getSource(s.sourceId)?.originKey===`original-${p.id}`),originalSourceIds:[...new Set(support.map(s=>s.sourceId))]};
  });
  const spans=plan.receipt.selections.flatMap(s=>s.provenanceSpanIds);
  return {track,required:checks.length,covered:checks.filter(c=>c.present).length,complete:checks.every(c=>c.present),checks,originalSpanCount:new Set(spans).size,...(checks.some(c=>!c.present)?{missingPremiseWire:plan.messages}: {})};
}
// Deliberately conservative lexical rubric, NOT a semantic judge. Retain every
// response for human causal/citation review; passing these checks is not proof
// of comprehension. No answer-key fragments are added to the runtime prompt.
export function scoreResponse(track:Track,response:string) {
  const checks:Record<Track,Array<[string,RegExp]>>={
    architecture:[['Plan B',/Plan B/i],['empirical failure',/duplicate/i],['remaining hook',/reconnect|stale/i],['partial rollback',/steady|partial/i]],
    implicit:[['wait',/wait|not|cannot/i],['three replicas',/three|all.*replica/i],['thermal threshold',/70/]],
    debugging:[['public endpoint',/8120/],['actual listener',/8119/],['original health result',/\b200\b/],['override cause',/legacy\.env/],['precedence',/after|override|precedence|later/i],['restart',/restart/i],['verify',/verify|health|effective/i]],
    drift:[['net addition exact',/\b35\.84\b/],['last increment exact',/\b1\.48\b/],['final reading exact',/\b135\.84\b/],['cumulative reasoning',/cumulative|subtract|difference/i]],
    ambiguity:[['unknown quorum',/unknown|undecided|unprovisioned/i],['known timeout',/900/],['no extrapolation',/not|cannot|abstain/i]],
  };
  const result=checks[track].map(([name,re])=>({name,pass:re.test(response)}));
  return {rubric:'lexical-screen-not-semantic-proof',checks:result,pass:result.every(c=>c.pass),hasCitation:/\[span:[^\]]+\]/.test(response),requiresHumanReview:true};
}
