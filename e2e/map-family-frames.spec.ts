import {test,expect,type Page} from "@playwright/test";
import {settleMap,expectPlanningFit} from './helpers/map-3b';
import {loadRef2} from "./helpers/ref2";
import {importFixture} from "./helpers/map-fixtures";
import {expectFamilyFramesVisible,expectSelectedRelationsVisible,familyFrameVisibility} from "./helpers/family-frames";

// A selected or focused control is read against its family structure. Family frames,
// headers and names never fade; only unrelated control cards dim, and only to a legible level.

async function loadClassic(page:Page){
 const response=await page.request.post("/api/workspace/reset");
 expect(response.ok()).toBeTruthy();
 await page.goto("/workspace?editor=classic");
 await page.getByRole("radio",{name:/FedRAMP Rev5/}).check();
 await page.getByLabel("OSCAL package").setInputFiles("public/samples/sample-oscal-ssp-rev5.json");
 await page.getByRole("button",{name:"Upload OSCAL"}).click();
 await expect(page.getByText("1 of 12 incomplete").first()).toBeVisible();
 await page.mouse.move(2,2);
}

async function selectControl(page:Page,id:string){
 const card=page.getByTestId("package-map").locator(`.pmap-control[data-control-id="${id}"]`);
 await card.click();await expect(card).toHaveAttribute("aria-pressed","true");
 await page.mouse.move(0,0);
 await settleMap(page);
 await expectSelectedRelationsVisible(page,id);
 if(await page.getByTestId('package-map').getAttribute('data-layout-engine')==='round21')await expectPlanningFit(page);
}

/** Every control on the map, selected one at a time, keeps every family frame and header visible. */
async function selectEach(page:Page,limit=Infinity){
 const ids=(await familyFrameVisibility(page)).cards.filter(card=>!card.selected).map(card=>card.id).slice(0,limit);
 expect(ids.length).toBeGreaterThan(0);
 for(const id of ids)await selectControl(page,id);
}

test.describe("classic package map",()=>{
 test.use({viewport:{width:1440,height:900}});
 test("Selected control keeps family frames, headers and related cards visible",async({page})=>{
  await loadClassic(page);
  const map=page.getByTestId("package-map");
  await expect(page.getByRole("button",{name:"Related",exact:true})).toHaveAttribute("aria-pressed","true");
  await page.getByRole("button",{name:"Selected control"}).click();
  await selectControl(page,"AC-2");
  await expect(map.locator('svg.pmap-wires path[data-rel="related"]').first()).toBeAttached();
  await selectEach(page);
  await page.keyboard.press("Escape");
  await page.getByRole("button",{name:"By family"}).click();
  await selectControl(page,"CM-6");
 });
 test("hovered control and hovered family keep family frames visible",async({page})=>{
  await loadClassic(page);
  const map=page.getByTestId("package-map");
  await map.getByRole("button",{name:/AC-2 Account Management/}).hover();
  await expect.poll(()=>map.locator('svg.pmap-wires path[data-rel="related"]').count()).toBeGreaterThan(0);
  await expectFamilyFramesVisible(page);
  await page.mouse.move(2,2);
  const box=(await map.locator('[data-family-box="AC"]').boundingBox())!;
  await page.mouse.move(box.x+box.width/2,box.y+5);
  await expect(map.locator('[data-family-box="AC"]')).toHaveAttribute("data-hover","true");
  await expectFamilyFramesVisible(page);
 });
});

for(const width of [1280,1440,1920])test(`reference map at ${width} keeps family structure visible while a control or family is focused`,async({page})=>{
 test.setTimeout(180000);
 await page.setViewportSize({width,height:width===1280?800:width===1440?900:1114});
 await loadRef2(page);
 await selectControl(page,"CM-6");
 await selectEach(page);
 await page.keyboard.press("Escape");
 await page.locator('[data-family-header="CM"] .pmap-family-open').hover();
 await expect(page.locator("[data-family-focus]")).toHaveCount(0); // BUI-024 removes the amber outline.
 await expect(page.locator('[data-family-box="CM"]')).toHaveAttribute("data-hover","true");
 await expectFamilyFramesVisible(page);
});

test("huge generated map keeps family structure visible after selecting a control",async({page})=>{
 test.setTimeout(180000);
 await page.setViewportSize({width:1440,height:900});
 await importFixture(page,"huge");
 await selectControl(page,"CM-6");
 await selectEach(page,40);
});
