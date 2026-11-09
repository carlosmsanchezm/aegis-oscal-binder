import {test,expect,type Page} from "@playwright/test";
import {loadRef2} from "./helpers/ref2";
import {navigateWorkspace} from "./helpers/navigation";
import {importFixture} from "./helpers/map-fixtures";
import path from "node:path";
import {mkdirSync,writeFileSync} from "node:fs";

async function compactCards(page:Page){
 const cards=await page.locator('.pmap-control').evaluateAll(nodes=>nodes.map(node=>{
  const el=node as HTMLElement;
  return {proposal:el.dataset.proposalPill==='true',height:el.style.height,labels:[...el.querySelectorAll<HTMLElement>('.t1,.t2')].map(text=>({height:text.clientHeight,clipped:text.scrollWidth>text.clientWidth+1,wrap:getComputedStyle(text).whiteSpace})),title:el.title,overflow:[...el.querySelectorAll<HTMLElement>(".cid,.t1,.t2,.pmap-review-state,.pmap-status-line,.pmap-coverage-ticks")].filter(text=>{const r=text.getBoundingClientRect(),box=el.getBoundingClientRect();return r.top<box.top||r.bottom>box.bottom||r.left<box.left||r.right>box.right;}).map(text=>text.textContent)};
 }));
 expect(cards.filter(card=>card.height!==(card.proposal?'36px':'77px')||!card.title||card.overflow.length||card.labels.some(label=>label.height!==10||label.clipped||label.wrap!=='nowrap'))).toEqual([]);
}
async function familyFocus(page:Page){
 const header=page.locator('[data-family-header="CM"] .pmap-family-open');
 await header.hover();await expect(page.locator('[data-family-focus]')).toHaveCount(0); // BUI-024 removes the amber outline.
 await expect(page.locator('[data-family-box="CM"]')).toHaveAttribute('data-hover','true');
 await expect(page.locator('path[data-rel="related"]')).toHaveCount(0);
 const stubs=page.locator('path[data-rel="role"][data-to^="CM-"]');
 expect(await stubs.count()).toBeGreaterThan(0);
 for(const stub of await stubs.all()){await expect(stub).toHaveAttribute('stroke','#d99a00');expect(await stub.evaluate(node=>(node as SVGPathElement).getTotalLength())).toBeLessThanOrEqual(12.1);}
 await expect.poll(()=>page.locator('.pmap-control:not([data-family="CM"])').evaluateAll(nodes=>nodes.every(node=>getComputedStyle(node).opacity==='0.5'))).toBe(true);
 await expect.poll(()=>page.locator('.pmap-control[data-family="CM"]').evaluateAll(nodes=>nodes.every(node=>getComputedStyle(node).opacity==='1'))).toBe(true);
}
for(const workspace of ['reference','boutique','huge'] as const)test(`${workspace} matches the compact reference grammar`,async({page},info)=>{
 test.setTimeout(180000);await page.setViewportSize({width:1920,height:1114});
 if(workspace==='huge')await importFixture(page,'huge');
 else if(workspace==='reference')await loadRef2(page);
 else{
  await page.goto('/planning?view=connections');
  if(workspace==='boutique'){
   await page.getByRole('button',{name:'Load captured Online Boutique evidence',exact:true}).click();
   await expect(page.getByTestId('binder-summary').getByTestId('artifact-arrival-count')).toContainText('complete');
  }else await page.getByLabel('Evidence system').selectOption('example');
  await navigateWorkspace(page,'export');await page.getByRole('button',{name:'Load sample SSP for this workspace',exact:true}).click();
  await expect(page.getByRole('button',{name:'New package',exact:true})).toBeVisible();await navigateWorkspace(page,'map');
 }

 await compactCards(page);
 if(workspace!=="huge"){const pills=page.locator('[data-proposal-pill="true"]');expect(await pills.count()).toBeGreaterThan(0);await expect(pills.locator(".t1,.t2,[data-control-dot]")).toHaveCount(0);for(const pill of await pills.all())await expect(pill.locator(".pmap-status-line")).toHaveText(/^[0-9]+ proposed$/);}
 expect(await page.locator('.pmap-role').count()).toBeGreaterThan(0);expect(await page.locator('.pmap-evidence:not(.pmap-pipeline-artifact)').count()).toBeGreaterThan(0);
 const frames=await page.locator('.pmap-layer').evaluate(layer=>{
  const width=(layer as HTMLElement).offsetWidth,height=(layer as HTMLElement).offsetHeight;
  return [...layer.querySelectorAll<SVGPathElement>('path[data-rel]')].every(path=>{const r=path.getBBox();return r.x>=0&&r.y>=0&&r.x+r.width<=width&&r.y+r.height<=height;});
 });expect(frames).toBe(true);
 const dir=info.outputPath("map-captures");mkdirSync(dir,{recursive:true});await page.mouse.move(0,0);await page.screenshot({animations:'disabled',path:path.join(dir,`correction-${workspace}-map.png`)});
 await page.locator('[data-control-id="CM-6"]').click();await expect(page.locator('[data-control-id="CM-6"]')).toHaveAttribute('aria-pressed','true');await page.mouse.move(0,0);await expect(page.locator('[data-control-id="CM-6"]')).toBeInViewport();
 await compactCards(page);
 await expect(page.locator('[data-family-focus]')).toHaveCount(0);
 await expect(page.locator('[data-family-box=CM]')).toHaveAttribute('stroke','#e6e1ff');
 const selected=page.locator('[data-control-id="CM-6"]');
 const height=await selected.evaluate(node=>(node as HTMLElement).offsetHeight);
 await expect(page.locator('[data-halo="CM-6"]')).toHaveAttribute("height",String(height+10));
 const families=await page.locator('[data-family-box]').evaluateAll(nodes=>nodes.map(node=>({id:node.getAttribute('data-family-box'),w:Number(node.getAttribute('width'))})));
 const counts=await page.locator('.pmap-control').evaluateAll(nodes=>nodes.reduce((counts,node)=>{const family=node.getAttribute('data-family')!;counts[family]=(counts[family]??0)+1;return counts;},{} as Record<string,number>));
 for(const a of families)for(const b of families)if(counts[a.id!]>counts[b.id!] && counts[a.id!]<20)expect(a.w).toBeGreaterThan(b.w);
 if(workspace==='reference')for(const id of ['SC-7','SI-7'])await expect(page.locator(`[data-control-id="${id}"]`)).toHaveCSS('opacity','0.5');
 await expect.poll(()=>page.locator('path[data-rel="related"]').evaluateAll(nodes=>nodes.every(node=>!/[LHV]/.test(node.getAttribute('d')??'')))).toBe(true);
 await page.screenshot({animations:'disabled',path:path.join(dir,`correction-${workspace}-click.png`)});
 await page.keyboard.press('Escape');await page.getByRole('button',{name:'By family',exact:true}).click();await familyFocus(page);await page.screenshot({animations:'disabled',path:path.join(dir,`correction-${workspace}-family.png`)});await page.mouse.move(0,0);
 if(workspace==='huge'){await page.keyboard.press('Escape');await page.locator('.pmap-evidence:not(.pmap-pipeline-artifact)').first().scrollIntoViewIfNeeded();await page.screenshot({animations:'disabled',path:path.join(dir,'correction-huge-evidence.png')});}
});
test('None keeps planning card styling and family colors',async({page},info)=>{
 await page.setViewportSize({width:1920,height:1114});await page.goto('/planning');await page.getByLabel('Evidence system').selectOption('example');await navigateWorkspace(page,'export');await page.getByRole('button',{name:'Load sample SSP for this workspace',exact:true}).click();await expect(page.getByRole('button',{name:'New package',exact:true})).toBeVisible();await navigateWorkspace(page,'map');
 const colors=()=>page.locator('[data-family-box]').evaluateAll(nodes=>nodes.map(node=>[node.getAttribute('data-family-box'),node.getAttribute('fill')]));const before=await colors();const proposals=await page.locator("[data-proposal-control]").evaluateAll(nodes=>nodes.map(node=>node.getAttribute("data-control-id")));
 await page.locator('.round21-snapshot>summary').click();await page.getByRole('option',{name:/^None/}).click();
 await compactCards(page);expect(await colors()).toEqual(before);expect(await page.locator("[data-proposal-control]").evaluateAll(nodes=>nodes.map(node=>node.getAttribute("data-control-id")))).toEqual(proposals);await expect(page.locator('.pmap-control .mark-ok')).toHaveCount(0);
 await expect(page.locator('[data-release-linked="true"]')).toHaveCount(0);await expect(page.locator('.pipeline-file-picker > summary')).toBeVisible();
 expect(await page.locator('.pmap-control .pmap-status-line').evaluateAll(nodes=>nodes.every(node=>!node.textContent?.includes('complete')))).toBe(true);
 await page.mouse.move(0,0);await page.screenshot({animations:'disabled',path:info.outputPath("correction-none-map.png")});
});
test('huge first selection stays within the interaction budget',async({page},info)=>{
 await page.setViewportSize({width:1920,height:1114});await importFixture(page,'huge');
 const card=page.locator('[data-control-id="AC-1"]');await card.hover();
 const ms=await card.evaluate(node=>new Promise<number>(resolve=>{
  const start=performance.now(),observer=new MutationObserver(()=>{if(node.getAttribute('aria-pressed')==='true'){observer.disconnect();requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(performance.now()-start)));}});
  observer.observe(node,{attributes:true,attributeFilter:['aria-pressed']});(node as HTMLButtonElement).click();
 }));
 writeFileSync(info.outputPath("first-selection.json"),JSON.stringify({ms,budget:500},null,2));expect(ms).toBeLessThan(500);await expect(card).toBeInViewport();
});
