import {it,expect} from "vitest";
import {readFileSync,mkdtempSync,writeFileSync,rmSync,mkdirSync,symlinkSync,realpathSync} from "node:fs";
import {tmpdir} from "node:os";
import path from "node:path";
import {spawnSync,execFileSync} from "node:child_process";
import {plantedGapPresent} from "../scripts/demo/fixture-scan";
import {DEMO_GAPS as CURRENT_GAPS} from "../scripts/demo/gaps";
const DEMO_GAPS=CURRENT_GAPS.map((g,i)=>({...g,path:i===0?"src/aegis-demo/auth.py":i===1?"src/aegis-demo/config.py":g.path}));
it("all five planted gaps have actual narrow scanner rules and corrected states",()=>{
 const fixes=["def read_demo_record(principal):\n    if principal is None:\n        raise PermissionError()\n    return {}",'import os\nDEMO_CREDENTIAL = os.environ["DEMO_CREDENTIAL"]','permissions: {contents: read}\njobs: {synthetic: {steps: [{uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683}]}}','versioning_configuration { status = "Enabled" }','ingress = []'];
 for(const [i,g] of DEMO_GAPS.entries()){
  const src=g.path.startsWith("infra/")?"infra/demo/aws/"+g.path.replace("infra/aegis-demo/",""):"scripts/demo/templates/"+g.path;
  expect(plantedGapPresent(g.id,readFileSync(src,"utf8"))).toBe(true);expect(plantedGapPresent(g.id,fixes[i])).toBe(false);
 }
});
it("reset/replant owns only enumerated files and refuses other branches and symlinks",()=>{
 const dir=realpathSync(mkdtempSync(path.join(tmpdir(),"phase4-plant-")));
 try{
  const git=(...args:string[])=>execFileSync("git",["-C",dir,...args],{stdio:"pipe"});git("init","-b","codex/phase4-synthetic");git("remote","add","origin","https://github.com/carlosmsanchezm/microservices-demo.git");writeFileSync(path.join(dir,"keep.txt"),"unrelated");git("add","keep.txt");git("-c","user.name=Synthetic test","-c","user.email=synthetic@example.invalid","commit","-m","Initial local fixture");
  const plant=()=>spawnSync(process.execPath,["scripts/demo/fixture-plant.mjs",dir],{encoding:"utf8"});
  expect(plant().status).toBe(0);writeFileSync(path.join(dir,DEMO_GAPS[0].path),"fixed");expect(plant().status).toBe(0);expect(readFileSync(path.join(dir,"keep.txt"),"utf8")).toBe("unrelated");
  expect(readFileSync(path.join(dir,DEMO_GAPS[0].path),"utf8")).toContain("DEMO-CODE-01");
  git("branch","-m","main");expect(plant().status).not.toBe(0);git("branch","-m","codex/phase4-synthetic");
  rmSync(path.join(dir,DEMO_GAPS[0].path));symlinkSync(path.join(dir,"keep.txt"),path.join(dir,DEMO_GAPS[0].path));expect(plant().status).not.toBe(0);expect(readFileSync(path.join(dir,"keep.txt"),"utf8")).toBe("unrelated");
 }finally{rmSync(dir,{recursive:true,force:true});}
});
it("shared scanner facts retain explicit nested paths while ambiguous targets stay conservative",async()=>{
 const {parseScanner}=await import("../lib/collector/scanners/index");
 const scan=(uri:string)=>parseScanner("sast",{runs:[{results:[{ruleId:"demo-auth",level:"error",locations:[{physicalLocation:{artifactLocation:{uri},region:{startLine:1}}}]}]}]},"sast.json");
 expect(scan("src/aegis-demo/auth.py").facts.find(f=>f.outcome==="fail")?.fixPaths).toEqual(["src/aegis-demo/auth.py"]);
 for(const target of ["/src/auth.py","auth.py","../src/auth.py"])expect(scan(target).facts.find(f=>f.outcome==="fail")?.fixPaths).toBeUndefined();
});
