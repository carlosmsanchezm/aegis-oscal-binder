// OFFLINE CI fixture adapter only; never use this to host or publish the private live demo.
import {execFileSync} from "node:child_process";
import {lstatSync,existsSync,readdirSync,readFileSync,writeFileSync,mkdirSync,realpathSync} from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"../..");
const target=process.argv[2]&&path.resolve(process.argv[2]);
if(!target||!existsSync(target)||realpathSync(target)!==target)throw new Error("Provide an existing real-path local microservices-demo clone.");
const git=(...args)=>execFileSync("git",["-C",target,...args],{encoding:"utf8",stdio:["ignore","pipe","pipe"]}).trim();
if(git("branch","--show-current")!=="codex/phase4-synthetic")throw new Error("Plant/reset only on codex/phase4-synthetic; main and all other branches are refused.");
if(git("remote","get-url","origin")!=="https://github.com/carlosmsanchezm/microservices-demo.git")throw new Error("Use the documented local reference clone. No remote push is performed.");
const marker=path.join(target,".aegis-demo-plant.json");
if(lstatSync(marker,{throwIfNoEntry:false})?.isSymbolicLink())throw new Error("Symlink ownership marker refused.");
const prior=existsSync(marker)?JSON.parse(readFileSync(marker,"utf8")):null;
if(prior&&prior.synthetic!==true)throw new Error("Unknown ownership marker.");
const files=[];
function inventory(from,to){for(const item of readdirSync(from,{withFileTypes:true})){if(item.name.startsWith(".terraform")||item.name==="tests"||item.name.endsWith(".tfstate"))continue;const src=path.join(from,item.name),dest=path.posix.join(to,item.name);if(item.isDirectory())inventory(src,dest);else if(item.isFile())files.push({src,dest});else throw new Error("Symlink source refused.");}}
inventory(path.join(root,"scripts/demo/templates"),"");inventory(path.join(root,"infra/demo/aws"),"infra/aegis-demo");
// Validate the entire write set before changing any file. Never reset or clean the repository.
for(const {dest} of files){
 const pieces=dest.split("/");let parent=target;
 for(const piece of pieces){parent=path.join(parent,piece);if(lstatSync(parent,{throwIfNoEntry:false})?.isSymbolicLink())throw new Error("Symlink target refused.");}
 if(existsSync(path.join(target,dest))&&!prior?.files?.includes(dest))throw new Error("Refusing to replace an unowned file: "+dest);
}
for(const {src,dest} of files){const out=path.join(target,dest);mkdirSync(path.dirname(out),{recursive:true});writeFileSync(out,readFileSync(src));}
writeFileSync(marker,JSON.stringify({synthetic:true,source:prior?.source??git("rev-parse","HEAD"),files:files.map(f=>f.dest)},null,2)+"\n");
console.log(JSON.stringify({stage:prior?"reset_replant":"planted",at:new Date().toISOString(),synthetic:true,branch:"codex/phase4-synthetic",files:files.map(f=>f.dest),noLiveAwsApply:true}));
