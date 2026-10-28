// Runtime research notebook only. No expected answers or scoring imports.
export const FIXTURE_VERSION = 'deep-research-100turns-v1';
export const TRACKS = ['scaling-law','calorimetry-assay','distributed-consensus','clinical-cohort','cross-track-synthesis'] as const;
export type Track = typeof TRACKS[number];
export interface Observation {turn:number;track:Track;anchor:string;text:string;protocol?:boolean}
export interface ResearchTurn extends Observation {query:string;checkpoint?:Track;spike?:number;release?:number}
const order:Track[]=['cross-track-synthesis','scaling-law','calorimetry-assay','distributed-consensus','clinical-cohort'];
const names:Record<Track,string>={'scaling-law':'MoERun','calorimetry-assay':'ThermoRun','distributed-consensus':'QuorumRun','clinical-cohort':'CohortRun','cross-track-synthesis':'MethodRun'};
const scaling=[
 'Initial power-law fit: loss L(N)=1.72*N^(-0.31)+0.84, active parameters N in billions. Router entropy H=1.84 nats, batch=256, warmup=200 steps. H1 attributes the fitted exponent to sparse expert capacity; no causal ablation has yet isolated routing.',
 'Matched token-budget sweep: N=1,2,4,8 gives held-out loss 2.56,2.24,2.02,1.88. Each expert sees unequal examples; report exposure-normalized loss rather than assuming equal expert training. Temperature and drift refer to router statistics here, not patient assays.',
 'Replication uses seed 17 and seed 29. Entropy rises from 1.84 to 1.91 nats while dropped tokens increase from 0.2% to 4.1%. A stable held-out mean can conceal selective token loss. Keep the original power-law observation as a historical hypothesis.',
 'Tool trace: scheduler warmup counter increments once per microbatch, but optimizer warmup checks it as full batches. Accumulation=8; nominal 200-step warmup ends after 25 optimizer updates. H1 is confounded by batch-warmup accounting, not disproved solely by throughput.',
 'Negative ablation A29 removes entropy regularization while keeping the faulty scheduler. Delta loss=+0.002 with bootstrap interval [-0.006,+0.010]. This does not isolate routing because the warmup defect is still present. A null result is not equivalence.',
 'Corrected schedule counts optimizer updates: learning rate reaches plateau at update 200. Capacity factor stays 1.25 and the same held-out split is reused. Token-drop accounting must next be repaired before replacing the initial exponent.',
 'Token-drop audit: denominator incorrectly excludes overflowed assignments; apparent utilization 99.8% becomes 95.9% using attempted assignments. Entropy is measured before capacity truncation. No clinical sensitivity interpretation is licensed by this utilization correction.',
 'Controlled factorial design crosses correct warmup with correct drop denominator. Seed, token budget and active parameter definition are fixed; temperature is router softmax temperature 0.8. The two repairs must be distinguished from architectural changes.',
 'Post-fix fit after token-drop repair and correct optimizer warmup: L(N)=1.69*N^(-0.22)+0.85; exponent=0.22, bootstrap interval [0.20,0.24]. H1 exponent 0.31 is superseded for this protocol. The capacity hypothesis remains conditional on exposure matching.',
 'Replicated fit across seeds 17,29,43: exponents 0.21,0.22,0.23. The residual correlation with expert count is not evidence that dormant parameters improve loss. Record active and total parameters separately.',
 'Precision calibration compares BF16 and FP32 accumulation: mean loss shift=0.003, exponent shift below 0.005. This numerical effect cannot restore the original 0.31 estimate. Do not equate loss calibration with assay mass subtraction.',
 'Expert imbalance audit: the busiest expert receives 1.8 times median load, yet the corrected exponent remains inside [0.20,0.24] after stratifying by routing load. Throughput and statistical scaling are different dependent variables.',
 'Hardware throughput ceiling: HBM bandwidth=1.6 TB/s and bytes per routed token=8.0 MB imply a 200000 tokens/s roofline before communication. Measured plateau=184000 tokens/s; this ceiling is not a new loss exponent.',
 'Interconnect experiment holds N fixed while doubling links: throughput improves 11%, held-out loss changes by 0.001. The hardware ceiling can move without changing the corrected scaling relation.',
 'Router temperature sensitivity: 0.6,0.8,1.0 yield entropy 1.71,1.90,2.02 nats. Drop rates differ; matched attempted-token exposure is required for a causal comparison, including the negative entropy ablation.',
 'Extrapolation audit restricts N to [1,8] billion active parameters. A 64-billion forecast is out of support and cannot inherit the measured exponent without validation. Retain uncertainty rather than extending a straight log-log line.',
 'Final independent seed 61 yields exponent 0.221 and utilization 96.0%; throughput is 182700 tokens/s. This supports the repaired local relation, not the pre-bug causal interpretation or unbounded hardware scaling.',
 'Leave-one-scale-out analysis estimates exponents 0.216,0.225,0.219,0.223. Correlated optimizer exposure remains a design limitation. Report both the initial result and why it was superseded.',
 'Assumption review separates loss scaling, entropy regularization and hardware saturation. Conditional model selection favors the repaired exponent only within observed active-parameter and token-budget ranges.',
 'Final notebook closure preserves the original and corrected fits as distinct revisions; no evidence authorizes removing the warmup fix. An external hardware platform would require a new roofline calibration.'
];
const consensus=[
 'Initial safety lemma S1: with n=7 and f=2 Byzantine replicas, quorums of 5 intersect in at least 3 replicas, including at least one honest replica. S1 assumes a single lease epoch per honest voter and monotonic fencing tokens; intersection alone is insufficient.',
 'Model-checker trace: asymmetric partition permits leader A epoch 11 to reach replicas 1,2,3,4,5 and leader B epoch 12 to reach 3,4,5,6,7. Replica 3 resumes a stale lease after its clock resets; two writes receive acknowledgments. The faulty model omits durable fencing.',
 'Patched two-phase lease invariant S2: phase one durably records the highest promised epoch on a quorum of 5; phase two applies writes only with an epoch at least the durable promise and a committed certificate. Reset clocks cannot lower the promise.',
 'Bounded state exploration covers message duplication, delay and reboot; 0 safety violations through depth 18 under durable promises. This is bounded evidence, not an unrestricted theorem. Delay bounds are not assumed for safety.',
 'Liveness boundary: progress is conditional on eventual synchrony, an available quorum of 5, bounded clock drift after stabilization and a fair leader. A permanent 3/4 partition cannot promise progress even though S2 preserves safety.',
 'Negative ablation removes the durable promise write before acknowledgment. Counterexample reappears after reboot at depth 9. Two-phase terminology without persistent fencing does not repair the original safety failure.',
 'Proof obligation: any two certificates intersect in at least one honest replica that never lowers its durable promise. Rejected certificates cannot become writes merely by retrying. The argument depends on n=7,f<=2, quorum=5.',
 'Lease expiration audit: an expired leader may continue sending, but storage rejects its smaller epoch. Wall-clock expiration is advisory for availability; the monotonic fencing invariant is the safety mechanism.',
 'Conditional liveness test injects GST=40s and a 5-replica responsive component. Commits resume within 3 election periods after stabilization. No finite pre-GST completion bound follows from this trace.',
 'State-space extension adds Byzantine equivocation and lost acknowledgments. Duplicate certificates are idempotent by operation identifier. An uncommitted promise does not itself constitute an applied write.',
 'Persistence test power-cycles replica 3 after promise=14 but before commit. Recovery retains promise=14 and rejects epoch 13. The log checksum covers the promise record as well as payload records.',
 'Proof review rejects a proposed quorum reduction to 4: two size-4 sets can intersect in one Byzantine member under n=7,f=2. This rejected proposal must not supersede the quorum=5 requirement.',
 'Scheduler fairness is explicit: a valid certificate can still starve under an adversarial delivery scheduler before eventual synchrony. Safety and liveness conclusions require different assumptions.',
 'Storage model requires atomic persistence of promise before vote acknowledgment. Torn records are detectable by checksum and trigger recovery without voting; silent rollback would violate S2 assumptions.',
 'Certificate replay test accepts duplicate operation IDs once and rejects smaller epochs after leader change. This tests implementation conformance rather than extending the mathematical fault model.',
 'Refined theorem: under n=7,f<=2, honest durable promises, valid quorum certificates and atomic apply fencing, two conflicting operations cannot both commit at one log position. Liveness remains conditional on eventual synchrony.',
 'Ablation review distinguishes Byzantine voter equivocation from honest restart losing durable state. The latter is excluded only by the explicit persistence contract, not by calling the node honest.',
 'Cross-platform clock calibration bounds post-stabilization drift to 20 ppm. This tightens lease duration engineering but is not a premise that rescues the flawed intersection-only S1 argument.',
 'Final theorem audit finds no proof for arbitrary dynamic membership. Membership changes need joint certificates and are outside the fixed n=7 claim. Do not silently generalize the safety statement.',
 'Closure preserves the failed trace and repaired invariant for reproducibility. Conditional liveness does not imply progress during an indefinite partition; sealed clinical labels cannot supply missing protocol evidence.'
];
const clinical=[
 'Prospective cohort enrolls adults age>=40 with baseline biomarker B>=7 ng/mL and eGFR>=60. Exclude steroid use within 30 days, except when BOTH washout>=14 days AND confirmatory mass-spectrometry is negative. The exception is conjunctive, not either/or.',
 'Screening table: Ada age=52 B=8.1 eGFR=72 steroid_days=20 washout=15 confirmatory=negative; Ben age=61 B=9.0 eGFR=71 steroid_days=20 washout=15 confirmatory=positive; Cy age=39 B=8.9 eGFR=90 no steroids. Do not relax age or the conjunction.',
 'Baseline hazard model reports unadjusted hazard ratio=1.42. Smoking and renal function are measured confounders; treatment allocation is observational. A biomarker association is not a randomized treatment effect.',
 'Adjustment for smoking pack-years, eGFR and age changes hazard ratio to 1.18, 95% interval [0.94,1.48]. Missing renal measures require exclusion from the primary analysis, not imputation from the scaling experiment.',
 'Sensitivity audit: internal reference panel has 100 positives, 82 detected and 18 missed; specificity panel has 100 negatives with 94 true negatives. These are assay operating characteristics, not outcomes in the external validation arm.',
 'Loss-to-follow-up audit finds 12% attrition associated with renal function. Inverse-probability weights are truncated at the 99th percentile. The adjusted association remains observational and may retain unmeasured confounding.',
 'Rejected subgroup proposal admits recent steroid users when washout suffices OR confirmatory is negative. Protocol board rejects the disjunction; original BOTH criterion remains binding even if sample size falls.',
 'Batch-specific recalibration plan uses archived blinded internal controls only. Plates from lots A and B have different sensitivity; pooling before correction could mimic longitudinal biological drift.',
 'Recalibration reference: old sensitivity 0.82 is superseded by lot-specific sensitivity 0.91 after control-standard correction; specificity remains 0.94. This repairs detection bias, not smoking confounding or treatment selection.',
 'Paired internal specimens show corrected biomarker slope +0.03 ng/mL/month versus pre-correction +0.11. The old slope is not a valid progression estimate after the lot effect is identified.',
 'External validation arm exists but its outcomes and labels remain sealed. No accuracy, AUROC, subgroup benefit or external hazard ratio is known. Internal sensitivity cannot substitute for unavailable external outcomes.',
 'Control-standard numerical calibration uses duplicate standards and excludes no participant based on observed outcome. The internal sensitivity revision must not be interpreted as unblinding external labels.',
 'Post-correction internal adjusted hazard ratio=1.09 with interval [0.87,1.36]. This does not prove equivalence or absence of clinical effect. Report residual uncertainty and predeclared covariates.',
 'Candidate Dia age=67 B=7.2 eGFR=61 recent steroid use washout=16 confirmatory=unknown. The conjunction cannot be established; enrollment waits for a negative confirmation rather than treating unknown as negative.',
 'Negative-control analyte is stable after lot correction. This supports an assay artifact explanation for part of the prior slope, without proving that all longitudinal change is nonbiological.',
 'Transportability audit: external arm differs in renal disease prevalence and remains blinded. Demographic resemblance alone cannot identify discrimination or causal benefit in that arm.',
 'Protocol review retains age, baseline biomarker and renal thresholds plus the steroid conjunction. A post-hoc subgroup maximizing significance is rejected; it cannot overwrite predeclared eligibility.',
 'Missingness sensitivity varies weights and reports interval [0.85,1.41]. Results do not cross a predeclared evidential threshold for treatment recommendations. The sealed external labels remain unavailable.',
 'Final internal report preserves the 0.82 to 0.91 sensitivity revision and adjusted estimates separately. No document authorizes an external performance claim or relaxing the conjunctive exception.',
 'Closure audit confirms the external outcome key is still sealed. Return unknown for external AUROC and validation benefit; do not borrow numerical evidence from another track with overlapping calibration vocabulary.'
];
const methodology=[
 'Preregistered meta-method: track statistical loss, thermodynamic ledger drift, lease safety and biomarker detection as separate estimands. Shared words entropy, calibration, quorum, drift and sensitivity do not imply shared units or transferable numerical constants.',
 'Causal graph design distinguishes batch exposure from router architecture and assay lot from biological progression. Conditioning on a measured mediator can bias either analysis; preserve the exact intervention and endpoint for each experiment.',
 'Evidence policy retains original observations when a later hypothesis is revised. A previous assistant synthesis is not an authoritative measurement. Compare superseded estimates with corrected ones without erasing their causal history.',
 'Negative-result protocol requires confidence intervals and controlled perturbations. A null entropy ablation, a failed quorum reduction and a rejected clinical subgroup rule are different sorts of negative evidence.',
 'Unit audit treats nats, grams, joules, epochs and ng/mL as incompatible. Numerical similarity cannot establish equivalence; micro-calorimeter drift must use cumulative meter subtraction, not summation of already cumulative readings.',
 'Robustness proposal distinguishes outlier removal from calibration correction. Removing measurements because they weaken a hypothesis changes the estimand; retain a rejected proposal in the decision history without executing it.',
 'Cross-track causal review contrasts warmup accounting with assay detection recalibration. Both are measurement or exposure confounders, but neither licenses importing a loss exponent into a hazard model.',
 'Temporal provenance design records observation time separately from revision time. A later calibration can supersede an earlier constant without changing the exact raw mass observations or the original counterexample trace.',
 'Mid-horizon methods review requires one original failed hypothesis, its diagnostic trace and a corrected protocol from each relevant track. Retrieval of a conclusion alone is insufficient for causal reconstruction.',
 'Precision audit requires arbitrary-precision decimal arithmetic for the untared balance; IEEE-754 rounding is not a scientific tolerance. Clinical intervals and router confidence intervals remain statistical, not exact arithmetic.',
 'Reference-resolution audit distinguishes that calibration in the heat assay from that sensitivity correction in the cohort. When referents are ambiguous, name the competing records rather than silently merging the threads.',
 'Numerical calibration memo contrasts BF16 accumulation error with wet-lab calibration and clock drift. Small numerical corrections cannot establish theorem assumptions or reveal sealed validation labels.',
 'Dependency review asks whether a conclusion survives removal of one original premise. Quorum intersection without persistence fails; an exposure-controlled scaling fit without the token-drop audit remains uncertain.',
 'Scientific abstention rule separates unavailable evidence from negative evidence. Sealed outcomes are unknown; a rejected filter is not an applied analysis; absence of a counterexample at finite depth is not a universal proof.',
 'Hardware and algorithm review separates throughput ceilings from sample-efficiency exponents. A bandwidth bound may constrain experimentation without invalidating the repaired local loss fit.',
 'Long-range synthesis protocol requires explicit ancestry of hypotheses, ablations, calibrations and theorem assumptions. Count elapsed turns from original measurements, not from their most recent paraphrase.',
 'Transport audit compares finite-range model extrapolation, fixed-membership consensus and external cohort transport. Each has a different boundary of support and must state conditional assumptions.',
 'Counterfactual audit asks which earlier conclusions would reverse if warmup, fencing persistence or assay lot correction were omitted. The heat ledger is an invariant control and cannot be changed by narrative synthesis.',
 'Pre-final review requires original numerical observations and negative decisions to accompany each synthesis. Reject attractive cross-thread analogies that change units, fault bounds or outcome availability.',
 'Unified closure keeps separate statistical, exact-arithmetic, formal and unavailable-evidence claims. Causal similarity between corrections is an analogy to test, not a proof of equivalence among the four research tracks.'
];
// Align the repaired fit and hardware calibration with the preregistered milestones.
[scaling[8],scaling[9]]=[scaling[9],scaling[8]];
[scaling[12],scaling[14]]=[scaling[14],scaling[12]];
const fixed=(n:bigint)=>{const s=n.toString().padStart(19,'0');return s.slice(0,-18)+'.'+s.slice(-18);};
function heat(index:number):string {
 const i=BigInt(index),tare=1000000000000000000000000000001n;
 const reagent=(i+1n)*10000000000000001n,solvent=(i+1n)*20000000000000003n;
 const cumulative=120000000000000000000n+i*123456789012345679n;
 const episodes=['Initial gain constant k=4.200000 J/unit; provisional until reference standard is checked.',
 'Reference standard indicates gain k=4.184000 J/unit replaces k=4.200000; raw readings are not overwritten.',
 'Proposal F9 discards the largest heat reading as an outlier; board rejects F9 because the value repeats under blinded duplication. Retain every ledger observation.',
 'Empty vessel and final readings are untared cumulative balances; compute each addition by subtraction, not by interpreting the vessel-inclusive total as a reagent mass.'];
 return `Untared micro-calorimeter ledger observation ${index+1}: the empty vessel read ${fixed(tare)} g; after reagent it read ${fixed(tare+reagent)} g; after solvent it read ${fixed(tare+reagent+solvent)} g. The cumulative enthalpy meter read ${fixed(cumulative)} J. This is a meter total, not the heat added in this step. ${episodes[Math.min(index,3)]} Independent titration used 0.010000 mol/L titrant and ${(10+index*0.25).toFixed(2)} mL; stoichiometry is 1:1 and blank=0.50 mL. Report mass additions separately from titration equivalents and do not round away the decimal tail.`;
}
export function observations():Observation[] {
 const schedule=Array.from({length:100},(_,i)=>order[i%5]);
 for(const [a,b] of [[17,19],[71,72],[58,60]])[schedule[a-1],schedule[b-1]]=[schedule[b-1],schedule[a-1]];
 const counts=Object.fromEntries(TRACKS.map(t=>[t,0])) as Record<Track,number>;
 return schedule.map((track,i)=>{const index=counts[track]++,turn=i+1,anchor=names[track]+String(turn).padStart(3,'0');
 const body=track==='scaling-law'?scaling[index]:track==='calorimetry-assay'?heat(index):track==='distributed-consensus'?consensus[index]:track==='clinical-cohort'?clinical[index]:methodology[index];
 return {turn,track,anchor,text:`Research notebook ${anchor}, Turn ${turn}, ${track}. ${body} Replication note: preserve raw observations and revision scope; shared calibration, entropy, sensitivity, drift and quorum terminology in adjacent projects is not authority for this project.`,...([9,19].includes(turn)?{protocol:true}:{})};});
}
export const seeds:Observation[]=TRACKS.map((track,i)=>({turn:0,track,anchor:names[track]+'Baseline',text:`Research notebook ${names[track]}Baseline, baseline before Turn 1. ${[
 'Sparse expert study preregisters active parameter count, attempted-token exposure and held-out loss separately from throughput; all fits require matched optimizer exposure.',
 'Heat assay starts from a cumulative meter of 120.000000000000000000 J; tare and decimal mass readings must be preserved exactly, and calibration changes cannot rewrite raw observations.',
 'Fixed membership protocol assumes n=7 and f<=2; durable epochs and quorum certificates require explicit safety arguments independent of eventual network synchrony.',
 'Cohort registration predeclares adult thresholds and a conjunction for steroid exceptions; the external validation outcome key is sealed and unavailable.',
 'One persistent researcher thread will compare four scientific estimands without equating their units; claims must cite original observations and preserve unknown outcomes.'
 ][i]}`}));
// Query-side notebook references are normal research requests, NOT source IDs.
const checkpoints:[number,Track,number[]][]=[
 [45,'clinical-cohort',[5,10,15,20,25,35,40]],
 [47,'scaling-law',[2,19,27,32,42]],
 [49,'distributed-consensus',[4,9,14,24,29,34,44]],
 [51,'cross-track-synthesis',[2,19,47,3,8,13,4,9,14,5,20,40]],
 [53,'calorimetry-assay',[3,8,13,18,23,28,33,38,43]],
 [92,'scaling-law',[2,19,27,32,47,57,71,87]],
 [94,'distributed-consensus',[4,9,14,24,29,34,54,64,79,89]],
 [96,'cross-track-synthesis',[2,19,27,47,71,3,8,13,93,4,9,14,79,94,5,20,40,55,95,15]],
 [98,'calorimetry-assay',[3,8,13,18,23,28,33,38,43,48,53,60,63,68,73,78,83,88,93]],
 [100,'clinical-cohort',[5,10,20,35,40,50,55,58,65,90,95]]
];
const tasks:Record<Track,string>={
 'scaling-law':'Compare the initial power-law hypothesis with the warmup trace, negative entropy ablation, token-drop correction and hardware roofline where available. Which causal claims survive exposure matching, and why is throughput not a loss exponent?',
 'calorimetry-assay':'Calculate exact decimal reagent and solvent net masses from the untared readings, reconstruct cumulative enthalpy drift by endpoint subtraction, and distinguish the superseded gain constant from the rejected filtering proposal. Which titration and heat quantities have compatible units?',
 'distributed-consensus':'Explain how the original intersection lemma, asymmetric-partition counterexample and durable two-phase fencing invariant constrain safety. Which assumptions are necessary, and why does conditional liveness not promise progress under permanent partition?',
 'clinical-cohort':'Analyze eligibility using the conjunctive exception, confounder adjustment and internal sensitivity recalibration. Contrast corrected internal estimates with the sealed external arm: which quantities must remain unknown and why can internal calibration not validate external outcomes?',
 'cross-track-synthesis':'Synthesize causal ancestry across router scaling, heat ledger, fenced consensus and biomarker cohort. Contrast the warmup and assay recalibration confounders, preserve exact numeric invariants and theorem assumptions, and explain which conclusions are revised, rejected, conditional or unknown.'
};
export function scenario(turns=100,pressureSpikes=3):ResearchTurn[] {
 if(![50,100].includes(turns)||!Number.isInteger(pressureSpikes)||pressureSpikes<0||pressureSpikes>5)throw new Error('Invalid scenario');
 // The scaled variant keeps the first 40 turns and ten paired late samples.
 // Remap references to retained earlier observations, preserving five tracks.
 const original=observations(), selected=turns===100?original:original.filter(r=>r.turn<=40||r.turn>=91);
 const retained=new Map(selected.map((r,i)=>[r.turn,i+1]));
 const mapped=selected.map((r,i)=>({...r,turn:i+1,text:r.text+ (turns===50?` Scaled session turn ${i+1}; notebook labels retain full-study numbering.`:'')}));
 const cp50:[number,Track,number[]][]=[[31,'cross-track-synthesis',[2,19,47,3,8,13,4,9,14,5,20,40]],[33,'calorimetry-assay',[3,8,13,18,23,28,33,38,43]],[35,'clinical-cohort',[5,10,15,20,25,35,40]],[37,'scaling-law',[2,19,27,32,42]],[39,'distributed-consensus',[4,9,14,24,29,34,44]]];
 const cp=turns===100?checkpoints:[...cp50.map(([t,track,refs])=>[t,track,refs.filter(n=>n<t)] as [number,Track,number[]]),...checkpoints.slice(5).map(([n,track,refs])=>[retained.get(n)!,track,refs.filter(r=>retained.has(r)&&retained.get(r)!<retained.get(n)!)] as [number,Track,number[]])];
 const spikeAt=Array.from({length:pressureSpikes},(_,i)=>{let n=Math.floor((i+1)*turns*0.70/(pressureSpikes+1))+2;while(cp.some(c=>c[0]===n))n--;return n;});
 return mapped.map((r,i)=>{
 const checkpoint=cp.find(c=>c[0]===r.turn),focus=checkpoint?.[1]??r.track;
 const previous=selected.slice(0,i).filter(p=>p.track===r.track).at(-1);
 const refs=checkpoint?checkpoint[2].map(n=>original[n-1]):[previous,...[10,30,60,85].filter(lag=>r.turn>lag).map(lag=>selected[i-lag])].filter(Boolean) as Observation[];
 const anchors=[...new Set(refs.map(p=>p.anchor))];if(!anchors.length)anchors.push(names[r.track]+'Baseline');
 const query=`Analyze ${r.anchor} in the ${r.track} research thread. Retrieve and compare original notebook records ${anchors.join(', ')}${previous&&!checkpoint?`, including the previous ${previous.anchor} finding`:''}. ${tasks[focus]} Test the causal explanation against those earlier observations rather than repeating the latest conclusion. State unresolved assumptions, numerical units and original span references; do not treat an assistant paraphrase as primary evidence.`;
 const spike=spikeAt.indexOf(r.turn),release=spikeAt.indexOf(r.turn-1);
 return {...r,query,...(checkpoint?{checkpoint:focus}:{}),...(spike>=0?{spike}:{}),...(release>=0?{release}:{})};
 });
}
export function pressureDocuments(tokens:number,spike:number):string[] {
 const bytes=Math.ceil(tokens*3.6),size=Math.ceil(bytes/12);
 return Array.from({length:12},(_,i)=>{const prefix=`BULK_LITERATURE_${spike}_${i}\n`;const line=`archive=${i} spectral wavelength=780nm diffraction fringe=stable detector pixel=142 integration=17ms checksum=verified astronomical catalog batch; `;return prefix+line.repeat(Math.ceil(size/line.length)).slice(0,size-prefix.length);});
}
