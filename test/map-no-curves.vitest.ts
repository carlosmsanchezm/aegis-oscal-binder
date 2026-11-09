import {describe,it,expect} from "vitest";
import {createElement} from "react";
import {renderToStaticMarkup} from "react-dom/server";
import {readFileSync,readdirSync,statSync} from "node:fs";
import path from "node:path";
import {PackageMap} from "../components/binder/PackageMap";
import {RollupMap} from "../components/binder/RollupMap";
import {getPackageState,ingestOscalPackage} from "../lib/aegis";
import {findRepoRoot} from "../lib/aegis/paths";
import {buildLayout} from "../lib/aegis/map-placement";
import {packageMapGeometry} from "../lib/aegis/package-map-geometry";
import {attachmentRouter,familyRoutes,pillRoute,relatedRoutes,withinRoutes,evidenceTreeKey,roleTreeKey,type MapLayout,type Route} from "../lib/aegis/map-routes";
import {directedLinksFor} from "../lib/aegis/map-view";
import {treePath} from "../lib/aegis/selected-tree";
import {mergeStoredReleases,PODINFO_RETEST_RECEIPT} from "../lib/aegis/control-rollup";
import {applyReleaseRollup} from "../lib/aegis/rollup-package";
import {moderateRollupShell} from "../lib/aegis/rollup-shell";
import {CCM_EXAMPLE} from "../lib/aegis/pipeline-evidence";
import {generatedMapFixture} from "./support/map-fixtures";
import {receivedRetest} from "./support/received-retest";
import type {PackageState} from "../lib/aegis/types";

// Every line the package map draws is a right-angled route. A path is a curve when it uses
// Q, S, T or A, or a C whose control points leave the straight segment it ends on.
const root=findRepoRoot();
const ctx=()=>({root,now:()=>new Date("2026-09-24T15:00:00.000Z")});
type P={x:number;y:number};

/** Curved pieces of an SVG path `d`; empty when every piece is a straight segment. */
function curvesIn(d:string,axis=false,roundedCorners=false):string[]{
 const tokens=d.match(/[a-zA-Z]|-?\d*\.?\d+(?:e[+-]?\d+)?/g)??[];
 const bad:string[]=[];
 let i=0,cmd="",cur:P={x:0,y:0},start:P={x:0,y:0};
 const num=()=>Number(tokens[i++]);
 const onSegment=(p:P,a:P,b:P)=>Math.abs((b.x-a.x)*(p.y-a.y)-(b.y-a.y)*(p.x-a.x))<=.01*Math.max(1,Math.hypot(b.x-a.x,b.y-a.y));
 const straight=(a:P,b:P)=>!axis||Math.abs(a.x-b.x)<.01||Math.abs(a.y-b.y)<.01;
 while(i<tokens.length){
  if(/[a-zA-Z]/.test(tokens[i]))cmd=tokens[i++];
  const rel=cmd===cmd.toLowerCase()&&cmd!=="z"&&cmd!=="Z";
  const at=(x:number,y:number):P=>rel?{x:cur.x+x,y:cur.y+y}:{x,y};
  switch(cmd.toUpperCase()){
   case "M":{cur=start=at(num(),num());cmd=rel?"l":"L";break;}
   case "L":{const p=at(num(),num());if(!straight(cur,p))bad.push(`diagonal ${cur.x},${cur.y} ${p.x},${p.y}`);cur=p;break;}
   case "H":{const x=num();cur={x:rel?cur.x+x:x,y:cur.y};break;}
   case "V":{const y=num();cur={x:cur.x,y:rel?cur.y+y:y};break;}
   case "Z":{if(!straight(cur,start))bad.push("diagonal close");cur=start;break;}
   case "Q":{const corner=at(num(),num()),end=at(num(),num());
    const orthogonal=(Math.abs(cur.x-corner.x)<.01&&Math.abs(corner.y-end.y)<.01)||(Math.abs(cur.y-corner.y)<.01&&Math.abs(corner.x-end.x)<.01);
    const bounded=Math.hypot(cur.x-corner.x,cur.y-corner.y)<=8.01&&Math.hypot(corner.x-end.x,corner.y-end.y)<=8.01;
    if(!roundedCorners||!orthogonal||!bounded)bad.push(`Q ${corner.x},${corner.y} ${end.x},${end.y}`);cur=end;break;}
   case "C":{const b=at(num(),num()),c=at(num(),num()),e=at(num(),num());if(!onSegment(b,cur,e)||!onSegment(c,cur,e))bad.push(`C ${b.x},${b.y} ${c.x},${c.y} ${e.x},${e.y}`);else if(!straight(cur,e))bad.push(`diagonal ${cur.x},${cur.y} ${e.x},${e.y}`);cur=e;break;}
   default:{bad.push(`${cmd} command`);i=tokens.length;}
  }
 }
 return bad;
}

/** `d` of every stroked line in rendered markup, outside markers and other defs. */
function linePaths(html:string){
 const body=html.replace(/<(defs|marker)\b[\s\S]*?<\/\1>/g,"");
 return [...body.matchAll(/<path\b([^>]*)>/g)].map(([,attrs])=>({attrs,d:/\sd="([^"]*)"/.exec(attrs)?.[1]??""})).filter(path=>path.d);
}
function expectNoCurves(html:string,label:string){
 const paths=linePaths(html);
 // BUI-024 hides planning evidence lines at rest. Every line that is present remains checked.
 if(!html.includes('data-layout-engine="round21"'))expect(paths.length,`${label} renders lines`).toBeGreaterThan(0);
 const curved=paths.flatMap(path=>curvesIn(path.d,/data-rel=|data-pipeline|data-tree/.test(path.attrs),html.includes('data-layout-engine="round21"')).map(why=>`${why} in ${path.attrs.slice(0,160)}`));
 expect(curved,label).toEqual([]);
}
function expectStraight(route:Route|null|undefined,label:string){
 expect(route,label).toBeTruthy();
 for(let k=1;k<route!.length;k+=1){
  const a=route![k-1],b=route![k];
  expect(Math.abs(a.x-b.x)<.01||Math.abs(a.y-b.y)<.01,`${label} segment ${k}: ${a.x},${a.y} → ${b.x},${b.y}`).toBe(true);
 }
 expect(curvesIn(treePath(route!),true),label).toEqual([]);
}

function ssp(file:string){
 const text=readFileSync(path.join(root,file),"utf8");
 return getPackageState(ingestOscalPackage({text,filename:path.basename(file),catalogId:"fedramp-rev5"},ctx()),ctx());
}
const shell=moderateRollupShell(root);
const record=receivedRetest();
const boutique={...CCM_EXAMPLE,pipelineUrl:"https://gitlab.com/reference/online-boutique/-/pipelines/42",pipelineId:"42"};
const generated=generatedMapFixture(7,"medium");
/** Every evidence source the planning workspace can show, plus the package editor's files. */
const sources:Array<{name:string;history:ReturnType<typeof mergeStoredReleases>|typeof generated.records}>=[
 {name:"uploaded package only",history:[]},
 {name:"Podinfo recorded example",history:[CCM_EXAMPLE,PODINFO_RETEST_RECEIPT]},
 {name:"Online Boutique captured reference",history:[boutique]},
 {name:"received pipeline",history:[CCM_EXAMPLE,record]},
 {name:"generated pipeline import",history:generated.records},
];
const packages:Array<{name:string;pkg:()=>PackageState}>=[
 ...["public/samples/sample-oscal-ssp-rev5.json","public/samples/sample-oscal-ssp-rev5-moderate.json","public/upload/upload-test-ssp-rev5.json","public/upload/upload-test-wrapped-ssp-rev5.json","fixtures/upload/ssp-rev5.json"]
  .map(file=>({name:file,pkg:()=>ssp(file)})),
 ...readdirSync(path.join(root,"fixtures","audit")).map(file=>({name:`fixtures/audit/${file}`,pkg:()=>ssp(`fixtures/audit/${file}`)})),
];
const noop=()=>{};

/** Large layouts route related trees for a spread of controls; small ones route every control. */
function everyRoute(layout:MapLayout,pkg:PackageState,directed:boolean,label:string,stride=layout.controls.length>60?11:1){
 const router=attachmentRouter(layout);
 const keys=[...layout.roles.map(roleTreeKey),...layout.evidence.map(evidenceTreeKey)];
 expect(new Set(keys).size,`${label} one tree per role chip and evidence box`).toBe(keys.length);
 const placed=new Set(layout.controls.map(control=>control.id));
 for(const source of [...layout.roles.map(role=>({key:roleTreeKey(role),item:role})),...layout.evidence.map(evidence=>({key:evidenceTreeKey(evidence),item:evidence}))]){
  const tree=router.tree(source.key);
  for(const id of source.item.controlIds.filter(id=>placed.has(id)))expectStraight(tree?.get(id),`${label} ${source.key}→${id}`);
 }
 for(const pill of layout.pills)expectStraight(pillRoute(layout,pill),`${label} pill ${pill.controlId}`);
 layout.controls.filter((_,index)=>index%stride===0).forEach(control=>{
  for(const arc of relatedRoutes(layout,control.id,directedLinksFor(pkg.map.edges,control.id),directed))expectStraight(arc.route,`${label} related ${arc.key}`);
 });
 for(const lane of layout.lanes){
  for(const [id,route] of familyRoutes(layout,lane.id,layout.lanes.map(other=>other.id)))expectStraight(route,`${label} family ${lane.id}→${id}`);
  for(const [key,route] of withinRoutes(layout,lane.id,()=>true))expectStraight(route,`${label} within ${key}`);
 }
 for(const bundle of layout.bundles)expect(curvesIn(bundle.d,true),`${label} bundle ${bundle.left}-${bundle.right}`).toEqual([]);
}

describe("map lines use orthogonal runs with only the approved 3b corner rounding",()=>{
 it("the path reader catches every kind of curve",()=>{
  expect(curvesIn("M 0 0 L 0 10 C 0 12, 0 14, 0 20 L 30 20",true)).toEqual([]);
  expect(curvesIn("M 0 0 C 0 8, 20 2, 20 10")).toHaveLength(1);
  expect(curvesIn("M0 0Q5 5 10 0")).toHaveLength(1);
  expect(curvesIn("M0 0 L0 12 Q0 20 8 20 L24 20",true,true)).toEqual([]);
  expect(curvesIn("M0 0 Q0 20 20 20",true,true)).toHaveLength(1);
  expect(curvesIn("M0 0 Q5 5 10 0",true,true)).toHaveLength(1);
  expect(curvesIn("M0 0A5 5 0 0 1 10 0")).toHaveLength(1);
  expect(curvesIn("M0 0S5 5 10 0")).toHaveLength(1);
  expect(curvesIn("M 0 0 L 10 10",true)).toHaveLength(1);
  expect(curvesIn("M 0 0 h 10 v 10 Z")).toEqual([]);
 });

 it("source code builds no curved path",()=>{
  const files:string[]=[];
  const walk=(dir:string)=>{for(const name of readdirSync(dir)){const full=path.join(dir,name);if(statSync(full).isDirectory())walk(full);else if(/\.(tsx?|css)$/.test(name))files.push(full);}};
  for(const dir of ["components","lib","app"])walk(path.join(root,dir));
  // The frozen r3 evidence card is a separate diagram. All package map files and rendered routes stay checked.
  const evidenceDiagram=path.join(root,"components","binder","EvidenceGraph.tsx");
  // A path string: a template or literal that starts with a move, or a piece appended to one.
  const curved=[
   /`\s*[Mm]\s*(-?\d|\$\{)[^`]*[\s}\d,][CcQqSsTtAa]\s*(-?\d|\$\{)/,
   /\+=\s*[`"']\s*[CcQqSsTtAa][\s$]/,
   /\bd=["'{`]\s*[Mm][^"'}`]*[\d\s][CcQqSsTtAa]\s*-?\d/,
   /bezier|quadraticCurveTo|bezierCurveTo|arcTo\(|\.arc\(/i,
   /[Cc]urve\w*\s*[(<]|function\s+\w*[Cc]urve/,
  ];
  // treePath's C pieces are straight thirds of each segment; the route checks below prove it.
  const allowed=(file:string,line:string)=>file.endsWith(path.join("lib","aegis","selected-tree.ts"))&&line.includes("a.x + dx / 3");
  const hits=files.filter(file=>file!==evidenceDiagram).flatMap(file=>readFileSync(file,"utf8").split("\n").flatMap((line,index)=>curved.some(pattern=>pattern.test(line))&&!allowed(file,line)?[`${path.relative(root,file)}:${index+1}: ${line.trim().slice(0,140)}`]:[]));
  expect(hits).toEqual([]);
 });

 for(const width of [1280,1440,1920])for(const {name,pkg} of packages){
  it(`every route is right-angled: ${name} at ${width} in the package editor and the planning workspace`,()=>{
   const state=pkg();
   everyRoute(buildLayout(state,width,false),state,true,`${name} package ${width}`);
   everyRoute(packageMapGeometry(state,width,false,700) as MapLayout,state,false,`${name} planning ${width}`);
  },120_000);
 }

 for(const {name,history} of sources)it(`every route is right-angled: ${name} on the Moderate baseline`,()=>{
  for(const width of [1280,1920]){
   const pkg=applyReleaseRollup(shell,history);
   everyRoute(packageMapGeometry(pkg,width,false,700) as MapLayout,pkg,false,`${name} ${width}`);
  }
 },120_000);

 for(const {name,history} of sources)for(const loaded of [false,true])it(`planning map uses orthogonal runs and bounded 3b corners: ${name}, SSP ${loaded ? "loaded" : "not loaded"}`,()=>{
  const subset=ssp("public/samples/sample-oscal-ssp-rev5.json");
  const pkg=applyReleaseRollup(shell,history,loaded?subset:null);
  const current=history.at(-1)??record;
  expectNoCurves(renderToStaticMarkup(createElement(RollupMap,{pkg,basePkg:loaded?subset:undefined,history,record:current,highlighted:history.length>0,packageControlIds:[],onRecordChange:noop,onRelease:noop})),name);
 });

 for(const {name,pkg} of packages)for(const observed of [false,true])it(`package map keeps approved route primitives in every state: ${name}, ${observed ? "planning" : "package editor"}`,()=>{
  const state=pkg();
  const first=state.controls[0]?.id??null;
  const linked=state.controls.find(control=>state.map.edges.some(edge=>edge.fromId===control.id||edge.toId===control.id))?.id??first;
  const family=state.controls[0]?.family??null;
  const states:Array<{label:string;selectedId:string|null;selectedFamilyId?:string|null;viewMode?:"family"|"selected";relatedEnabled?:boolean;initialShowMissing?:boolean}>=[
   {label:"nothing selected",selectedId:null},
   {label:"nothing selected, missing on",selectedId:null,initialShowMissing:true},
   {label:"family focus",selectedId:null,selectedFamilyId:family,relatedEnabled:true},
   {label:"control selected",selectedId:first,relatedEnabled:true},
   {label:"linked control selected",selectedId:linked,relatedEnabled:true,initialShowMissing:true},
   {label:"selected control view",selectedId:linked,viewMode:"selected",relatedEnabled:true},
  ];
  for(const view of states){
   const html=renderToStaticMarkup(createElement(PackageMap,{pkg:state,selectedId:view.selectedId,level2:false,selectedItemId:null,selectedFamilyId:view.selectedFamilyId,viewMode:view.viewMode,relatedEnabled:view.relatedEnabled,initialShowMissing:view.initialShowMissing,snapshotSelector:observed?createElement("span"):undefined,onSelect:noop,onEnterFocus:noop,onLeaveFocus:noop,onSelectItem:noop}));
   expectNoCurves(html,`${name} ${view.label}`);
  }
 });
});
