import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ContextForgeStore, canonicalJson, stableId } from '../src/store.ts';
import { ContextForgeCompiler } from '../src/compiler.ts';
import { analyzeRecallQuery } from '../src/retrieval.ts';
import { triangulateMultiClueGraph } from '../src/evidence.ts';
import { resolveCapabilityEnvelope, resolveHistoryCapacity, resolvePromptAndToolProfile, classifyQueryDemand, groupVerbatimTail, planContext, executeTrancheStream } from '../src/planner.ts';
import type { EnvelopeMetadata, PlanContextInput } from '../src/planner.ts';

function fixture(){const dir=mkdtempSync(join(tmpdir(),'cf-planner-'));const store=new ContextForgeStore(join(dir,'store.sqlite'));return {store,clean(){store.close();rmSync(dir,{recursive:true,force:true});}};}
function envelope(window=64000,override:EnvelopeMetadata={}) {return resolveCapabilityEnvelope({model:{id:'opaque-random-identifier',provider:'arbitrary-route',contextWindow:window,input:['text'],maxOutputTokens:2000},runtime:{n_ctx:window,tokenBudget:window,hostBudgetScope:'history_only'},modelFingerprint:'revision-tokenizer-template-adapter-v1',systemTokens:900,toolSchemaTokens:100,pendingInputTokens:40,framingTokens:20,safetyMarginTokens:100,...override});}
function request(store:ContextForgeStore,extra:Partial<PlanContextInput>={}):PlanContextInput {return {store,sessionId:'session',admissionId:'a',query:'hello',rawSystemPrompt:'# Persona\nBe warm and exact.',envelope:envelope(),...extra};}
function totals(plan:ReturnType<typeof planContext>){const t=plan.receipt.tokens;assert.equal(t.serializedInputTokens,t.systemPolicy+t.toolSchemas+Object.values(t.historicalTextByLayer).reduce((a,b)=>a+b,0)+t.historicalMedia+t.pendingText+t.pendingMedia+t.protocolFraming);assert.equal(t.selectedHistory,plan.receipt.selections.reduce((n,s)=>n+s.costs.text+s.costs.media,0)+t.protocolFraming-plan.receipt.capabilityEnvelope.framingTokens);assert.ok(t.selectedHistory<=t.admissibleHistory);}

test('model-agnostic metadata, exact physical/host reservation accounting and fail-closed semantics',()=>{
  const e=envelope(100000,{deploymentContextTokens:80000,hostTokenBudget:50000,hostBudgetScope:'total_input',outputReserveTokens:4000,reasoningReserveTokens:1000,systemTokens:2000,toolSchemaTokens:3000,framingTokens:100,pendingInputTokens:500,safetyMarginTokens:400,providerMaxInputTokens:70000});
  assert.equal(e.modelId,'opaque-random-identifier');assert.deepEqual(e.input,['text']);
  assert.deepEqual(resolveHistoryCapacity(e),{W:80000,Rphysical:64000,Rhost:39000,H:39000});
  const history=envelope(100000,{...e,hostBudgetScope:'history_only',reservationAccounting:undefined});assert.equal(resolveHistoryCapacity(history).H,50000);
  const mixed=envelope(100000,{...e,reservationAccounting:[{component:'output',alreadyExcludedFromHostBudget:true},{component:'pending',alreadyExcludedFromHostBudget:true}]});assert.equal(resolveHistoryCapacity(mixed).H,43500);
  assert.throws(()=>resolveCapabilityEnvelope({hostTokenBudget:1,hostBudgetScope:'history_only',input:['text']}),/nativeContextTokens/);
  assert.throws(()=>resolveCapabilityEnvelope({nativeContextTokens:100,hostTokenBudget:1,input:['text']}),/BudgetSemanticsUnknown/);
  assert.throws(()=>envelope(64000,{hostTokenBudget:NaN}),/Invalid/);
  assert.throws(()=>envelope(64000,{input:['bogus'] as any}),/Invalid/);
});

test('proportional slim-domain activation, natural persona, complete rules, authorized tool narrowing and prose toggle',()=>{
  const raw='<!-- openclaw:attempt:STABLE -->\n# Persona\nA warm and thoughtful companion.\n# Workspace Directives\nAlways preserve private source data.\nNever reveal a password.\n# Special policy\nAlways keep the signed contract.\n<!-- /openclaw:attempt:STABLE -->';
  const tools=[{name:'tool_call'},{name:'tool_search'},{name:'memory_search',required:true},{name:'read',capabilities:['documents']},{name:'video',capabilities:['multimodal']}];
  for(const W of [32000,64000]){
    const p=resolvePromptAndToolProfile(envelope(W,{systemTokens:22000}),{rawSystemPrompt:raw,tools,taskCapabilities:['documents']});
    assert.equal(p.promptMode,'slim-domain');assert.equal(p.symbolicMode,'dual-channel-symbolic');assert.match(p.systemPrompt,/<compiled_rules_ir>/);assert.match(p.systemPrompt,/A warm and thoughtful companion\./);assert.match(p.systemPrompt,/signed contract/);assert.deepEqual(p.effectiveTools,['memory_search','read','tool_call','tool_search']);
    const prose=resolvePromptAndToolProfile(envelope(W,{systemTokens:22000}),{rawSystemPrompt:raw,symbolicIr:false});assert.equal(prose.systemPrompt,raw);assert.equal(prose.symbolicMode,'prose-passthrough');
  }
  const hybrid=resolvePromptAndToolProfile(envelope(922000,{systemTokens:22000}),{rawSystemPrompt:raw,tools});assert.equal(hybrid.promptMode,'hybrid-stable');assert.equal(hybrid.systemPrompt,raw);assert.equal(hybrid.effectiveTools.length,5);
  assert.equal(resolvePromptAndToolProfile(envelope(922000),{rawSystemPrompt:raw,promptMode:'slim-domain'}).promptMode,'slim-domain');
});

test('demand is current-turn driven, including empty image-only input',()=>{
  assert.equal(classifyQueryDemand('Thanks!').primary,'conversational');assert.equal(classifyQueryDemand('Compare these alternatives').primary,'analytical');assert.equal(classifyQueryDemand('Synthesize all documents with citations').primary,'heavy_rag');assert.equal(classifyQueryDemand('',[{modality:'image'}]).primary,'multimodal_inspection');
});

test('routine conversation remains 1.5k–3.5k on 64k and 922k windows, with durable receipt and stable epoch',()=>{
  const f=fixture();try{
    f.store.commitTurn({sessionId:'session',advancementKey:'turn',messages:[{role:'user',content:'Conversation detail. '.repeat(75)},{role:'assistant',content:'Relevant response. '.repeat(75)}]});
    for(const W of [64000,922000]){
      const a=planContext(request(f.store,{admissionId:'first'+W,envelope:envelope(W)}));
      const b=planContext(request(f.store,{admissionId:'second'+W,query:'Thanks!',envelope:envelope(W)}));
      for(const p of [a,b]){totals(p);assert.ok(p.receipt.tokens.serializedInputTokens>=1500);assert.ok(p.receipt.tokens.serializedInputTokens<=3500);}
      assert.equal(a.epoch.prefixSha256,b.epoch.prefixSha256);assert.equal(a.epoch.epochId,b.epoch.epochId);assert.equal(b.receipt.cache.measurement,'unknown');assert.equal(b.receipt.cache.providerCachedTokens,undefined);
      const row=f.store.db.prepare('SELECT receipt_json FROM planner_receipts WHERE receipt_id=?').get(a.receipt.receiptId)!;assert.deepEqual(JSON.parse(String(row.receipt_json)),a.receipt);
      assert.equal(a.receipt.receiptSha256,stableId('cf-plan-receipt-v1',{...a.receipt,receiptSha256:''}));
    }
  }finally{f.clean();}
});

test('heavy RAG expands through the tranche ladder beyond 100k and releases documents on the next greeting',()=>{
  const f=fixture();try{
    const ids=[];for(let i=0;i<12;i++)ids.push(f.store.ingestSource({originKey:`report-${i}.txt`,text:`Report ${i}: `+'Detailed evidence concerning revenue, causes and forecasts. '.repeat(800)}).sourceId);
    const heavy=planContext(request(f.store,{sourceIds:ids,envelope:envelope(922000),query:'Exhaustively synthesize all documents and cite every source'}));
    totals(heavy);assert.ok(heavy.estimatedTokens>100000);assert.ok(heavy.receipt.stages.some(s=>s.tranche>0));assert.deepEqual([...new Set(heavy.receipt.stages.map(s=>s.fraction))],[0.25,0.5,0.75,1]);assert.equal(heavy.receipt.demand.obligations.filter(o=>o.status==='satisfied').length,12);assert.equal(heavy.receipt.disposition,'admitted');assert.deepEqual(new Set(heavy.receipt.selections.map(s=>s.sourceId)),new Set(ids));
    const small=planContext(request(f.store,{envelope:envelope(922000),admissionId:'next',query:'Thanks!'}));assert.ok(small.receipt.tokens.serializedInputTokens<3500);assert.equal(small.receipt.selections.length,0);assert.equal(small.epoch.prefixSha256,heavy.epoch.prefixSha256);
    const constrained=planContext(request(f.store,{envelope:envelope(64000),admissionId:'constrained',sourceIds:ids,query:'Synthesize all documents'}));totals(constrained);assert.ok(['physical_limit','corpus_exhausted','sufficient_evidence'].includes(constrained.receipt.stopReason));assert.equal(constrained.receipt.disposition,'partial');assert.ok(constrained.receipt.demand.obligations.filter(o=>o.status==='satisfied').length<12);
  }finally{f.clean();}
});

test('native image hydration uses adapter media charges, while text-only models receive caption/OCR fallback',()=>{
  const f=fixture();try{
    const source=f.store.ingestSource({originKey:'figure',kind:'media',mimeType:'image/png',bytes:Buffer.from('fake-image-fixture')});
    f.store.addArtifact({sourceId:source.sourceId,kind:'caption',text:'Caption: a red trend line rises from 4 to 9.'});
    const attachment={sourceId:source.sourceId,modality:'image' as const};
    const native=planContext(request(f.store,{query:'Inspect the chart',attachments:[attachment],envelope:envelope(64000,{input:['text','image']}),mediaAdapter:{version:'fixture-adapter',estimate:()=>({tokens:765,estimateKind:'provider'})}}));
    assert.ok(native.messages.some(m=>Array.isArray(m.content)&&m.content.some(b=>typeof b==='object'&&b!==null&&!Array.isArray(b)&&b.type==='image')));assert.equal(native.receipt.media[0].hydration,'native');assert.equal(native.receipt.tokens.historicalMedia,765);totals(native);
    const fallback=planContext(request(f.store,{admissionId:'text',query:'Inspect the chart',attachments:[attachment],envelope:envelope(64000)}));assert.match(canonicalJson(fallback.messages),/red trend line/);assert.doesNotMatch(canonicalJson(fallback.messages),/"type":"image"/);assert.equal(fallback.receipt.media[0].hydration,'text_fallback');assert.equal(fallback.receipt.demand.obligations.find(o=>o.kind==='modality')!.status,'partial');totals(fallback);
  }finally{f.clean();}
});

test('tool call/result closure crosses groups, supports multiple calls, and drops incomplete protocols',()=>{
  const call={id:'call-message',role:'assistant' as const,content:[{type:'toolCall',id:'a',name:'read'},{type:'toolCall',id:'b',name:'read'}],protocolGroupId:'before'};
  const resultA={id:'result-a',role:'tool' as const,toolCallId:'a',content:'A',protocolGroupId:'after-a'};
  const resultB={id:'result-b',role:'tool' as const,toolCallId:'b',content:'B',protocolGroupId:'after-b'};
  assert.equal(groupVerbatimTail([call,resultA,resultB]).length,1);assert.equal(groupVerbatimTail([call,resultA]).length,0);assert.equal(groupVerbatimTail([resultA]).length,0);
  const f=fixture();try{
    f.store.commitTurn({sessionId:'session',advancementKey:'1',messages:[call]});f.store.commitTurn({sessionId:'session',advancementKey:'2',messages:[resultA,resultB]});
    const p=planContext(request(f.store));assert.deepEqual(p.messages.map(m=>m.id),['call-message','result-a','result-b']);assert.equal(new Set(p.receipt.selections.map(i=>i.bundleId)).size,1);
    const overflow=planContext(request(f.store,{admissionId:'tiny',envelope:envelope(64000,{hostTokenBudget:1})}));assert.equal(overflow.receipt.stopReason,'mandatory_overflow');assert.equal(overflow.messages.length,0);
  }finally{f.clean();}
});

test('epoch rolls on policy/model changes, not unrelated writes; revoked evidence cannot reappear',()=>{
  const f=fixture();try{
    f.store.setPermanentContext('policy','Never share confidential data',{ownerApproved:true});
    const a=planContext(request(f.store));const source=f.store.ingestSource({originKey:'irrelevant',text:'Unrelated document'});new ContextForgeCompiler(f.store).compile();
    const b=planContext(request(f.store,{admissionId:'b'}));assert.equal(a.epoch.epochId,b.epoch.epochId);
    f.store.setPermanentContext('policy','Never share confidential data or passwords',{ownerApproved:true});
    const c=planContext(request(f.store,{admissionId:'c'}));assert.notEqual(c.epoch.epochId,b.epoch.epochId);
    const d=planContext(request(f.store,{admissionId:'d',envelope:envelope(64000,{modelFingerprint:'new-template'})}));assert.notEqual(c.epoch.epochId,d.epoch.epochId);
    f.store.withdrawSource(source.sourceId);const p=planContext(request(f.store,{admissionId:'withdrawn',query:'Read this document',sourceIds:[source.sourceId]}));assert.ok(!p.receipt.selections.some(s=>s.sourceId===source.sourceId));assert.equal(p.receipt.disposition,'partial');
    assert.throws(()=>planContext(request(f.store,{admissionId:'d'})),/AdmissionAlreadyPlanned/);
  }finally{f.clean();}
});

test('transport, cancellation, ACL and mandatory fixed overflow fail explicitly',()=>{
  const f=fixture();try{
    const document=f.store.ingestSource({originKey:'doc',text:'A long document '.repeat(300)});
    const abort=new AbortController();abort.abort();const cancelled=planContext(request(f.store,{query:'all documents',abortSignal:abort.signal}));assert.equal(cancelled.receipt.disposition,'cancelled');
    const bytes=planContext(request(f.store,{admissionId:'bytes',sourceIds:[document.sourceId],query:'all documents',envelope:envelope(64000,{maxRequestBytes:500})}));assert.equal(bytes.receipt.stopReason,'transport_limit');
    const fixed=planContext(request(f.store,{admissionId:'fixed',symbolicIr:false,envelope:envelope(1000,{systemTokens:2000})}));assert.equal(fixed.receipt.stopReason,'mandatory_overflow');assert.equal(fixed.receipt.disposition,'blocked');
    assert.throws(()=>planContext(request(f.store,{namespaceId:'denied',admissionId:'denied'})),/access denied/);
  }finally{f.clean();}
});

test('near-million window has no 100k ceiling: 780k+ evidence, complete coverage and bounded stages',()=>{
  const f=fixture();try{
    const ids=[];for(let i=0;i<40;i++)ids.push(f.store.ingestSource({originKey:`large-${i}`,text:`Document ${i}:\n`+'Evidence record. '.repeat(4450)}).sourceId);
    const p=planContext(request(f.store,{sourceIds:ids,envelope:envelope(922000),query:'Exhaustively review all documents'}));
    totals(p);assert.ok(p.estimatedTokens>780000);assert.ok(p.estimatedTokens<920000);assert.equal(p.receipt.demand.obligations.filter(o=>o.status==='satisfied').length,40);assert.equal(p.receipt.disposition,'admitted');assert.ok(p.receipt.stages.length<40);
  }finally{f.clean();}
});

test('audio/video/document capabilities use the same hydration path',()=>{
  const f=fixture();try{
    for(const [mime,modality] of [['audio/wav','audio'],['video/mp4','video'],['application/pdf','document']] as const){
      const source=f.store.ingestSource({originKey:mime,kind:'media',mimeType:mime,bytes:Buffer.from('fixture')});
      f.store.addArtifact({sourceId:source.sourceId,kind:modality==='document'?'ocr':'transcript',text:'Extracted text fallback.'});
      const p=planContext(request(f.store,{admissionId:mime,query:'Inspect this attachment',attachments:[{sourceId:source.sourceId,modality}],envelope:envelope(64000,{input:['text','audio','video'],nativeDocumentMimeTypes:['application/pdf']}),mediaAdapter:{version:'fixture',estimate:()=>({tokens:1100,estimateKind:'provider'})}}));
      totals(p);assert.equal(p.receipt.media[0].deliveredModality,modality);assert.equal(p.receipt.media[0].hydration,'native');assert.equal(p.receipt.tokens.historicalMedia,1100);
    }
  }finally{f.clean();}
});

test('executeTrancheStream folds a 12-document repo exceeding a 16K window across multiple bounded tranches with stable prefix reuse, L2 symbol resolution, and final verbatim hydration',async()=>{
  const f=fixture();try{
    const ids:string[]=[];
    for(let i=0;i<12;i++){
      const text=`Module file-${i}.ts:\n`+(i===3?'export function criticalBugTarget() { return validateCrossFileContract(42); }\n':i===9?'export function validateCrossFileContract(x: number) { return x === 42; }\n':'')+'// Repository implementation detail padding line for module.\n'.repeat(240);
      ids.push(f.store.ingestSource({originKey:`repo/file-${i}.ts`,kind:'document',role:'user',text}).sourceId);
    }
    const helperSource=f.store.ingestSource({originKey:'repo/UnqueuedHelper.ts',kind:'document',role:'user',text:'export function UnqueuedHelperSymbol() { return "resolved-via-L2-entity-graph"; }\n'});
    new ContextForgeCompiler(f.store).compile();

    // Single-pass on a 16K window with 8K tranche budget can only fit a subset of the 12 files (~4,000 tokens each -> ~2-3 files per pass).
    const stream=await executeTrancheStream(
      request(f.store,{
        admissionId:'repo-fold',
        query:'Trace criticalBugTarget and validateCrossFileContract across the repository modules',
        sourceIds:ids,
        trancheTokenBudget:10000,
        envelope:envelope(16000,{hostTokenBudget:16000,hostBudgetScope:'total_input'}),
      }),
      (passPlan, passIndex) => {
        const keepSpans = passPlan.receipt.selections
          .filter(s => [ids[3], ids[9], helperSource.sourceId].includes(s.sourceId))
          .flatMap(s => s.provenanceSpanIds);
        return {
          keepSpanIds: [...keepSpans, 'deadbeef'.repeat(8)], // bogus span must be rejected
          unresolvedSymbols: passIndex === 0 ? ['UnqueuedHelperSymbol'] : [],
        };
      },
    );

    assert.ok(stream.passes.length >= 2, '12 files must stream across multiple bounded tranches');
    assert.equal(stream.allRequestedSourcesCovered, true, 'All 12 requested repo files must be visited across passes');
    assert.ok(stream.totalUniqueSourcesAdmitted.includes(helperSource.sourceId), 'Unresolved symbol must be resolved via L2 entity graph into subsequent tranche');
    // Every intermediate pass must respect the 10,000-token tranche budget and share the exact same stable prefix SHA-256 (Slot 0 KV-cache reuse).
    const prefixHashes = new Set(stream.passes.map(p => p.plan.epoch.prefixSha256));
    assert.equal(prefixHashes.size, 1, 'All tranche passes must share identical Slot 0 prefixSha256 for 100% KV-cache reuse');
    for (const p of stream.passes) {
      assert.ok(p.plan.receipt.tokens.serializedInputTokens <= 10000, `Pass ${p.passIndex} exceeded trancheTokenBudget: ${p.plan.receipt.tokens.serializedInputTokens}`);
    }
    // Bogus span ID was rejected; only the 3 critical files were hydrated verbatim into finalPlan.
    assert.ok(!stream.verifiedSpanIds.includes('deadbeef'.repeat(8)));
    const finalSources = new Set(stream.finalPlan.receipt.selections.filter(s => s.role === 'quoted_evidence').map(s => s.sourceId));
    assert.deepEqual(finalSources, new Set([ids[3], ids[9], helperSource.sourceId]));
    const finalWire = canonicalJson(stream.finalPlan.messages);
    assert.match(finalWire, /criticalBugTarget/);
    assert.match(finalWire, /validateCrossFileContract/);
    assert.match(finalWire, /resolved-via-L2-entity-graph/);
    assert.ok(stream.finalPlan.receipt.tokens.serializedInputTokens < 10000, 'Final synthesis prompt is compact (~9.5k tokens vs ~50k full repo) and contains only surviving verbatim spans');
  }finally{f.clean();}
});

test('8-char Git-style short span IDs, 3-hop multi-clue triangulation, and court-case temporal state flip-flop ledger (A -> B -> A -> C)', () => {
  const f = fixture();
  try {
    // 1. Short span IDs on the wire + prefix resolution in readEvidenceSpan
    const doc1 = f.store.ingestSource({
      originKey: 'docket/order-1-tro.txt',
      kind: 'document',
      role: 'user',
      observedAt: 10,
      text: 'State: InjunctionCountOne | status = GRANTED_TRO_INITIAL',
    });
    const doc2 = f.store.ingestSource({
      originKey: 'docket/order-2-stay.txt',
      kind: 'document',
      role: 'user',
      observedAt: 20,
      text: 'Correction: InjunctionCountOne | status = STAYED_BY_PANEL',
    });
    const doc3 = f.store.ingestSource({
      originKey: 'docket/order-3-reinstated.txt',
      kind: 'document',
      role: 'user',
      observedAt: 30,
      text: 'Correction: InjunctionCountOne | status = GRANTED_TRO_REINSTATED_WITH_BOND',
    });
    const doc4 = f.store.ingestSource({
      originKey: 'docket/order-4-modified.txt',
      kind: 'document',
      role: 'user',
      observedAt: 40,
      text: 'Correction: InjunctionCountOne | status = DISSOLVED_FINAL',
    });
    new ContextForgeCompiler(f.store).compile();

    const chunk1 = f.store.getEvidenceChunks(doc1.sourceId)[0];
    const shortId = f.store.formatShortSpanId(chunk1.spanId);
    assert.equal(shortId.length, 8, 'Default short span ID should be 8 hex chars');
    const resolved = f.store.readEvidenceSpan(shortId, { allowSupersededSource: true });
    assert.equal(resolved.spanId, chunk1.spanId, 'readEvidenceSpan must resolve 8-char prefix back to exact 64-char SHA-256 spanId');

    // 2. Court-case / temporal flip-flop (`A -> B -> A -> C`) chronological state ledger
    const courtPlan = planContext(
      request(f.store, {
        query: 'Trace the court order history and chronological changes for InjunctionCountOne status',
      }),
    );
    const courtWire = canonicalJson(courtPlan.messages);
    assert.match(courtWire, /Chronological State Evolution Ledger \(InjunctionCountOne, 4 ordered revisions\)/);
    assert.match(courtWire, /1\. \[t=10, status=superseded\][\s\S]*GRANTED_TRO_INITIAL/);
    assert.match(courtWire, /2\. \[t=20, status=superseded\][\s\S]*STAYED_BY_PANEL/);
    assert.match(courtWire, /3\. \[t=30, status=superseded\][\s\S]*GRANTED_TRO_REINSTATED_WITH_BOND/);
    assert.match(courtWire, /4\. \[t=40, status=active\][\s\S]*DISSOLVED_FINAL/);
    // Verify 8-char short span tags are used on the wire
    assert.match(courtWire, /\[span:[a-f0-9]{8}\]/);

    // 3. Multi-Clue Triangulation across 3 hops (`ClueA -> Hop1A -> BridgeNode <- Hop1B <- ClueB`)
    const bridgeSrc = f.store.ingestSource({
      originKey: 'src/core/TriangulatedVaultBridge.ts',
      kind: 'document',
      role: 'user',
      observedAt: 50,
      text: 'export function reconcileEscrowQuorum() { return "TRIANGULATED_BRIDGE_PAYLOAD_991"; }',
    });
    const bridgeSpan = f.store.getEvidenceChunks(bridgeSrc.sourceId)[0].spanId;
    const bridgeNode = f.store.publishNode({
      namespaceId: f.store.namespaceId,
      layer: 1,
      logicalKey: 'triangulated/bridge',
      kind: 'fact',
      title: 'OrbitalLatch and ThermalValve convergence',
      body: 'OrbitalLatch and ThermalValve converge inside reconcileEscrowQuorum',
      canonical: { entity: 'EscrowBridge' },
      compilerVersion: 'test',
      observedAt: 50,
      spanIds: [bridgeSpan],
      extractionRule: 'test',
    });
    const midA = f.store.publishNode({
      namespaceId: f.store.namespaceId,
      layer: 1,
      logicalKey: 'triangulated/midA',
      kind: 'fact',
      title: 'MidA relay',
      body: 'MidA relay',
      canonical: { entity: 'MidA' },
      compilerVersion: 'test',
      observedAt: 50,
      spanIds: [bridgeSpan],
      dependencyNodeIds: [bridgeNode.nodeId],
      extractionRule: 'test',
    });
    const seedA = f.store.publishNode({
      namespaceId: f.store.namespaceId,
      layer: 1,
      logicalKey: 'triangulated/seedA',
      kind: 'fact',
      title: 'OrbitalLatch sensor',
      body: 'OrbitalLatch sensor',
      canonical: { entity: 'OrbitalLatch' },
      compilerVersion: 'test',
      observedAt: 50,
      spanIds: [chunk1.spanId],
      dependencyNodeIds: [midA.nodeId],
      extractionRule: 'test',
    });
    const seedB = f.store.publishNode({
      namespaceId: f.store.namespaceId,
      layer: 1,
      logicalKey: 'triangulated/seedB',
      kind: 'fact',
      title: 'ThermalValve actuator',
      body: 'ThermalValve actuator',
      canonical: { entity: 'ThermalValve' },
      compilerVersion: 'test',
      observedAt: 50,
      spanIds: [chunk1.spanId],
      dependencyNodeIds: [bridgeNode.nodeId],
      extractionRule: 'test',
    });

    const seedMap = new Map<string, string[]>([
      ['clue_orbital', [seedA.nodeId]],
      ['clue_thermal', [seedB.nodeId]],
    ]);
    const bridges = triangulateMultiClueGraph(
      f.store,
      seedMap,
      analyzeRecallQuery('How do OrbitalLatch and ThermalValve interact?'),
      { maxHops: 3 },
    );
    assert.ok(bridges.some(b => b.nodeId === bridgeNode.nodeId && b.convergedClues.length === 2), '3-hop multi-clue triangulation must find the bridge node where both clues converge');
  } finally {
    f.clean();
  }
});


