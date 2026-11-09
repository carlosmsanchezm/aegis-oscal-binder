import {test,expect} from "@playwright/test";
import {loadRef2} from "./helpers/ref2";
import {navigateWorkspace} from "./helpers/navigation";
import {importFixture} from "./helpers/map-fixtures";
import {CCM_EXAMPLE,summaryForSession} from "../lib/aegis/pipeline-evidence";

test("approved release control index, queue and accordion preserve their actions",async({page})=>{
 await loadRef2(page);
 const band=page.getByTestId('map-next-work');
 const firstChip=band.locator('.map-next-chip').first();
 await firstChip.focus();
 await page.keyboard.press('Tab');
 await page.keyboard.press('Shift+Tab');
 await expect(firstChip).toBeFocused();
 await expect.poll(()=>firstChip.evaluate(node=>getComputedStyle(node,'::after').display)).toBe('block');
 await band.getByRole('button',{name:'Full queue'}).click();
 await expect(page.locator('#map-ranked-queue li')).toHaveCount(309);
 await page.locator('#map-ranked-queue .map-next-chip').first().click({trial:true});
 await page.keyboard.press('Escape');
 await expect(page.getByRole('button',{name:'Full queue'})).toBeFocused();
 await page.locator('[data-control-id="CM-6"]').click();
 const panel=page.getByTestId('pipeline-control-panel');
 await expect(panel.locator('[data-side="next"] .control-action-rows article')).toHaveCount(2);
 await band.getByRole('button',{name:'Full queue'}).click();
 const queueBox=await page.locator('#map-ranked-queue').boundingBox(),panelBox=await panel.boundingBox();
 expect(queueBox!.x+queueBox!.width).toBeLessThanOrEqual(panelBox!.x);
 await page.keyboard.press('Escape');
 const evidence=panel.getByRole('button',{name:/Evidence.*file/});
 await evidence.click();await expect(evidence).toHaveAttribute('aria-expanded','true');
 await expect(panel.getByRole('button',{name:/Next action/})).toHaveAttribute('aria-expanded','false');
 const header=await panel.locator('.panel-head').boundingBox();
 const artifact=await page.locator('.map-release-focus').boundingBox();
 expect(header!.x).toBeGreaterThanOrEqual(artifact!.x+artifact!.width-1);
 await navigateWorkspace(page,'release');
 const summary=page.getByTestId('binder-summary');
 await expect(summary.getByTestId('artifact-arrival-count')).toHaveText('274 files collected · complete');
 await expect(summary.locator('.binder-summary-tiles,.binder-count-row')).toHaveCount(0);
 await summary.getByRole('button',{name:'Evidence for CM-6',exact:true}).click();
 const drill=summary.getByLabel('CM-6 evidence details');
 await expect(drill.getByRole('button',{name:'Confirm closure'})).toBeVisible();
 await expect(drill.getByRole('button',{name:'Review plan'})).toBeVisible();
 await expect(drill.getByRole('button',{name:'Accept as evidence'})).toHaveCount(1);
 await expect(drill).toContainText('Dockerfile');
 await drill.getByRole('button',{name:/Show .* more suggested files/}).click();
 await expect(drill.getByRole('button',{name:'Accept as evidence'}).first()).toBeDisabled();
 await drill.getByLabel('Mapping reviewer').fill('Synthetic reviewer');
 await expect(drill.getByRole('button',{name:'Accept as evidence'}).first()).toBeEnabled();
 const pending=await drill.getByRole('button',{name:'Dismiss',exact:true}).count();
 await drill.getByRole('button',{name:'Dismiss',exact:true}).first().click();
 await expect(drill.getByRole('button',{name:'Dismiss',exact:true})).toHaveCount(pending-1);
 await drill.getByRole('button',{name:'Accept as evidence'}).first().click();
 await expect(drill.getByText(/Accepted by Synthetic reviewer/)).toBeVisible();
 await expect(drill.getByRole('button',{name:'Dismiss',exact:true})).toHaveCount(pending-2);
 await expect(drill.getByRole('alert')).toHaveCount(0);
 await summary.getByRole('button',{name:/All 274 files/}).click();
 await expect(summary.getByLabel('All collected files').locator(':scope > article')).toHaveCount(274);
});

test("blocked release tiles stay red without inventing an amber decision",async({page})=>{
 await page.goto('/planning');await page.getByLabel('Evidence system').selectOption('example');
 await expect(page.getByTestId('binder-summary')).toBeVisible();
 const commitSha='e'.repeat(40),releaseSha256='f'.repeat(64);
 const blocked={...CCM_EXAMPLE,pipelineId:'900000001',pipelineUrl:'https://gitlab.com/synthetic/system/-/pipelines/900000001',commitSha,releaseSha256,policyVerdict:'fail' as const,deploymentVerdict:'unknown' as const,signatureStatus:'unknown',signatureScope:'Synthetic blocked-release test only',checks:[{...CCM_EXAMPLE.checks.find(check=>check.id==='secrets')!,status:'fail' as const,findings:2,blockingCount:2}],findingCount:2,families:[],reviewItems:[],gaps:[],artifacts:['secrets.json'],collectedArtifacts:undefined,sourceInventoryHref:undefined,approval:CCM_EXAMPLE.approval?{...CCM_EXAMPLE.approval,commitSha,releaseSha256,mode:'vendor-test' as const}:undefined};
 await page.locator('.pipeline-import').filter({hasText:'Import CCM summary JSON'}).locator('input[type="file"]').setInputFiles({name:'synthetic-blocked.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(summaryForSession(blocked)))});
 await expect(page.locator('.release-readiness')).toHaveAttribute('data-blocked','true');
 await expect(page.locator('.release-readiness')).toContainText('Blocks release');
 await expect(page.locator('.release-check-grid')).toContainText('Blocks release');
 await expect(page.locator('.release-check-grid')).toContainText('2 blocking findings');
 await expect(page.getByTestId('artifact-arrival-count')).toHaveText('1 files collected · complete');
 await expect(page.locator('.release-decision-banner,.scan-decision-action')).toHaveCount(0);
});

for(const width of [1280,1920])for(const mode of ['By family','Selected control'])test(`huge family frames stay intact and pinned at ${width}, ${mode}`,async({page})=>{
 test.setTimeout(180000);await page.setViewportSize({width,height:900});await importFixture(page,'huge');
 await page.getByRole('button',{name:mode,exact:true}).click();
 await page.locator('[data-control-id="AC-6.9"]').click();
 await expect(page.locator('[data-control-id="AC-6.9"]')).toHaveAttribute('aria-pressed','true');
 await page.getByRole('button',{name:mode,exact:true}).click();
 await expect(page.getByRole('button',{name:mode,exact:true})).toHaveAttribute('aria-pressed','true');
 const stage=page.getByTestId('map-stage');
 const report=await stage.evaluate(node=>{
  const s=node.getBoundingClientRect(),card=node.querySelector('[data-control-id="AC-6.9"]')!.getBoundingClientRect(),header=node.querySelector('[data-family-header="AC"]')!.getBoundingClientRect();
  const outside=[...node.querySelectorAll<HTMLElement>('[data-control-id]')].filter(c=>{const frame=node.querySelector(`[data-family-box="${c.dataset.family}"]`);if(!frame)return true;const a=c.getBoundingClientRect(),b=frame.getBoundingClientRect();return a.left<b.left-.5||a.right>b.right+.5||a.top<b.top-.5||a.bottom>b.bottom+.5;}).map(c=>c.dataset.controlId);
  return {outside,headerTop:header.top,headerBottom:header.bottom,cardTop:card.top,cardBottom:card.bottom,top:s.top,bottom:s.bottom};
 });
 expect(report.outside).toEqual([]);expect(report.headerTop).toBeGreaterThanOrEqual(report.top-1);expect(report.headerBottom).toBeLessThanOrEqual(report.cardTop+1);expect(report.cardBottom).toBeLessThanOrEqual(report.bottom+1);
 await expect.poll(()=>stage.locator('[data-family-continuation="AC"] path').evaluateAll(paths=>paths.some(path=>getComputedStyle(path).display!=='none'&&(path as SVGPathElement).getTotalLength()>0))).toBe(true);
});

test('huge family headers remain interactive after scrolling from the final control',async({page})=>{
 await page.setViewportSize({width:1920,height:1114});await importFixture(page,'huge');
 await page.locator('[data-control-id="SR-12"]').click();
 await expect(page.locator('[data-control-id="SR-12"]')).toHaveAttribute('aria-pressed','true');
 for(const header of await page.locator('[data-family-header]').all()){
  const id=await header.getAttribute('data-family-header');
  await page.mouse.move(0,0);await header.hover();
  await expect(page.locator(`[data-family-box="${id}"]`)).toHaveAttribute('data-hover','true');
  await header.locator('.pmap-family-open').click();
  await expect(page.locator(`[data-family-box="${id}"]`)).toHaveAttribute('data-selected','true');
  await page.keyboard.press('Escape');
 }
});
