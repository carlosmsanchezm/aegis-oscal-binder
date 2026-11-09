import {test,expect,type Page} from '@playwright/test';
import {navigateWorkspace} from './helpers/navigation';
import {expectMapRoutes} from './helpers/map-routes';
import {readFileSync} from 'node:fs';
// Expected endpoints come independently from the actual catalog, not the renderer's computed set.
const catalog=JSON.parse(readFileSync('fixtures/rev5/NIST_SP-800-53_rev5_catalog-min.json','utf8')).catalog;
const rawControls=catalog.groups.flatMap((group:{controls:Array<{id:string;links?:Array<{rel:string;href:string}>}>})=>group.controls) as Array<{id:string;links?:Array<{rel:string;href:string}>}>;
function relationships(control:string){const selected=control.toLowerCase(),outbound=new Set(rawControls.find(c=>c.id===selected)?.links?.filter(l=>l.rel==='related').map(l=>l.href.replace(/^#/,''))??[]);return new Set([control,...rawControls.filter(c=>outbound.has(c.id)||c.links?.some(l=>l.rel==='related'&&l.href==='#'+selected)).map(c=>c.id.toUpperCase())]);}
async function load(page:Page,system:string){
 await page.goto('/planning');await page.getByRole('radio',{name:/FedRAMP Rev5/}).check();
 if(system==='podinfo'){await page.getByLabel('Evidence system').selectOption('example');await navigateWorkspace(page,"map");} else{await page.getByLabel('Evidence system').selectOption('captured-reference');await page.getByRole('button',{name:'Load captured Online Boutique evidence'}).click();await navigateWorkspace(page,"map");}
}
async function fit(page:Page){
 const sizes=await page.evaluate(()=>({width:innerWidth,doc:document.documentElement.scrollWidth,stage:[...document.querySelectorAll<HTMLElement>('.pmap-stage')].map(e=>({w:e.clientWidth,scroll:e.scrollWidth})),legend:[...document.querySelectorAll<HTMLElement>('.pmap-legend')].map(e=>{const r=e.getBoundingClientRect();return {w:e.clientWidth,scroll:e.scrollWidth,contained:[...e.children].every(c=>{const b=c.getBoundingClientRect();return b.left>=r.left-1&&b.right<=r.right+1;})};}),toolbar:[...document.querySelectorAll<HTMLElement>('.pmap-toolbar button,.pmap-toolbar summary,.pmap-toolbar .pmap-chip')].every(e=>{const r=e.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth;}),pin:[...document.querySelectorAll<HTMLElement>('.chrome-pin-value')].map(e=>({w:e.clientWidth,scroll:e.scrollWidth}))}));
 expect(sizes.doc).toBeLessThanOrEqual(sizes.width);expect(sizes.toolbar).toBe(true);for(const s of [...sizes.stage,...sizes.legend])expect(s.scroll).toBeLessThanOrEqual(s.w+1);for(const pin of sizes.pin)expect(pin.scroll).toBeLessThanOrEqual(pin.w+1);for(const l of sizes.legend)expect(l.contained).toBe(true);
}
for(const system of ['podinfo','boutique'])for(const viewport of [{width:1440,height:900},{width:1366,height:768},{width:1280,height:800}])test(`${system} ${viewport.width}: no clipped map chrome, truthful highlighted endpoints before/after SSP, and real selected statement detail`,async({page},info)=>{
 await page.setViewportSize(viewport);await load(page,system);const control=system==='podinfo'?'CM-6':'AC-6',allowed=relationships(control);
 await expect(page.getByRole('checkbox',{name:'Show untouched controls'})).not.toBeChecked();
 for(const sample of [false,true]){
  if(sample){await navigateWorkspace(page,'export');await page.getByRole('button',{name:'Load sample SSP for this workspace'}).click();await navigateWorkspace(page,'map');}
  await page.getByRole("checkbox",{name:"Show untouched controls"}).check();await page.locator(`[data-control-id="${control}"]`).click();await expect(page.getByTestId('pipeline-control-panel')).toBeVisible();await page.mouse.move(0,0);await fit(page);
  const endpoints=await page.locator('path[data-rel="related"]').evaluateAll(ns=>ns.map(n=>({from:n.getAttribute('data-from')!,to:n.getAttribute('data-to')!})));expect(endpoints.length).toBeGreaterThan(0);
  for(const path of endpoints){expect([path.from,path.to]).toContain(control);expect(allowed.has(path.from)).toBe(true);expect(allowed.has(path.to)).toBe(true);}
  const drawn=new Set(endpoints.flatMap(path=>[path.from,path.to]));const visible=new Set(await page.locator("[data-control-id]").evaluateAll(ns=>ns.map(n=>n.getAttribute("data-control-id")!)));expect([...drawn].sort()).toEqual([...allowed].filter(id=>visible.has(id)).sort());
  // Hovering a family while a selected control is active must not add family-wide relationships.
  const familyBox=await page.locator('[data-family-box="AC"]').boundingBox();await page.mouse.move(familyBox!.x+2,familyBox!.y+familyBox!.height-8);const hovered=await page.locator('path[data-rel="related"]').evaluateAll(ns=>ns.map(n=>[n.getAttribute('data-from')!,n.getAttribute('data-to')!]));for(const path of hovered){expect(path).toContain(control);for(const endpoint of path)expect(allowed.has(endpoint)).toBe(true);}await page.mouse.move(0,0);
  await info.attach(`map-${sample?'ssp':'recorded'}`,{body:await page.screenshot({path:info.outputPath(`${system}-${viewport.width}-${sample?'ssp':'recorded'}.png`)}),contentType:'image/png'});
  await expectMapRoutes(page);
 }
 await page.getByRole('button',{name:`Open ${control} in Level 2 →`}).click();await page.locator('[data-item-id]').first().click();const detail=page.getByTestId('selected-statement-detail');await expect(detail).toContainText('Selected statement');await expect(detail).toContainText('Review decision');await expect(page.getByTestId('level2-focus')).not.toContainText('{{ insert:');await page.getByRole('button',{name:/Review mapping from/}).first().click();await expect(page.getByTestId('statement-mapping-review')).not.toContainText('{{ insert:');await page.getByRole('button',{name:'Close statement review'}).click();await detail.scrollIntoViewIfNeeded();await info.attach('level2-detail',{body:await page.screenshot(),contentType:'image/png'});
});
