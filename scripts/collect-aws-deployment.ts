import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { builderOwner } from "../lib/server/builder-store";
import { readSessionId } from "../lib/aegis/store";
import { collectAndRetainAwsDeployment } from "../lib/collector/aws/connected";
import { accountTarget } from "../lib/collector/aws/account";
import { AWS_IAC_CRITERIA, type DeploymentCriterion } from "../lib/collector/aws/deployment-criteria";
import { sha256Bytes } from "../lib/collector/aws/jcs";

type Config={demoUrl:string;connectionId:string;cookieFile:string;repositoryRoot:string;appliedCommit:string;
  modulePath:string;receiptOut:string;targets:{targetFile:string;profile:string;readerRoleArn:string;out:string;terraformRoot:string;applyReceipt:string}[]};
function privateJson<T>(file:string):T {
  const stat=lstatSync(file);
  if(!stat.isFile()||stat.isSymbolicLink()||(stat.mode&0o077)!==0)throw new Error("Operator files must be private regular files.");
  return JSON.parse(readFileSync(file,"utf8")) as T;
}
function git(root:string,args:string[]){return execFileSync("git",["-C",root,...args],{encoding:"utf8"}).trim();}

async function main(){
  process.umask(0o077);
  if(process.argv.length!==4||process.argv[2]!=="--config")throw new Error("Pass --config <private operator JSON>. No fixture or report-upload mode exists.");
  const config=privateJson<Config>(process.argv[3]);
  // This operator command is deliberately scoped to the approved dedicated take.
  if(config.demoUrl!=="https://aegis-demo.example.com")throw new Error("This take is restricted to the dedicated demo host.");
  if(!process.env.BLOB_READ_WRITE_TOKEN||process.env.AEGIS_DATA_DIR)throw new Error("Load the dedicated demo's configured private Blob environment; local-directory persistence is refused.");
  const root=realpathSync(config.repositoryRoot);
  if(!/^[a-f0-9]{40}$/.test(config.appliedCommit)||git(root,["rev-parse","HEAD"])!==config.appliedCommit||git(root,["status","--porcelain"]))
    throw new Error("The operator repository must be clean at the exact applied commit.");
  if(!/^infra\/(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+$/.test(config.modulePath)||config.modulePath.split("/").includes(".."))throw new Error("A nested IaC module path is required.");
  const moduleDir=path.join(root,config.modulePath);
  const files=readdirSync(moduleDir).filter(n=>n.endsWith(".tf")).sort();
  if(!files.length||files.some(n=>!git(root,["ls-files","--",`${config.modulePath}/${n}`])))throw new Error("The IaC module must consist of committed Terraform files.");
  const moduleHashes=Object.fromEntries(files.map(n=>[n,sha256Bytes(readFileSync(path.join(moduleDir,n)))]));
  const fixPaths:Record<DeploymentCriterion,string[]>={
    s3_bucket_object_versioning:[`${config.modulePath}/bucket.tf`],
    ec2_securitygroup_allow_ingress_from_internet_to_tcp_port_22:[`${config.modulePath}/network.tf`],
  };
  for(const criterion of Object.keys(AWS_IAC_CRITERIA) as DeploymentCriterion[])
    for(const file of fixPaths[criterion])if(!git(root,["ls-files","--",file]))throw new Error("An IaC remediation target is not tracked.");
  if(!Array.isArray(config.targets)||config.targets.length!==2)throw new Error("Both approved sandbox targets are required.");
  const approved=new Map([["aws","123456789012"],["aws-us-gov","111122223333"]]);
  const targets=config.targets.map(t=>{
    const target=accountTarget(privateJson(t.targetFile));
    if(target.allowedAccountIds.length!==1||target.allowedAccountIds[0]!==approved.get(target.partition))throw new Error("Target is outside the approved sandbox accounts.");
    approved.delete(target.partition);
    if(t.readerRoleArn!==`arn:${target.partition}:iam::${target.allowedAccountIds[0]}:role/AegisPhase7EvidenceReader`)
      throw new Error("The Phase 7 scoped reader role is required; operator credentials cannot scan.");
    const apply=privateJson<{account:string;partition:string;region:string;sha256:string;plan:string;exitCode:number;finishedAt:string}>(t.applyReceipt);
    if(apply.exitCode!==0||apply.account!==target.allowedAccountIds[0]||apply.partition!==target.partition||!target.regions.includes(apply.region)||
      sha256Bytes(readFileSync(apply.plan))!==apply.sha256||!Number.isFinite(Date.parse(apply.finishedAt)))throw new Error("A successful matching saved-plan apply receipt is required.");
    const modules=JSON.parse(readFileSync(path.join(t.terraformRoot,".terraform/modules/modules.json"),"utf8")) as {Modules:{Key:string;Dir:string}[]};
    const appliedModule=modules.Modules.find(m=>m.Key==="gaps");
    if(!appliedModule)throw new Error("Applied Terraform module metadata is missing.");
    const appliedDir=path.resolve(t.terraformRoot,appliedModule.Dir);
    const appliedFiles=readdirSync(appliedDir).filter(n=>n.endsWith(".tf")).sort();
    if(JSON.stringify(appliedFiles)!==JSON.stringify(files)||files.some(n=>sha256Bytes(readFileSync(path.join(appliedDir,n)))!==moduleHashes[n]))
      throw new Error("Applied IaC twin differs from the pinned private repository module.");
    return {target,profile:t.profile,out:t.out,requiredRoleArn:t.readerRoleArn};
  });
  if(approved.size)throw new Error("Both approved partitions are required.");
  const stat=lstatSync(config.cookieFile);
  if(!stat.isFile()||stat.isSymbolicLink()||(stat.mode&0o077)!==0)throw new Error("The owner cookie file must be private.");
  const cookie=readFileSync(config.cookieFile,"utf8").trim(),owner=builderOwner(cookie),sessionId=readSessionId(cookie);
  if(!owner||!sessionId)throw new Error("The owning workspace cookie is required.");
  const repository=git(root,["remote","get-url","origin"]).replace(/^git@github.com:/,"https://github.com/").replace(/\.git$/,"");
  const result=await collectAndRetainAwsDeployment({connectionId:config.connectionId,sessionId,owner,
    binding:{repository,appliedCommit:config.appliedCommit,fixPaths,plantedBranch:"codex/phase7-cloud-baseline"},targets});
  writeFileSync(config.receiptOut,JSON.stringify({collectedAt:new Date().toISOString(),demoUrl:config.demoUrl,appliedCommit:config.appliedCommit,moduleHashes,
    origin:"operator-local-live-aws",deploymentReceipt:result.bundle.id,captureReceipts:result.captureReceipts,
    scanRecords:result.records.map(r=>({partition:r.target.partition,sha256:r.integrity.sha256,trigger:r.run.trigger})),
    projectionPending:result.projectionPending},null,2)+"\n",{flag:"wx",mode:0o600});
  console.log("Live AWS deployment retained. Refresh the native release through normal hosted collection. Receipt:",config.receiptOut);
}
main().catch(()=>{console.error("Operator AWS collection refused or failed. Inspect private scanner receipts; no secrets are printed.");process.exitCode=1;});
