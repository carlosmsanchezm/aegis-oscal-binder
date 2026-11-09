import {XMLParser} from "fast-xml-parser";
import {test,expect,type Page} from "@playwright/test";
import {readFile,writeFile} from "node:fs/promises";
import {navigateWorkspace} from "./helpers/navigation";
import {measureMapRoutes} from "./helpers/map-routes";
import {CCM_EXAMPLE} from "../lib/aegis/pipeline-evidence";
const sizes=[{width:1280,height:800},{width:1366,height:768},{width:1440,height:900}];
async function load(page:Page,system:"podinfo"|"boutique") {
 await page.goto("/planning?view=connections");
 await page.getByRole("button",{name:system==="podinfo"?"Load captured Podinfo evidence":"Load captured Online Boutique evidence",exact:true}).click();
 await expect(page.getByTestId("binder-summary")).toBeVisible();
 await expect(page.getByTestId("binder-summary").getByTestId("artifact-arrival-count")).toContainText("complete");
}
for(const size of sizes)for(const system of ["podinfo","boutique"] as const)test(`${system} ${size.width}: pinned facts, matching map, retained arrival, scoped plan and both OSCAL exports`,async({page},info)=>{
 await page.setViewportSize(size);await load(page,system);
 const summary=page.getByTestId("binder-summary"),total=system==="podinfo"?274:197;
 await expect(summary.getByTestId("artifact-arrival-count")).toContainText(`${total} artifacts loaded`);
 const summaryFamilies=Number(await summary.getByTestId("summary-family-coverage").getAttribute("data-touched-families"));expect(summaryFamilies).toBe(11);
 const box=await summary.boundingBox();expect(box!.height).toBeLessThanOrEqual(312);
 await summary.locator("summary").filter({hasText:"Kubernetes workloads"}).click();
 await expect(summary.locator("[data-summary-artifact]").filter({hasText:"extracted facts"}).first()).toBeAttached();
 const group=summary.locator(":scope > details").filter({has:page.locator("summary",{hasText:"Kubernetes workloads"})});
 const rows=group.locator("[data-summary-artifact]").filter({hasText:/[1-9]\d* extracted facts/});
 await rows.first().locator("details > summary").click();await expect(rows.first()).toContainText(/sha256:[a-f0-9]{64}/);await expect(rows.first()).toContainText(/\.ya?ml:\d+/);
 await summary.locator("summary").filter({hasText:"Kubernetes workloads"}).click();
 const out=process.env.COLLECTOR_EVIDENCE;
 async function screenshot(scene:string){await page.screenshot({path:out?`${out}/${system}-${size.width}x${size.height}-${scene}.png`:info.outputPath(`${scene}.png`)});}
 await summary.evaluate(el=>el.scrollTop=0);await screenshot("summary");await navigateWorkspace(page,"map");
 await expect(page.getByRole("checkbox",{name:"Show untouched controls"})).not.toBeChecked();
 await expect(page.locator("[data-family-box]")).toHaveCount(summaryFamilies);
 expect(await page.locator("[data-family-proposals]").count()).toBeGreaterThanOrEqual(8);
 const readability=await page.locator(".pmap-layer").evaluate(layer=>{const zoom=Number(getComputedStyle(layer).zoom);return [...layer.querySelectorAll(".cid,[data-family-proposals]")].map(e=>parseFloat(getComputedStyle(e).fontSize)*zoom);});
 expect(Math.min(...readability)).toBeGreaterThanOrEqual(8);
 const clipped=await page.locator(".pmap-control,[data-proposal-control],[data-family-header]").evaluateAll(cards=>cards.flatMap(card=>
  [...card.querySelectorAll<HTMLElement>(".cid,.pmap-review-state,.pmap-status-line,.pmap-lane-top,em,.pmap-within,.t1,.t2")].filter(element=>{
   const style=getComputedStyle(element);
   return (style.overflowX==="hidden"||style.overflowX==="clip")&&element.scrollWidth>element.clientWidth+1
     ||(style.overflowY==="hidden"||style.overflowY==="clip")&&element.scrollHeight>element.clientHeight+1;
  }).map(element=>({control:card.getAttribute("data-control-id")??card.getAttribute("data-family-header"),text:element.textContent}))
 ));expect(clipped).toEqual([]);
 await screenshot("map");
 const sourceTile=page.locator(`[data-control-id="${system==="podinfo"?"SR-3":"SC-7"}"]`);await expect(sourceTile).toHaveAttribute("data-proposal-control",/.+/);await expect(sourceTile.locator(".pmap-status-line")).toHaveAttribute("title",/proposed artifact mappings, not accepted/);await sourceTile.click();await expect(page.getByTestId("control-proposed-evidence")).toContainText("person approves");await page.getByRole("button",{name:"Close panel",exact:true}).click();
 await navigateWorkspace(page,"release");await expect(summary.getByTestId("artifact-arrival-count")).toContainText(`${total} artifacts loaded · complete`);
 await navigateWorkspace(page,"map");
 const id=system==="podinfo"?"CM-6":"AC-6";await page.locator(`[data-control-id="${id}"]`).click();await page.getByTestId("pipeline-control-panel").getByRole("button",{name:"Open plan of action",exact:true}).first().click();
 const drawer=page.getByTestId("plan-proposal");await drawer.getByRole("button",{name:"Accept proposed draft",exact:true}).click();
 if(system==="podinfo") {await drawer.getByLabel("Closure name").fill("Local collector reviewer");await drawer.getByLabel("Closure reason").fill("Reviewed the three captured passing measurements for this exact scope.");await drawer.getByRole("button",{name:"Confirm closure",exact:true}).click();await expect(page.locator('[data-control-id="CM-6"]')).toContainText("Closed");await expect(page.locator(".pipeline-control-review")).toContainText("Closed");}
 else {await expect(drawer).toContainText("retest expired");await expect(drawer.getByRole("button",{name:"Confirm closure",exact:true})).toBeDisabled();}
 await screenshot(system==="podinfo"?"closed":"expired");
 let pending=page.waitForEvent("download");await drawer.getByRole("button",{name:"Download OSCAL plan of action"}).click();let downloaded=await pending;let raw=await readFile((await downloaded.path())!,"utf8");
 const poam=JSON.parse(raw)["plan-of-action-and-milestones"];expect(poam.risks[0].status).toBe(system==="podinfo"?"closed":"open");if(out)await writeFile(`${out}/${system}-${size.width}-poam.json`,raw);
 await drawer.getByRole("button",{name:"Close proposed plan"}).click();await navigateWorkspace(page,"export");await page.getByRole("button",{name:"Load sample SSP for this workspace"}).click();await expect(page.getByRole("button",{name:"New package",exact:true})).toBeVisible();
 pending=page.waitForEvent("download");await page.getByRole("button",{name:"Export OSCAL",exact:true}).click();downloaded=await pending;raw=await readFile((await downloaded.path())!,"utf8");const xml=raw.trimStart().startsWith("<");expect((xml?new XMLParser({ignoreAttributes:false}).parse(raw):JSON.parse(raw))["system-security-plan"]).toBeTruthy();if(out)await writeFile(`${out}/${system}-${size.width}-ssp.${xml?"xml":"json"}`,raw);
});
test("an earlier source batch is reviewable, accepts only the reviewed control, and retains receipt identity",async({page})=>{
 await load(page,"boutique");
 const panel=page.getByTestId("mapping-proposals");await panel.getByLabel("Find a proposed file").fill("network-policy-frontend.yaml");
 const row=panel.locator("[data-proposal-artifact]").first();await expect(row).toContainText("network-policy-frontend.yaml");await row.getByText("Why these controls?",{exact:true}).click();await expect(row).toContainText(/network-policy-frontend\.yaml:\d+/);
 const name=await row.getAttribute("data-proposal-artifact");await panel.getByLabel("Mapping reviewer").fill("Local applicability reviewer");await row.getByLabel(`Control to accept for ${name}`).selectOption("SC-7");await row.getByRole("button",{name:`Accept mapping for ${name}`}).click();await expect(row).toHaveAttribute("data-decision","accepted");
 await navigateWorkspace(page,"map");await expect(page.locator('[data-control-id="SC-7"]')).toContainText("linked");await page.reload();await navigateWorkspace(page,"release");await panel.getByLabel("Find a proposed file").fill("network-policy-frontend.yaml");await expect(panel.locator(`[data-proposal-artifact="${name}"]`)).toContainText("Local applicability reviewer · SC-7");
});
test("returning to Release evidence retains the arrival count immediately",async({page})=>{
 await page.goto("/planning");await page.getByLabel("Evidence system").selectOption("example");
 const count=page.getByTestId("binder-summary").getByTestId("artifact-arrival-count");await expect(count).toContainText("complete");const completed=await count.innerText();await navigateWorkspace(page,"map");await navigateWorkspace(page,"release");await expect(count).toBeVisible();expect(await count.innerText()).toBe(completed);
});
test("confirmed closure labels the side panel and tile consistently",async({page})=>{
 await page.goto("/planning");await page.getByLabel("Evidence system").selectOption("example");await navigateWorkspace(page,"map");await page.locator('[data-control-id="CM-6"]').click();await page.getByTestId("pipeline-control-panel").getByRole("button",{name:"Open plan of action",exact:true}).first().click();const drawer=page.getByTestId("plan-proposal");await drawer.getByRole("button",{name:"Accept proposed draft",exact:true}).click();await drawer.getByLabel("Closure name").fill("Local reviewer");await drawer.getByLabel("Closure reason").fill("Checked all passing measurements for the original scope.");await drawer.getByRole("button",{name:"Confirm closure",exact:true}).click();await expect(page.locator('[data-control-id="CM-6"]')).toContainText("Closed");await expect(page.locator(".pipeline-control-review")).toHaveText("Closed · 1 open");
});

test("compact coverage keeps room for family hover routes and uses the established family focus layout",async({page})=>{
 await page.setViewportSize({width:1366,height:768});await load(page,"boutique");await navigateWorkspace(page,"map");
 await expect(page.getByTestId("package-map")).toHaveAttribute("data-layout-engine","round21");
 await page.locator('[data-family-header="AC"]').hover();
 await expect(page.locator('path[data-rel="related"],path[data-rel="family-bundle"]')).toHaveCount(0);
 await expect(page.locator('[data-family-focus]')).toHaveCount(0); // BUI-024 removes the amber outline.
 await expect(page.locator('[data-family-box="AC"]')).toHaveAttribute('data-selected','true');
 expect((await measureMapRoutes(page)).problems).toEqual([]);
 await page.getByRole("button",{name:"Open AC family details",exact:true}).click();await page.mouse.move(0,0);
 await expect(page.locator(".pmap-coverage-overview")).toHaveCount(0);
 await expect(page.locator('path[data-rel="related"],path[data-rel="family-bundle"]')).toHaveCount(0);
 await expect(page.locator('[data-family-focus]')).toHaveCount(0); // BUI-024 removes the amber outline.
 await expect(page.locator('[data-family-box="AC"]')).toHaveAttribute('data-selected','true');
});
