import {referenceAuthorizationPlan,referencePlanCount} from "./helpers/collector-reference";
import {test,expect} from "@playwright/test";
import {navigateWorkspace} from "./helpers/navigation";
test("approved release overview retains workspace plans when no release is selected and draws actual catalog peers",async({page})=>{
  await page.goto("/planning?view=connections");await page.getByRole("button",{name:"Load captured Online Boutique evidence"}).click();await navigateWorkspace(page,"release");
  await expect(page.locator(".baseline-footprint-grid>button")).toHaveCount(18);
  await expect(page.locator("[data-family-box]")).toHaveCount(0);
  await expect(page.getByTestId("proposed-plans").getByRole("button")).toHaveCount(referencePlanCount);
  await page.getByLabel("Release selection",{exact:true}).selectOption("");
  await expect(page.getByRole("heading",{name:"No release selected",exact:true})).toBeVisible();
  await expect(page.locator(".release-chain")).toHaveCount(0);
  await expect(page.locator(".baseline-footprint")).toContainText("Workspace footprint");
  await expect(page.locator(".baseline-footprint-grid>button")).toHaveCount(18);
  await expect(page.getByTestId("proposed-plans").getByRole("button")).toHaveCount(referencePlanCount);
  await page.getByRole("button",{name:referenceAuthorizationPlan}).click();await expect(page.getByTestId("plan-proposal")).toContainText("was authorized to get Kubernetes Secrets");await expect(page.getByRole("button",{name:"Confirm closure",exact:true})).toBeDisabled();await page.getByRole("button",{name:"Close proposed plan"}).click();
  await navigateWorkspace(page,"map");await page.getByRole("checkbox",{name:"Show untouched controls"}).check();await page.getByRole("button",{name:"Open AC family details",exact:true}).click();await expect(page.getByTestId("map-family-panel")).toContainText("1 linked");await expect(page.getByTestId("map-family-panel")).toContainText("42 blank");await page.getByRole("button",{name:"Close family panel"}).click();await page.locator('[data-control-id="AC-6"]').click();await expect(page.locator("[data-related-control]")).toHaveCount(23);await expect(page.locator('[data-control-id="AC-6"]')).toContainText("Needs review");
  await expect(page.getByTestId("pipeline-control-panel")).toContainText("23 in 9 families");
  await expect(page.locator('[data-rel="related"]')).toHaveCount(23);
  await expect(page.getByRole("heading",{name:"Package map",exact:true})).toBeVisible();
  const note=await page.getByTestId("map-fail-banner").boundingBox(),toolbar=await page.locator(".pmap-toolbar").boundingBox(),roles=await page.getByRole("button",{name:"Roles",exact:true}).boundingBox();
  expect(note!.y).toBeGreaterThanOrEqual(toolbar!.y);expect(note!.y+note!.height).toBeLessThanOrEqual(toolbar!.y+toolbar!.height);expect(note!.x+note!.width).toBeLessThan(roles!.x);
  const planAction=await page.getByTestId("proposed-plan-summary").getByRole("button").boundingBox(),footer=await page.locator(".pipeline-control-footer").boundingBox();
  expect(planAction!.y+planAction!.height).toBeLessThanOrEqual(footer!.y);expect(planAction!.y).toBeLessThan(800);
  await page.locator(".control-retest").filter({hasText:"Captured PASS"}).scrollIntoViewIfNeeded();
  // Browser scroll offsets round to CSS pixels; allow only subpixel border rounding.
  const retest=await page.locator(".control-retest").filter({hasText:"Captured PASS"}).boundingBox();expect(retest!.y+retest!.height).toBeLessThanOrEqual((await page.locator(".control-plan-pinned").boundingBox())!.y+0.5);
  await expect(page.getByRole("button",{name:"Selected control",exact:true})).toBeInViewport();
  await page.screenshot({path: test.info().outputPath("design-map-final.png")});
  expect(await page.locator('[data-rel="related"]').evaluateAll(paths=>new Set(paths.map(p=>p.getAttribute("d"))).size)).toBe(23);
  const collisions=await page.locator(".pmap-layer").evaluate(layer=>{
    const chips=Array.from(layer.querySelectorAll<HTMLElement>("[data-related-control]")).map(el=>({id:el.dataset.relatedControl!,x:parseFloat(el.style.left),y:parseFloat(el.style.top),w:parseFloat(el.style.width),h:parseFloat(el.style.height)}));
    return Array.from(layer.querySelectorAll<SVGPathElement>('[data-rel="related"]')).flatMap(path=>{
      const total=path.getTotalLength(),owners=[path.getAttribute("data-from"),path.getAttribute("data-to")];
      for(let i=1;i<150;i++){const p=path.getPointAtLength(total*i/150);const hit=chips.find(c=>!owners.includes(c.id)&&p.x>c.x+2&&p.x<c.x+c.w-2&&p.y>c.y+2&&p.y<c.y+c.h-2);if(hit)return[{from:owners[0],to:owners[1],crossed:hit.id,d:path.getAttribute("d"),hit}];}return[];
    });
  });expect(collisions).toEqual([]);
  await page.locator('[data-control-id="AC-6"]').dblclick();await page.locator('[data-item-id="ac-6_smt"]').click();
  await expect(page.getByTestId("focus-enhancements")).toContainText("6 enhancements");await expect(page.locator(".observed-enhancement-list button")).toHaveCount(6);
  await page.getByRole("button",{name:"Inspect evidence details",exact:true}).click();
  await expect(page.getByTestId("evidence-focus")).toContainText("authorization-review.json");
  await expect(page.getByTestId("evidence-focus")).toContainText("No statement mappings");
  await expect(page.getByRole("link",{name:"Open retained evidence viewer ↗"})).toHaveAttribute("href",/^\/evidence\/[a-f0-9]{64}\?/);
  await expect(page.locator(".observed-digest")).toHaveText(/^[a-f0-9]{64}$/);
  const download=await page.getByRole("link",{name:"Download original artifact",exact:true}).boundingBox(),artifactPanel=await page.getByLabel("Selected retained artifact",{exact:true}).boundingBox();
  expect(download!.y+download!.height).toBeLessThanOrEqual(artifactPanel!.y+artifactPanel!.height);
  await page.getByRole("button",{name:/← AC-6 · Level 2/}).click();await expect(page.locator('[data-item-id="ac-6_smt"]')).toHaveAttribute("aria-pressed","true");
  await navigateWorkspace(page,"export");await page.getByRole("button",{name:"Upload SSP on Package map →",exact:true}).click();await expect(page.getByRole("heading",{name:"Load an OSCAL package"})).toBeVisible();await expect(page.getByLabel("Evidence system")).not.toHaveValue("");await page.getByRole("button",{name:"← Return to Package map",exact:true}).click();await expect(page.getByTestId("rollup-map-workspace")).toBeVisible();
});

test("expanded empty-start choices remain above the footer",async({page})=>{
  await page.goto("/planning");await page.getByText("More starting points").click();
  await expect(page.locator(".empty-start")).toHaveCount(3);
  const last=await page.locator(".empty-start").last().boundingBox(),footer=await page.locator(".chrome-footer").boundingBox();
  expect(last!.y+last!.height).toBeLessThanOrEqual(footer!.y);
});
