import {spawn,type ChildProcess} from "node:child_process";
import {accessSync,constants,readFileSync,lstatSync,statSync} from "node:fs";
import path from "node:path";
import {runnerLimit} from "../../lib/agent/fix-runner";
export type WorkerConfig={command:string;args:string[];cwd:string;tokenFile:string};
export function privateFile(file:string){
 const stat=lstatSync(file);
 if(!stat.isFile()||stat.isSymbolicLink()||(stat.mode&0o077)!==0)throw new Error("Credential/config file must be a regular mode-0600 file.");
 return readFileSync(file,"utf8").trim();
}
export function workerConfigs(file:string,count=5):WorkerConfig[]{
 if(!Number.isInteger(count)||count<1||count>runnerLimit())throw new Error("Worker count exceeds configured runner cap.");
 const configs:unknown=JSON.parse(privateFile(file));
 if(!Array.isArray(configs)||configs.length<count)throw new Error("A configured connected coding worker is required for each slot.");
 const selected=configs.slice(0,count);
 if(new Set(selected.map(c=>c?.cwd)).size!==count)throw new Error("Each coding worker needs an isolated worktree.");
 return selected.map(c=>{
  if(!c||!path.isAbsolute(c.command)||!Array.isArray(c.args)||c.args.some((a:unknown)=>typeof a!=="string"||/token|secret|cookie|password|credential/i.test(a as string))||!path.isAbsolute(c.cwd)||!path.isAbsolute(c.tokenFile))throw new Error("Workers need an absolute executable/worktree/token file and nonsecret arguments.");
  accessSync(c.command,constants.X_OK);
  if(!statSync(c.cwd).isDirectory()||!privateFile(c.tokenFile))throw new Error("Missing worker worktree or credential.");
  return c;
 });
}
export function startWorkers(configs:WorkerConfig[],baseUrl:string,connectionId:string){
 if(!configs.length||configs.length>runnerLimit())throw new Error("Invalid worker count.");
 const origin=new URL(baseUrl);
 if(origin.username||origin.password||origin.search||origin.hash||origin.pathname!=="/"||(origin.protocol!=="https:"&&!(["localhost","127.0.0.1"].includes(origin.hostname)&&origin.protocol==="http:")))throw new Error("Invalid MCP origin.");
 const children:ChildProcess[]=[];let failed=false;const completed=new Set<number>();
 try{for(const [slot,c] of configs.entries()){
  // Minimal environment: never inherit an owner's cookie, deployment credentials, or merge token.
  const child=spawn(c.command,c.args,{cwd:c.cwd,stdio:["pipe","ignore","ignore"],env:{NODE_ENV:process.env.NODE_ENV??"production",PATH:process.env.PATH,HOME:process.env.HOME,TMPDIR:process.env.TMPDIR,AEGIS_MCP_BASE_URL:origin.origin,AEGIS_AGENT_TOKEN:privateFile(c.tokenFile),AEGIS_WORKER_SLOT:String(slot+1),AEGIS_CONNECTION_ID:connectionId}});
  children.push(child);child.stdin!.on("error",()=>{failed=true;});child.on("error",()=>{failed=true;});child.on("exit",code=>{if(code!==0)failed=true;completed.add(slot);});
  child.stdin!.end(JSON.stringify({task:"Use Aegis MCP get_fix_assignments then claim_fix. If no assignment, poll without editing. Work only the server assignment in this isolated worktree; renew every 60s with get_fix_assignments(runnerAssignmentId). If a claim or renewal is refused, stop editing immediately and do not push or open a PR. Push a scoped fix branch to the private demo remote, then propose_fix_pr with poamItemId and runnerAssignmentId. One assignment, one PR. Never merge, close, accept risk or apply cloud infrastructure. Exit only after the PR is registered. No worker-to-worker coordination.",connectionId})+"\n");
 }}catch{for(const child of children)child.kill("SIGTERM");throw new Error("Connected worker startup failed.");}
 return {children,assertHealthy(){if(failed)throw new Error("Connected worker failed; no live success can be inferred.");},assertRegistered(assignments:{state:string;prNumber?:number}[]){if(assignments.length!==configs.length||assignments.some(j=>!j.prNumber||!(["pr-open","merged"].includes(j.state))))throw new Error("Workers have not registered all provider PRs.");},stop(){for(const child of children)if(child.exitCode===null)child.kill("SIGTERM");},completed};
}
