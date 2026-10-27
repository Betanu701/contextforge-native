// Imported only by the explicitly opted-in live entry point.
import { writeFileSync } from 'node:fs';
import { parseArgs, runBenchmark } from './runner.ts';
const args=process.argv.slice(2),shared:string[]=[],live:Record<string,string>={};
for(let i=0;i<args.length;i++){
 if(args[i]==='--live'){if(live.enabled)throw new Error('Duplicate --live');live.enabled='true';continue;}
 if(['--endpoint','--model','--api-key-env'].includes(args[i])){const key=args[i].slice(2);if(live[key]||!args[i+1]||args[i+1].startsWith('--'))throw new Error('Invalid live option');live[key]=args[++i];}
 else {shared.push(args[i]);if(args[i+1]&&!args[i+1].startsWith('--'))shared.push(args[++i]);}
}
if(!live.enabled||!live.endpoint||!live.model)throw new Error('Requires --live --endpoint URL --model NAME');
const endpoint=new URL(live.endpoint);if(!['http:','https:'].includes(endpoint.protocol)||endpoint.username||endpoint.password)throw new Error('Invalid provider endpoint');
const key=live['api-key-env']?process.env[live['api-key-env']]:undefined;if(live['api-key-env']&&!key)throw new Error('Missing API key environment variable');
const options=parseArgs(shared);options.model=live.model;
// Exactly one response per research turn; sequential, no warmup, retries, judge
// model, parallel requests or additional inference on any failure path.
const report=await runBenchmark(options,async(messages,o)=>{
 const start=performance.now(),headers:Record<string,string>={'content-type':'application/json'};if(key)headers.authorization='Bearer '+key;
 const response=await fetch(endpoint.href.replace(/\/$/,'')+'/chat/completions',{method:'POST',headers,body:JSON.stringify({model:live.model,messages,max_tokens:o.maxOutput,temperature:0,stream:false}),signal:AbortSignal.timeout(o.timeoutMs)});
 if(!response.ok)throw new Error(`Provider HTTP ${response.status}; stopped, no retry`);
 const data=await response.json() as any,text=data.choices?.[0]?.message?.content;
 if(typeof text!=='string')throw new Error('Provider response lacks text');
 return {response:text,usage:data.usage??null,latencyMs:Math.round(performance.now()-start)};
});
const output=JSON.stringify({...report,model:live.model},null,2)+'\n';if(options.output)writeFileSync(options.output,output);else process.stdout.write(output);if(!report.pass)process.exitCode=1;
