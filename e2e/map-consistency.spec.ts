import {test,expect,type Page} from "@playwright/test";
import {mkdirSync} from "node:fs";
import path from "node:path";
import {navigateWorkspace} from "./helpers/navigation";
import {settleMap,mapMembership,mapUnitGeometry,expectPlanningHub,expectPlanningFit} from './helpers/map-3b';
import {receivedRetest} from "../test/support/received-retest";
const systems=["none","example","pipeline","captured"] as const;
async function setup(page:Page,system:typeof systems[number],ssp:boolean){
 const evidence=receivedRetest();
 await page.route("**/api/pipeline/events",route=>route.fulfill({json:{ok:true,configured:false,webhookPath:"/api/pipeline/events",evidence,releases:[{evidence,receivedAt:evidence.createdAt}]}}));
 await page.goto("/planning?view=connections");
 if(system==="captured"){
  await page.getByRole("button",{name:"Load captured Online Boutique evidence",exact:true}).click();
  await expect(page.getByTestId("binder-summary").getByTestId("artifact-arrival-count")).toContainText("complete");
 }else if(system!=="none")await page.getByLabel("Evidence system").selectOption(system);
 await navigateWorkspace(page,"map");
 if(ssp){
  await navigateWorkspace(page,"export");
  await page.getByRole("button",{name:"Load sample SSP for this workspace",exact:true}).click();
  await expect(page.getByRole("button",{name:"New package",exact:true})).toBeVisible();
  await navigateWorkspace(page,"map");
 }
 await expect(page.getByTestId("package-map")).toHaveAttribute("data-layout-engine","round21");
}
for(const system of systems)for(const ssp of [false,true])for(const snapshot of ["newest","older","none"]){
 test(`${system} with SSP ${ssp} and snapshot ${snapshot} keeps map structure and interaction`,async({page},info)=>{
  test.setTimeout(180000);
  await page.setViewportSize({width:1920,height:1114});
  await setup(page,system,ssp);
  const map=page.getByTestId("package-map");
  await settleMap(page);
  const before=await mapMembership(page);
  const geometry=()=>mapUnitGeometry(page);
  const beforeGeometry=await geometry();
  const layers=await map.getByRole("button",{name:"SSP evidence",exact:true}).getAttribute("aria-pressed");
  if(system!=="none"){
   await map.locator(".round21-snapshot > summary").click();
   const options=map.getByRole("listbox",{name:"Map release selection"}).getByRole("option");
   if(snapshot==="none")await options.filter({hasText:/^.*None/}).first().click();
   else await options.nth(snapshot==="older"?1:await options.count()-1).click();
  }
  expect(await mapMembership(page)).toEqual(before);
  await expect.poll(geometry).toEqual(beforeGeometry);
  await expect(map.getByRole("button",{name:"SSP evidence",exact:true})).toHaveAttribute("aria-pressed",layers!);
  await expect(map.locator(".pmap-related-chip,.pmap-coverage-overview")).toHaveCount(0);
  if(system!=="none"){
   await expect(map.locator(".pipeline-file-picker > summary")).toBeVisible();
   for(const label of ["SSP evidence","Pipeline","Missing","Suggested"])await expect(map.getByRole("button",{name:label,exact:true})).toBeEnabled();
  }
  await expect(map.getByRole("button",{name:"Roles",exact:true})).toHaveCount(0);
  await expect(map.locator(".pmap-role,path[data-rel=role]")).toHaveCount(0);
  const dir=info.outputPath("map-captures");mkdirSync(dir,{recursive:true});
  const name=`${system}-ssp-${ssp}-${snapshot}`;
  await page.mouse.move(0,0);
  await page.screenshot({animations:"disabled",path:path.join(dir,`${name}-map.png`)});
  const cards=map.locator(".pmap-control");
  if(await cards.count()){
   await cards.first().click();
   const id=(await map.locator('.pmap-focus-hub').getAttribute('data-control-id'))!;
   await expectPlanningHub(page,id);
   expect(await mapMembership(page)).toEqual(before);
   expect(await geometry()).not.toEqual(beforeGeometry);
   await page.keyboard.press("Escape");await settleMap(page);
   expect(await mapMembership(page)).toEqual(before);
   await expect(map.locator(`[data-family-box="${id.split("-")[0]}"]`)).toHaveAttribute("data-focus","center");
   await expectPlanningFit(page);
  }
  const checked=new Set<string>();
  for(const id of before){
   const card=map.locator(`[data-control-id="${id}"]`);
   await card.hover();await expect(card).toHaveAttribute("data-hover","true");
   await card.click();await expectPlanningHub(page,id);checked.add(id);
   await page.mouse.move(0,0);
   const dots=card.locator("[data-control-dot]");
   if(await card.getAttribute("data-proposal-pill")==="true"){
    await expect(dots).toHaveCount(0);await expect(card.locator(".pmap-status-line")).toHaveText(/^[0-9]+ proposed$/);
    const badge=page.getByTestId('pipeline-control-panel').locator('.accordion-control-status .pill');
    const inherited=await card.getAttribute('data-provider-coverage')==='all';
    await expect(badge).toHaveText(inherited?'◆ Covered by provider':'◌ Proposed mapping · not accepted');
    await expect(badge).toHaveClass(inherited?/\bprovider\b/:/\bwarn\b/);
    await expect(badge).not.toHaveClass(/\bpass\b/);
   }else expect(await dots.count()).toBeGreaterThan(0);
   for(const dot of await dots.all()){
    await dot.hover();await expect(card).toHaveAttribute("data-hover","true");await expect(dot).toHaveCSS("box-shadow",/rgb\(106, 76, 255\).*2px/);
    await dot.click();await expect(card).toHaveAttribute("aria-pressed","true");await page.mouse.move(0,0);await expect(dot).toHaveAttribute("data-selected-dot","true");await expect(dot).toHaveCSS("box-shadow",/rgb\(106, 76, 255\).*2px/);
   }
  }
  expect([...checked].sort()).toEqual(before);
  if(!await cards.count()){await page.screenshot({animations:"disabled",path:path.join(dir,`${name}-click.png`)});await page.screenshot({animations:"disabled",path:path.join(dir,`${name}-family.png`)});return;}
  const target=map.locator('.pmap-control[data-control-id="CM-6"]');
  const control=await target.count()?target:cards.first();
  await control.click();await expectPlanningHub(page,(await control.getAttribute("data-control-id"))!);await page.mouse.move(0,0);
  const faded=map.locator('.pmap-control').filter({visible:true});
  await expect.poll(()=>faded.evaluateAll(nodes=>nodes.every(n=>[1,.5].includes(Number(getComputedStyle(n).opacity))))).toBe(true);
  await page.screenshot({animations:"disabled",path:path.join(dir,`${name}-click.png`)});
  await page.keyboard.press("Escape");await expect(map.locator('.pmap-control[aria-pressed="true"]')).toHaveCount(0);
  await map.getByRole("button",{name:"By family",exact:true}).click();
  const targetFamily=map.locator('[data-family-header="CM"]');
  const family=await targetFamily.count()?targetFamily:map.locator('[data-family-header]').first();
  await family.locator(".pmap-family-open").hover();
  await expect(map.locator(`[data-family-box="${await family.getAttribute("data-family-header")}"]`)).toHaveAttribute("data-hover","true");
  await page.screenshot({animations:"disabled",path:path.join(dir,`${name}-family.png`)});
  await page.mouse.move(0,0);
  for(const id of await map.locator("[data-family-header]").evaluateAll(nodes=>nodes.map(node=>node.getAttribute("data-family-header")!))){
   const header=map.locator(`[data-family-header="${id}"]`);
   await header.hover();await expect(map.locator(`[data-family-box="${id}"]`)).toHaveAttribute("data-hover","true");
   await header.locator(".pmap-family-open").click();await page.mouse.move(0,0);
   await expect(map.locator(`[data-family-box="${id}"]`)).toHaveAttribute("data-selected","true");
   await expect(map.locator(`[data-family-box="${id}"]`)).toHaveAttribute("data-focus","center");
   await expectPlanningFit(page);
   await page.keyboard.press("Escape");await settleMap(page);
  }
  if(system==="none"||system==="captured")await expect(map.locator('[title*="2908682168"]')).toHaveCount(0);
 });
}
