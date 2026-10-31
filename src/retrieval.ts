import { freemem } from 'node:os';
import { createHash } from 'node:crypto';
import type { QueryFacet } from './types.ts';
export const LEXICAL_VERSION = 'lexical-facets-v2';
export const ALIAS_MARKER = '\n[cf-lexical-facets-v2] ';
const stop = new Set(`a an is it of to in on not return object fields field answer give please json preserving the for with and or but as at by from into about what when where which who whom whose why how that this these those are was were been being have has had does did do will would shall should can could may might must need turn turns audit compare analyze analyse explain concisely sentences sentence short reply specifically earlier session stored facts based many current according only use null hello hi hey thanks thank you ok okay got continue conversation tell me its their our your my be than then after before during across all every exact case punctuation character include identify distinguish apply subtract synthesize review read summarize list provide determine find tell test contrast retrieve preserve repeat repeating treat primary unresolved reference references observation observations notebook notebooks record records thread threads track tracks project projects`.split(' '));
const generic = new Set(['sample','fault_code','correction','keeper','launch_date','status','fields','unit']);
const norm=(s:string)=>s.normalize('NFKC').toLowerCase();
const runs=(s:string)=>s.match(/[\p{L}\p{N}]+(?:[_.-][\p{L}\p{N}]+)*/gu)??[];
export function tokenizeRecallText(text:string):string[] {
 const out=new Set<string>();
 for(const raw of runs(text)) {
  const full=norm(raw);out.add(full);
  if(/^\d+\.\d+$/.test(full))continue;
  const camel=raw.replace(/(\p{Ll})(\p{Lu})/gu,'$1 $2').replace(/(\p{Lu})(\p{Lu}\p{Ll})/gu,'$1 $2');
  const parts=camel.split(/[_.\-\s]+/u).map(norm);if(parts.length>1){out.add(parts.join(''));out.add(parts.join(' '));}
  for(const p of parts){out.add(p);for(const q of p.split(/(?<=\p{L})(?=\p{N})|(?<=\p{N})(?=\p{L})/u))out.add(q);}
  for(let i=0;i<parts.length;i++)for(let n=2;n<=Math.min(3,parts.length-i);n++)out.add(parts.slice(i,i+n).join(' '));
 }
 return [...out];
}
export function isTrivialPhatic(query:string):boolean {
 if(query.includes('?'))return false;
 const s=norm(query).replace(/[^\p{L}\p{N}\s]/gu,' ').replace(/\s+/g,' ').trim();
 return !s||/^(?:(?:hello|hi|hey|thanks|thank you|ok|okay|got it|continue conversation)[\s]*)+$/.test(s);
}
/** Query-only, bounded cursor salience. Offsets are UTF-16 positions in the
 * original query; this projection never rewrites stored evidence or query IDs. */
export interface CursorQueryContext {
 primaryIdentifiers:string[];
 importedIdentifiers:string[];
 tailIdentifiers:string[];
 enclosingIdentifiers:string[];
 unusedImportedIdentifiers:string[];
 nearTailImportedIdentifiers:string[];
 language:'python'|'javascript';
 codeStart:number;
 codeEnd:number;
 scannedCharacters:number;
 truncated:boolean;
}
const cursorScanLimit=65536;
const codeWords=new Set('async await def class function const let var export default import from as type interface enum namespace public private protected static abstract readonly declare new return yield if else elif for while switch case break continue try catch except finally throw raise with pass lambda true false none null undefined self this super in of and or not is extends implements get set'.split(' '));
const codeNames=(text:string)=>[...new Set((text.match(/[A-Za-z_$][\w$]*/g)??[]).filter(s=>!codeWords.has(s.toLowerCase())))];

// Kept local to avoid retrieval -> decomposer -> store -> retrieval. Like the
// grammar mask, preserve newlines/offsets and recover ordinary quotes at EOL.
function maskCursorCode(text:string,python:boolean):string {
 const out=text.split('');
 const blank=(start:number,end:number)=>{for(let j=start;j<end;j++)if(text[j]!=='\n'&&text[j]!=='\r')out[j]=' ';};
 for(let i=0;i<text.length;){
  const start=i;
  if(python&&text[i]==='#'||!python&&text.startsWith('//',i)){while(i<text.length&&text[i]!=='\n')i++;blank(start,i);continue;}
  if(!python&&text.startsWith('/*',i)){const end=text.indexOf('*/',i+2);i=end<0?text.length:end+2;blank(start,i);continue;}
  const quote=text[i];if(quote!=="'"&&quote!=='"'&&!(quote==='`'&&!python)){i++;continue;}
  const triple=python&&text.startsWith(quote.repeat(3),i),delimiter=triple?quote.repeat(3):quote;
  i+=delimiter.length;
  while(i<text.length){if(text[i]==='\\'){i+=text[i+1]==='\r'&&text[i+2]==='\n'?3:Math.min(2,text.length-i);continue;}if(text.startsWith(delimiter,i)){i+=delimiter.length;break;}if(!triple&&quote!=='`'&&/[\r\n]/.test(text[i]))break;i++;}
  blank(start,i);
 }
 return out.join('');
}

function cursorProjection(query:string):{context:CursorQueryContext;text:string}|undefined {
 // Inspect only a bounded suffix. If it starts mid-line, discard that line;
 // missing old imports/scopes is safer than manufacturing them from fragments.
 let scanStart=Math.max(0,query.length-cursorScanLimit);
 if(scanStart){const newline=query.indexOf('\n',scanStart);scanStart=newline<0?query.length:newline+1;}
 const scan=query.slice(scanStart);
 const fences=[...scan.matchAll(/^[ \t]*(`{3,}|~{3,})([^\n]*)\n?/gm)];
 let open:{start:number;body:number;marker:string;lang:string}|undefined;
 let selected:{start:number;end:number;lang:string;closed:boolean}|undefined;
 for(const f of fences){
  if(open&&f[1][0]===open.marker[0]&&f[1].length>=open.marker.length&&!f[2].trim()){
   selected={start:open.body,end:f.index!,lang:open.lang,closed:true};open=undefined;
  }else if(!open){open={start:f.index!,body:f.index!+f[0].length,marker:f[1],lang:f[2].trim().toLowerCase()};}
 }
 if(open)selected={start:open.body,end:scan.length,lang:open.lang,closed:false};
 const explicitCompletion=(text:string)=>!/\b(?:code|function|method|class)\s+(?:review|analysis|explanation)\b/i.test(text)&&/\b(?:complete|continue|finish)\s+(?:(?:the|this)\s+)?(?:following\s+)?(?:code|function|method|class|implementation|prefix)\b|\b(?:code\s*completion|at\s+the\s+cursor|next\s+(?:line|statement|token)|code\s+prefix)\b/i.test(text);
 let start=0,end=scan.length,lang='',closed=false;
 if(selected){
  ({start,end,lang,closed}=selected);
  // Structured output and data fences are never cursor prefixes.
  if(lang&&!/^(?:py|python|python3|js|javascript|jsx|ts|typescript|tsx)$/.test(lang))return;
  const outside=scan.slice(0,start)+scan.slice(end);
  if(closed&&!explicitCompletion(outside))return;
  if(!closed&&!explicitCompletion(outside)&&/\b(?:explain|review|analy[sz]e|why|vulnerabilit\w*|describe|audit)\b/i.test(outside))return;
  if(closed&&scan.slice(end).replace(/^[ \t]*(`{3,}|~{3,})[^\n]*(?:\n|$)/,'').trim()&&!explicitCompletion(scan.slice(end)))return;
 }
 if(!selected){
  const probePython=/^\s*(?:(?:async\s+)?def\s+\w+\s*\(|from\s+[.\w]+\s+import\b|import\s+[\w.]+(?:\s+as\s+\w+)?\s*(?:,|$))/m.test(scan);
  const firstCode=/^[ \t]*(?:from\s+[.\w]+\s+import\b|import\s+(?:[\w$.*]+|\{)|(?:async\s+)?def\s+\w+\s*\(|(?:export\s+)?(?:async\s+)?function\s+[\w$]+\s*\(|(?:export\s+)?class\s+[\w$]+|(?:const|let|var)\s+[\w$]+\s*=|[\w$]+\s*=)/m.exec(maskCursorCode(scan,probePython));
  if(!firstCode)return;
  const lead=scan.slice(0,firstCode.index);
  // Unfenced explanatory/choice questions are not editor buffers. Remove
  // the instruction wrapper before collecting identifiers in genuine prefixes.
  const proseLead=lead.split('\n').filter(l=>l.trim()&&!/^\s*(?:#|\/\/|\/\*|\*|\*\/)/.test(l)).join('\n');
  if(proseLead.trim()&&!explicitCompletion(proseLead))return;
  start=firstCode.index;
 }
 const code=scan.slice(start,end);
 const python=/^(?:py|python|python3)$/.test(lang)||!lang&&/^\s*(?:(?:async\s+)?def\s+\w+\s*\(|class\s+\w+[^\n]*:|from\s+[.\w]+\s+import\b|import\s+[\w.]+(?:\s+as\s+\w+)?\s*(?:,|$))/m.test(code);
 const masked=maskCursorCode(code,python),lines=masked.split('\n');
 const structural=python?/^\s*(?:(?:async\s+)?def\s+\w+\s*\(|class\s+\w+[^\n]*:|from\s+[.\w]+\s+import\b|import\s+[\w.]+(?:\s+as\s+\w+)?\s*(?:,|$))/m.test(masked):/^\s*(?:import\s+(?:[\w$]+|\{|\*)[\s\S]*?\bfrom\b|(?:export\s+)?(?:async\s+)?function\s+[\w$]+\s*\(|(?:export\s+)?class\s+[\w$]+\s*[{<]|(?:const|let|var)\s+[\w$]+\s*=)/m.test(masked);
 if(!structural)return;
 const nonempty=lines.flatMap((line,i)=>line.trim()?[i]:[]);
 if(!nonempty.length)return;
 const tailStart=nonempty[Math.max(0,nonempty.length-8)],lastLine=nonempty.at(-1)!;
 // A plain import sentence alone is not enough; raw prefixes must have a
 // declaration/assignment/call or an explicit completion request as well.
 if(!selected&&!explicitCompletion(scan)&&!/^\s*(?:(?:async\s+)?def\s+\w+\s*\(|class\s+\w+[^\n]*:|(?:export\s+)?(?:async\s+)?function\s+\w+\s*\(|(?:const|let|var)\s+\w+\s*=|[\w$.]+\s*(?:\(|=))/m.test(masked))return;
 const imports:string[]=[],importLines=new Set<number>();
 const addImport=(s:string)=>{for(const n of codeNames(s))if(!imports.includes(n))imports.push(n);};
 for(let i=0;i<lines.length;i++){
  if(!/^\s*(?:from\s+[.\w]+\s+import\b|import\s)/.test(lines[i]))continue;
  let statement=lines[i],j=i;
  let balance=(s:string)=>[...s].reduce((n,c)=>n+('({['.includes(c)?1:')}]'.includes(c)?-1:0),0);
  while(j+1<lines.length&&(balance(statement)>0||/\\\s*$/.test(statement)||!python&&!/\bfrom\b/.test(statement)&&!statement.includes(';'))&&j-i<64)statement+='\n'+lines[++j];
  for(let k=i;k<=j;k++)importLines.add(k);i=j;
  if(python){
   const from=/^\s*from\s+[.\w]+\s+import\s+([\s\S]*)/.exec(statement);
   const body=(from?from[1]:statement.replace(/^\s*import\s+/,'' )).replace(/[()\\]/g,' ');
   for(const part of body.split(',')){const m=/^\s*([\w.]+)(?:\s+as\s+(\w+))?\s*$/.exec(part);if(m)addImport(m[2]??(from?m[1]:m[1].split('.')[0]));}
  }else{
   const body=statement.replace(/^\s*import\s+(?:type\s+)?/,'').split(/\bfrom\b/)[0];
   for(const part of body.replace(/[{}]/g,',').split(',')){
    const m=/^\s*(?:\*|[\w$]+)(?:\s+as\s+([\w$]+))?\s*$/.exec(part);
    if(m)addImport(m[1]??part.trim());
    else {const typed=/^\s*type\s+([\w$]+)(?:\s+as\s+([\w$]+))?\s*$/.exec(part);if(typed)addImport(typed[2]??typed[1]);}
   }
  }
 }
 const bodyLines=lines.map((l,i)=>importLines.has(i)?'':l),tail=bodyLines.slice(tailStart).join('\n');
 const tailIdentifiers=codeNames(tail),bodyNames=new Set(codeNames(bodyLines.join('\n')));
 const unusedImportedIdentifiers=imports.filter(n=>!bodyNames.has(n));
 const nearTailImportedIdentifiers=imports.filter(n=>tailIdentifiers.includes(n));
 const enclosingIdentifiers:string[]=[];
 if(python){
  const scopes:{indent:number;name:string;kind:string}[]=[];
  for(let i=0;i<=lastLine;i++){
   if(!lines[i].trim()||importLines.has(i))continue;
   const indent=lines[i].match(/^[ \t]*/)![0].replaceAll('\t','        ').length;
   while(scopes.length&&indent<=scopes.at(-1)!.indent)scopes.pop();
   const m=/^\s*(?:async\s+)?(def|class)\s+(\w+)/.exec(lines[i]);if(m)scopes.push({indent,name:m[2],kind:m[1]});
  }
  for(const kind of ['class','def']){const scope=scopes.filter(s=>s.kind===kind).at(-1);if(scope)enclosingIdentifiers.push(scope.name);}
 }else{
  const scopes:{depth:number;name:string;kind:string}[]=[];let depth=0;
  for(const line of lines){
   const m=/^\s*(?:(?:export|default|async|public|private|protected|static|abstract)\s+)*(?:(class|function)\s+([\w$]+)|(?:const|let|var)\s+([\w$]+)\s*=.*=>|([\w$]+)\s*\([^;]*\)\s*(?::[^{}]+)?\s*\{)/.exec(line);
   const name=m&&(m[2]??m[3]??m[4]);
   if(name&&!codeWords.has(name)&&line.includes('{'))scopes.push({depth:depth+1,name,kind:m![1]==='class'?'class':'function'});
   for(const c of line){if(c==='{')depth++;if(c==='}'){depth--;while(scopes.length&&scopes.at(-1)!.depth>depth)scopes.pop();}}
  }
  for(const kind of ['class','function']){const scope=scopes.filter(s=>s.kind===kind).at(-1);if(scope)enclosingIdentifiers.push(scope.name);}
 }
 const primaryIdentifiers=[...new Set([...enclosingIdentifiers,...tailIdentifiers,...unusedImportedIdentifiers,...nearTailImportedIdentifiers])].slice(0,128);
 if(!primaryIdentifiers.length)return;
 const outside=(scan.slice(0,start)+'\n'+scan.slice(end)).replace(/^[ \t]*(`{3,}|~{3,})[^\n]*$/gm,'').replace(/\b(?:please\s+)?(?:complete|continue|finish)\s+(?:(?:the|this)\s+)?(?:following\s+)?(?:code|function|method|class|implementation|prefix)\b/gi,'');
 return {text:masked+'\n'+outside,context:{primaryIdentifiers,importedIdentifiers:imports.slice(0,128),tailIdentifiers:tailIdentifiers.slice(0,128),enclosingIdentifiers,unusedImportedIdentifiers:unusedImportedIdentifiers.slice(0,128),nearTailImportedIdentifiers:nearTailImportedIdentifiers.slice(0,128),language:python?'python':'javascript',codeStart:scanStart+start,codeEnd:scanStart+end,scannedCharacters:scan.length,truncated:scanStart>0||imports.length>128||tailIdentifiers.length>128||new Set([...enclosingIdentifiers,...tailIdentifiers,...unusedImportedIdentifiers,...nearTailImportedIdentifiers]).size>128}};
}
export interface RecallQuery { cursorContext?:CursorQueryContext; original:string; querySha256:string; phatic:boolean; substantiveTerms:string[]; exactIdentifiers:string[]; facets:QueryFacet[]; outputFieldHints:string[]; explicitReferenceHints:string[]; truncated:boolean }
export function analyzeRecallQuery(query:string,limit=256):RecallQuery {
 const split=/\bReturn\s+the\s+answer\s+object\s+with\s+fields\s*:/i.exec(query);
 const question=split?query.slice(0,split.index):query, schema=split?query.slice(split.index+split[0].length):'';
 const cursor=cursorProjection(question),primary=new Set(cursor?.context.primaryIdentifiers.map(norm));
 const external=cursor?new Set(runs(question.slice(0,cursor.context.codeStart)+' '+question.slice(cursor.context.codeEnd)).map(norm)):new Set<string>();
 const phatic=isTrivialPhatic(query), facets:QueryFacet[]=[];
 const facetQuestion=cursor?cursor.text:question;
 for(const [text,origin] of [[facetQuestion,'question'],[schema,'output_schema']] as const)for(const surface of cursor&&origin==='question'?[...runs(text),...codeNames(text)]:runs(text)) {
  const full=norm(surface);if((cursor&&origin==='question'?codeWords.has(full):stop.has(full)))continue;
  const aliases=tokenizeRecallText(surface).filter(a=>!stop.has(a)||!!cursor&&primary.has(norm(surface)));if(!aliases.length)continue;
  const kind=cursor&&origin==='question'&&codeNames(surface).length?'identifier':/^\d+(?:\.\d+)?$/.test(full)?'number':/[\d_-]/.test(surface)||(/^\p{Ll}/u.test(surface)&&/\p{Ll}\p{Lu}/u.test(surface))?'identifier':surface.length===1&&surface==='m'?'unit':/^\p{Lu}/u.test(surface)?'entity':origin==='output_schema'?'field':'content';
  const id=createHash('sha256').update(origin+'\0'+full).digest('hex').slice(0,20);
  if(!facets.some(f=>f.id===id))facets.push({id,surface,aliases,kind,weight:origin==='output_schema'?0.2:cursor?(primary.has(full)||surface.split('.').some(p=>primary.has(norm(p)))?6:external.has(full)?1:0.2):kind==='identifier'||kind==='entity'?3:1,origin});
 }
 const substantive=phatic?[]:facets.filter(f=>f.origin==='question');
 const prioritized=[...facets].sort((a,b)=>b.weight-a.weight||a.id.localeCompare(b.id));
 return {...(cursor?{cursorContext:cursor.context}:{}),original:query,querySha256:createHash('sha256').update(query).digest('hex'),phatic,substantiveTerms:[...new Set(substantive.map(f=>norm(f.surface)))],exactIdentifiers:substantive.filter(f=>f.kind==='identifier').map(f=>f.surface),facets:prioritized.slice(0,limit),outputFieldHints:runs(schema),explicitReferenceHints:query.match(/\b[a-f0-9]{64}\b/g)??[],truncated:!!cursor?.context.truncated||facets.length>limit||new Set(prioritized.slice(0,limit).flatMap(f=>f.aliases)).size>256};
}
export function buildFtsQuery(query:string|RecallQuery,limit=256):string {
 const recall=typeof query==='string'?analyzeRecallQuery(query):query;
 const cursorNames=new Set(recall.cursorContext?.primaryIdentifiers.map(norm));
 const aliases=[...new Set(recall.facets.flatMap(f=>f.aliases).filter(a=>(!stop.has(a)||cursorNames.has(a))&&a.length>0))];if(aliases.length>limit)recall.truncated=true;
 return aliases.slice(0,limit).map(a=>'"'+a.replaceAll('"','""')+'"').join(' OR ');
}
export function lexicalProjectionTitle(title:string,body:string):string {return title+ALIAS_MARKER+tokenizeRecallText(title+' '+body).filter(a=>!stop.has(a)).join(' ');}
export function canonicalRecallTitle(title:string):string {return title.split(ALIAS_MARKER)[0];}
const coverageCache=new WeakMap<RecallQuery,Map<string,any>>();
const tokenCache=new Map<string,Set<string>>();
export function scoreFacetCoverage(query:RecallQuery|string,text:string,covered:Iterable<string>=[]):{score:number;matchedFacetIds:string[];marginalFacetIds:string[];gain:number;anchored:boolean} {
 const q=typeof query==='string'?analyzeRecallQuery(query):query,seen=new Set(covered);
 let cache=coverageCache.get(q);if(!cache){cache=new Map();coverageCache.set(q,cache);}if(!seen.size&&cache.has(text))return cache.get(text);
 let tokens=tokenCache.get(text);if(!tokens){tokens=new Set(tokenizeRecallText(text));if(tokenCache.size>=512)tokenCache.clear();tokenCache.set(text,tokens);}
 const strong=q.facets.filter(f=>f.origin==='question'&&(!q.cursorContext||f.weight>0.2)&&(f.kind==='entity'||f.kind==='identifier')&&!generic.has(norm(f.surface)));
 const originalRuns=new Set(runs(text));
 const compactTokens=new Set([...tokens].map(t=>t.replace(/[_.\-\s]/g,'')));
 const matchMemo=new Map<string,number>();
 const computeMatch=(f:QueryFacet)=>q.exactIdentifiers.includes(f.surface)&&originalRuns.has(f.surface)?1:tokens.has(norm(f.surface))?0.9:f.kind==='identifier'&&compactTokens.has(norm(f.surface).replace(/[_.\-\s]/g,''))?0.9:f.aliases.some(a=>a.length>1&&!stop.has(a)&&tokens.has(a))?0.4:0;
 const match=(f:QueryFacet)=>{if(!matchMemo.has(f.id))matchMemo.set(f.id,computeMatch(f));return matchMemo.get(f.id)!;};
 const entities=strong.filter(f=>f.kind==='entity'&&f.surface.length>1);
 const identifiers=strong.filter(f=>f.kind==='identifier'&&f.surface.length>1);
 const anchored=entities.length?entities.some(f=>match(f)>=0.9)||identifiers.some(f=>match(f)>=0.9):!strong.length||strong.some(f=>match(f)>=0.9)||q.facets.filter(f=>f.origin==='question'&&f.kind==='content'&&match(f)>=0.9&&!generic.has(norm(f.surface))).length>=2;
 const matched=q.facets.filter(f=>match(f)>0&&(anchored||f.origin==='question'&&!generic.has(norm(f.surface))));
 const marginal=matched.filter(f=>!seen.has(f.id));
 const result={score:matched.reduce((n,f)=>n+f.weight*match(f),0)/Math.max(1,q.facets.reduce((n,f)=>n+f.weight,0)),matchedFacetIds:matched.map(f=>f.id),marginalFacetIds:marginal.map(f=>f.id),gain:marginal.reduce((n,f)=>n+f.weight*match(f),0),anchored};
 if(!seen.size)cache.set(text,result);return result;
}

/** Search work is not model context: reserve bounded memory per inspected row
 * and independent lanes so discovery cannot consume quote hydration allowance. */
export function resolveRetrievalWorkPolicy(options:{historyTokens?:number;corpusBytes?:number;availableMemoryBytes?:number}={}) {
 const hostMemory=options.availableMemoryBytes??Math.min(freemem(),typeof process.availableMemory==='function'?process.availableMemory():freemem());
 const memoryBytes=Math.max(1024*1024,Math.min(64*1024*1024,Math.floor(hostMemory/32)));
 const tokens=Math.max(512,Math.min(options.historyTokens??8000,262144));
 const scale=Math.max(1,Math.log2(1+(options.corpusBytes??0)/(1024*1024)));
 const maxInspected=Math.max(256,Math.min(Math.floor(memoryBytes/2048),Math.ceil(tokens/4+scale*512)));
 const discoveryRows=Math.max(32,Math.floor(maxInspected/8));
 return {maxInspected,maxBytes:memoryBytes,discoveryRows,hydrationRows:maxInspected-discoveryRows*4,availableMemoryBytes:hostMemory,historyTokens:tokens,corpusBytes:options.corpusBytes??0};
}
