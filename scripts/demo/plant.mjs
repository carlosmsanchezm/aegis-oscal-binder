import {createHash} from "node:crypto";
import {execFileSync} from "node:child_process";
import {lstatSync,existsSync,readdirSync,readFileSync,writeFileSync,mkdirSync,realpathSync,unlinkSync} from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"../..");
const target=process.argv[2]&&path.resolve(process.argv[2]);
if(!target||!existsSync(target)||realpathSync(target)!==target)throw new Error("Provide an existing real-path local microservices-demo clone.");
const git=(...args)=>execFileSync("git",["-C",target,...args],{encoding:"utf8",stdio:["ignore","pipe","pipe"]}).trim();
if(git("branch","--show-current")!=="codex/phase4-synthetic")throw new Error("Plant/reset only on codex/phase4-synthetic; main and all other branches are refused.");
const privateUrl="https://github.com/carlosmsanchezm/aegis-boutique-demo-private.git";
if(!git("remote").split("\n").some(name=>git("remote","get-url",name)===privateUrl))throw new Error("The enumerated private demo remote is required. No public planting target is accepted.");
if(realpathSync(git("rev-parse","--show-toplevel"))!==target)throw new Error("Use the repository root.");
const marker=path.join(target,".aegis-demo-plant.json");
if(lstatSync(marker,{throwIfNoEntry:false})?.isSymbolicLink())throw new Error("Symlink ownership marker refused.");
const prior=existsSync(marker)?JSON.parse(readFileSync(marker,"utf8")):null;
if(prior&&(prior.synthetic!==true||!/^([a-f0-9]{40})$/.test(prior.source)||!Array.isArray(prior.files)))throw new Error("Unknown ownership marker.");
const retired=["src/aegis-demo/auth.py","src/aegis-demo/config.py"].filter(file=>prior?.files?.includes(file)&&existsSync(path.join(target,file)));
for(const file of retired){
 let current=target;
 for(const part of file.split("/")){current=path.join(current,part);if(lstatSync(current,{throwIfNoEntry:false})?.isSymbolicLink())throw new Error("Symlink retired target refused.");}
 if(!readFileSync(path.join(target,file)).equals(readFileSync(path.join(root,"scripts/demo/templates",file))))throw new Error("Refusing to retire modified companion fixture.");
}
const files=[];
function inventory(from,to){for(const item of readdirSync(from,{withFileTypes:true})){if(item.name.startsWith(".terraform")||item.name==="tests"||item.name.endsWith(".tfstate"))continue;const src=path.join(from,item.name),dest=path.posix.join(to,item.name);if(item.isDirectory())inventory(src,dest);else if(item.isFile())files.push({src,dest});else throw new Error("Symlink source refused.");}}
inventory(path.join(root,"scripts/demo/templates/.github"),".github");inventory(path.join(root,"infra/demo/aws"),"infra/aegis-demo");
const hash=bytes=>createHash("sha256").update(bytes).digest("hex");
const services=JSON.parse(readFileSync(path.join(root,"scripts/demo/patches/manifest.json"),"utf8"));
for(const service of services){
 const original=git("show",`${prior?.source??"HEAD"}:${service.path}`)+"\n";
 if(hash(original)!==service.baseSha256)throw new Error("Service base does not match the reviewed Boutique revision.");
 const planted=original.replace(service.before,service.after);
 if(hash(planted)!==service.plantedSha256)throw new Error("Service patch does not match the reviewed bytes.");
 const current=readFileSync(path.join(target,service.path));
 if(!prior?.files?.includes(service.path)&&hash(current)!==service.baseSha256)throw new Error("Refusing unowned service edits.");
 files.push({dest:service.path,bytes:planted,service:true});
}
// Validate the entire write set before changing any file. Never reset or clean the repository.
for(const {dest,service} of files){
 const pieces=dest.split("/");let parent=target;
 for(const piece of pieces){parent=path.join(parent,piece);if(lstatSync(parent,{throwIfNoEntry:false})?.isSymbolicLink())throw new Error("Symlink target refused.");}
 if(existsSync(path.join(target,dest))&&!service&&!prior?.files?.includes(dest))throw new Error("Refusing to replace an unowned file: "+dest);
}
for(const file of retired)unlinkSync(path.join(target,file));
for(const {src,dest,bytes} of files){const out=path.join(target,dest);mkdirSync(path.dirname(out),{recursive:true});writeFileSync(out,bytes??readFileSync(src));}
writeFileSync(marker,JSON.stringify({synthetic:true,privateRemote:privateUrl,source:prior?.source??git("rev-parse","HEAD"),files:files.map(f=>f.dest)},null,2)+"\n");
console.log(JSON.stringify({stage:prior?"reset_replant":"planted",at:new Date().toISOString(),synthetic:true,branch:"codex/phase4-synthetic",files:files.map(f=>f.dest),noLiveAwsApply:true}));
