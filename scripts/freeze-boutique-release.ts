/** Freeze only safe derived facts from a verified real Actions run. Raw secret matches are never committed. */
import {mkdir,writeFile} from "node:fs/promises";
import path from "node:path";
import {Octokit} from "@octokit/rest";
import {readGithubRelease} from "../lib/collector/github-release";
async function main(){
const runId=Number(process.argv[2]);
if(!Number.isSafeInteger(runId)||runId<=0)throw new Error("Supply the real successful workflow run id.");
if(!process.env.GH_TOKEN)throw new Error("Provide GitHub access through the existing secret manager environment.");
const result=await readGithubRelease(new Octokit({auth:process.env.GH_TOKEN,log:{debug(){},info(){},warn(){},error(){}}}),"carlosmsanchezm","microservices-demo",runId);
const folder=path.resolve("fixtures/boutique-live",String(result.runId));await mkdir(folder,{recursive:true});
await writeFile(path.join(folder,"event.json"),JSON.stringify(result.event,null,2),{flag:"wx"});
await writeFile(path.join(folder,"README.md"),`# Recorded real Online Boutique scanner run\n\nRun: https://github.com/carlosmsanchezm/microservices-demo/actions/runs/${result.runId}\nPinned commit: ${result.commit}.\n\nThis fixture is a recording of a verified live pipeline artifact, for tests only. Production pulls fresh retained observations. Only safe collector facts are frozen; source checksums identify the original scanner bytes. No deployment approval is supplied.\n`,{flag:"wx"});
console.log(`Recorded safe collector fixture for workflow run ${result.runId}.`);

}
main().catch(()=>{console.error("Could not freeze the real workflow run. Check access, run identity, archive integrity and scanner format.");process.exitCode=1;});
