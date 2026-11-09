import {test,expect,type Browser,type Page} from "@playwright/test";
import {navigateWorkspace} from "./helpers/navigation";
import {importFixture} from "./helpers/map-fixtures";
test.use({trace:"off",video:"off"});

// No map line is ever drawn as a curve: not closed, not on hover, family focus, selection,
// any layer toggle, Level 2 or evidence focus, in any workspace or evidence source. Sources
// and workspaces are read from the page, so new ones are covered without editing this file.
// A mutation observer checks every path the moment it is drawn, so passing states count too.

const SCOPE=['[data-testid="map-stage"]','[data-testid="package-map"]','[data-testid="rollup-map-workspace"]','[data-testid="level2-focus"]','[data-testid="statement-focus"]','[data-testid="evidence-focus"]','[data-testid="pipeline-artifact-focus"]','[data-testid="map-role-focus"]'].join(",");

function watchLines(scope:string){
 type P={x:number;y:number};
 const w=window as unknown as {__mapCurves:unknown[];__mapLines:number};
 w.__mapCurves=[];w.__mapLines=0;
 const curves=(d:string,axis:boolean)=>{
  const tokens=d.match(/[a-zA-Z]|-?\d*\.?\d+(?:e[+-]?\d+)?/g)??[];
  let i=0,cmd="",cur:P={x:0,y:0},start:P={x:0,y:0};
  const num=()=>Number(tokens[i++]);
  const on=(p:P,a:P,b:P)=>Math.abs((b.x-a.x)*(p.y-a.y)-(b.y-a.y)*(p.x-a.x))<=.01*Math.max(1,Math.hypot(b.x-a.x,b.y-a.y));
  const square=(a:P,b:P)=>!axis||Math.abs(a.x-b.x)<.01||Math.abs(a.y-b.y)<.01;
  while(i<tokens.length){
   if(/[a-zA-Z]/.test(tokens[i]))cmd=tokens[i++];
   const rel=cmd!==cmd.toUpperCase();
   const at=(x:number,y:number):P=>rel?{x:cur.x+x,y:cur.y+y}:{x,y};
   switch(cmd.toUpperCase()){
    case "M":cur=start=at(num(),num());cmd=rel?"l":"L";break;
    case "L":{const p=at(num(),num());if(!square(cur,p))return `diagonal to ${p.x},${p.y}`;cur=p;break;}
    case "H":{const x=num();cur={x:rel?cur.x+x:x,y:cur.y};break;}
    case "V":{const y=num();cur={x:cur.x,y:rel?cur.y+y:y};break;}
    case "Z":if(!square(cur,start))return "diagonal close";cur=start;break;
    case "C":{const b=at(num(),num()),c=at(num(),num()),e=at(num(),num());if(!on(b,cur,e)||!on(c,cur,e))return `curve to ${e.x},${e.y}`;if(!square(cur,e))return `diagonal to ${e.x},${e.y}`;cur=e;break;}
    default:return `${cmd} command`;
   }
  }
  return null;
 };
 const seen=new WeakMap<Element,string>();
 const check=(node:Element)=>{
  if(!(node instanceof SVGPathElement)||!node.closest(scope)||node.closest("marker,defs,symbol,clipPath,mask,pattern"))return;
  const d=node.getAttribute("d");if(!d||seen.get(node)===d)return;
  seen.set(node,d);
  w.__mapLines+=1;
  const wire=Boolean(node.closest(".pmap-wires,.pmap-pipeline-wires")||node.dataset.rel||node.dataset.pipelineArtifact);
  const why=curves(d,wire);
  if(why)w.__mapCurves.push({why,rel:node.dataset.rel??null,cls:node.getAttribute("class"),d:d.slice(0,160),where:location.pathname+location.search});
 };
 const sweep=(root:Node)=>{if(root instanceof Element){check(root);root.querySelectorAll("path").forEach(check);}};
 new MutationObserver(records=>{for(const record of records){
  if(record.type==="attributes")sweep(record.target);
  else record.addedNodes.forEach(sweep);
 }}).observe(document,{subtree:true,childList:true,attributes:true,attributeFilter:["d","class","data-rel"]});
 document.addEventListener("DOMContentLoaded",()=>sweep(document.documentElement));
 (window as unknown as {__sweepLines:()=>void}).__sweepLines=()=>sweep(document.documentElement);
}

async function open(browser:Browser){
 const context=await browser.newContext({viewport:{width:1440,height:900}});
 await context.addInitScript(watchLines,SCOPE);
 return {context,page:await context.newPage()};
}
async function report(page:Page){
 return page.evaluate(()=>{const w=window as unknown as {__mapCurves:unknown[];__mapLines:number;__sweepLines:()=>void};w.__sweepLines();return {curves:w.__mapCurves,lines:w.__mapLines};});
}
async function expectNoCurves(page:Page,label:string){
 const {curves,lines}=await report(page);
 expect(lines,`${label}: lines were drawn`).toBeGreaterThan(0);
 expect(curves,`${label}: curved map lines`).toEqual([]);
}
const click=async(page:Page,selector:string,options:{dbl?:boolean}={})=>{
 const target=page.locator(selector).first();
 if(!await target.count()||!await target.isVisible())return false;
 await target.scrollIntoViewIfNeeded();
 if(options.dbl)await target.dblclick();else await target.click();
 await page.waitForTimeout(120);
 return true;
};

/** Every map state a reviewer can reach from the closed map. */
async function exercise(page:Page,label:string){
 const map=page.getByTestId("package-map");
 await expect(map).toBeVisible();
 await page.mouse.move(1,1);await page.waitForTimeout(300);
 await expectNoCurves(page,`${label} closed`);
 const toggles=map.locator(".pmap-toggles button:not([disabled])");
 const cycleToggles=async()=>{for(let i=0;i<await toggles.count();i+=1){await toggles.nth(i).click();await page.waitForTimeout(80);await toggles.nth(i).click();await page.waitForTimeout(80);}};
 await cycleToggles();
 for(const box of (await map.locator("[data-family-box]").all()).slice(0,4)){
  const rect=await box.boundingBox();if(!rect)continue;
  await page.mouse.move(rect.x+rect.width/2,rect.y+5);await page.waitForTimeout(150);
 }
 if(await click(page,'[data-testid="package-map"] .pmap-family-open')){await cycleToggles();await page.keyboard.press("Escape");await page.mouse.move(1,1);}
 const controls=map.locator(".pmap-control");
 const count=await controls.count();
 for(const index of count ? [...new Set([0,Math.floor(count/2),count-1])] : []){
  const control=controls.nth(index);
  await control.scrollIntoViewIfNeeded();await control.hover();await page.waitForTimeout(120);
  await control.click();await page.waitForTimeout(200);
  await cycleToggles();
  if(await click(page,'[data-testid="package-map"] .pmap-modes button:has-text("Selected control")'))await click(page,'[data-testid="package-map"] .pmap-modes button:has-text("By family")');
 }
 for(const selector of [".pmap-role",".pmap-evidence",".pmap-pill","[data-pipeline-file]"]){
  const item=map.locator(selector).first();
  if(await item.count()&&await item.isVisible()){await item.hover();await page.waitForTimeout(120);await item.click().catch(()=>{});await page.waitForTimeout(150);await page.keyboard.press("Escape");}
 }
 if(count){
  await controls.first().scrollIntoViewIfNeeded();await controls.first().dblclick();
  const focus=page.getByTestId("level2-focus");
  if(await focus.isVisible().catch(()=>false)){
   await page.waitForTimeout(300);
   await click(page,'[data-testid="level2-focus"] [data-testid^="statement-"][aria-pressed]');
   if(await click(page,'button:has-text("Inspect evidence details")'))await page.keyboard.press("Escape");
   await click(page,'[data-testid="level2-back"]');
  }
 }
 await expectNoCurves(page,label);
}

test("the line watcher reports a curve drawn on the map",async({browser})=>{
 const {context,page}=await open(browser);
 await page.goto("/planning");
 await page.getByLabel("Evidence system").selectOption("example");
 await navigateWorkspace(page,"map");
 await expect(page.getByTestId("package-map")).toBeVisible();
 await page.locator("svg.pmap-wires").first().evaluate(svg=>{
  const add=(d:string)=>{const path=document.createElementNS("http://www.w3.org/2000/svg","path");path.setAttribute("d",d);path.dataset.rel="role";svg.append(path);return path;};
  add("M 0 0 C 0 40, 40 0, 40 40");
  add("M 0 0 L 0 10").setAttribute("d","M 0 0 Q 20 20 40 0");
  add("M 0 0 L 30 30");
 });
 expect((await report(page)).curves.map(curve=>(curve as {why:string}).why)).toEqual([expect.stringMatching(/^curve/),expect.stringMatching(/^Q command/),expect.stringMatching(/^diagonal/)]);
 await context.close();
});

test("every evidence source in the planning workspace draws only right-angled lines",async({browser})=>{
 test.setTimeout(600_000);
 const probe=await open(browser);
 await probe.page.goto("/planning");
 const options=await probe.page.getByLabel("Evidence system").locator("option").evaluateAll(nodes=>nodes.map(node=>({value:(node as HTMLOptionElement).value,label:node.textContent?.trim()??""})));
 await probe.context.close();
 expect(options.length,"evidence sources").toBeGreaterThan(1);
 for(const option of options)await test.step(`${option.label || "uploaded package"} (${option.value || "none"})`,async()=>{
  const {context,page}=await open(browser);
  await page.goto("/planning");
  await page.getByLabel("Evidence system").selectOption(option.value);
  await navigateWorkspace(page,"map");
  await exercise(page,option.label||option.value);
  await context.close();
 });
});

test("every workspace view with a map draws only right-angled lines",async({browser})=>{
 test.setTimeout(600_000);
 const probe=await open(browser);
 await probe.page.goto("/planning");
 await probe.page.getByLabel("Evidence system").selectOption("example");
 const nav=probe.page.getByTestId("workspace-navigation");
 const more=nav.getByRole("button",{name:"More",exact:true});
 if(await more.count())await more.click();
 const views=await nav.locator("[data-view]").evaluateAll(nodes=>[...new Set(nodes.map(node=>(node as HTMLElement).dataset.view!))]);
 await probe.context.close();
 let mapped=0;
 for(const view of views)await test.step(view,async()=>{
  const {context,page}=await open(browser);
  await page.goto("/planning");
  await page.getByLabel("Evidence system").selectOption("example");
  await navigateWorkspace(page,view);
  await page.waitForTimeout(500);
  if(await page.getByTestId("package-map").isVisible()){mapped+=1;await exercise(page,`view ${view}`);}
  else expect((await report(page)).curves,`view ${view}`).toEqual([]);
  await context.close();
 });
 expect(mapped,"views with a map").toBeGreaterThan(0);
});

const loads:Record<string,(page:Page)=>Promise<void>>={
 "Online Boutique captured evidence":async page=>{
  await page.goto("/planning?view=connections");
  await page.getByRole("button",{name:"Load captured Online Boutique evidence",exact:true}).click();
  await expect(page.getByTestId("binder-summary").getByTestId("artifact-arrival-count")).toContainText("complete");
  await navigateWorkspace(page,"map");
 },
 "uploaded OSCAL package":async page=>{
  await page.route("**/api/pipeline/events",route=>route.fulfill({json:{ok:true,configured:false,evidence:null,releases:[]}}));
  await page.goto("/planning");await navigateWorkspace(page,"map");
  await page.getByRole("radio",{name:/FedRAMP Rev5/}).check();
  await page.getByLabel("OSCAL package").setInputFiles("public/samples/sample-oscal-ssp-rev5.json");
  await page.getByRole("button",{name:"Upload OSCAL",exact:true}).click();
  await expect(page.getByRole("button",{name:"New package",exact:true})).toBeVisible();
  await navigateWorkspace(page,"map");
 },
 "generated pipeline import":async page=>{await importFixture(page,"medium");},
 "release review":async page=>{
  await page.goto("/planning?view=release");
  await page.getByLabel("Evidence system").selectOption("example");
  await navigateWorkspace(page,"map");
 },
 "package editor sample":async page=>{
  await page.goto("/workspace?editor=classic");
  await page.getByRole("radio",{name:/FedRAMP Rev5/}).check();
  await page.getByLabel("OSCAL package").setInputFiles("public/samples/sample-oscal-ssp-rev5.json");
  await page.getByRole("button",{name:"Upload OSCAL"}).click();
  await expect(page.getByText("1 of 12 incomplete").first()).toBeVisible();
 },
 "package editor gold fixture":async page=>{
  await page.goto("/workspace?editor=classic");
  await page.getByRole("radio",{name:/FedRAMP Rev5/}).check();
  await page.getByRole("button",{name:"Load demo sample package"}).click();
  await expect(page.getByText("3 of 12 incomplete").first()).toBeVisible();
 },
};
for(const [name,load] of Object.entries(loads))test(`${name} draws only right-angled lines`,async({browser})=>{
 test.setTimeout(300_000);
 const {context,page}=await open(browser);
 await load(page);
 await exercise(page,name);
 await context.close();
});
