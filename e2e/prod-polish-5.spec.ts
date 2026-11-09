import {test,expect,type Page} from '@playwright/test';
import {navigateWorkspace} from './helpers/navigation';
import {expectMapRoutes} from './helpers/map-routes';
async function load(page:Page,system:string){await page.goto('/planning');await page.getByRole('radio',{name:/FedRAMP Rev5/}).check();if(system==='podinfo'){await page.getByLabel('Evidence system').selectOption('example');await navigateWorkspace(page,"map");} else{await page.getByLabel('Evidence system').selectOption('captured-reference');await page.getByRole('button',{name:'Load captured Online Boutique evidence'}).click();await navigateWorkspace(page,"map");}}
export async function fanShape(page:Page,control:string){
 const untouched=page.getByRole("checkbox",{name:"Show untouched controls"});if(await untouched.count() && !(await untouched.isChecked()))await untouched.check();
 const paths=await page.locator('path[data-rel="related"]').evaluateAll(ns=>ns.map(n=>({from:n.getAttribute('data-from'),to:n.getAttribute('data-to'),d:n.getAttribute('d')!,dash:n.getAttribute('stroke-dasharray'),routing:n.getAttribute('data-routing')})));
 const chips=await page.locator('[data-related-control]').evaluateAll(ns=>ns.map(n=>n.getAttribute('data-related-control')));
 expect(paths.length).toBeGreaterThan(0);
 for(const path of paths){if(path.routing==='fan'){expect(path.d).toMatch(/^M[\d .-]+(?: C[\d .-]+)+$/);expect(path.d).not.toMatch(/[LHV]/);}else expect(path.d).toMatch(/^M[\d .-]+(?: L[\d .-]+)+$/);expect([path.from,path.to]).toContain(control);expect(path.dash).toBeTruthy();}
 const segments=new Set<string>(),straight:Array<number[]>=[];
 for(const path of paths.filter(path=>path.routing==='fan')){const coordinates=path.d.match(/-?\d+(?:\.\d+)?/g)!.map(Number);let start=coordinates.slice(0,2);for(let offset=2;offset<coordinates.length;offset+=6){const curve=[...start,...coordinates.slice(offset,offset+6)],reverse=[...curve.slice(6,8),...curve.slice(4,6),...curve.slice(2,4),...curve.slice(0,2)];const signature=[JSON.stringify(curve),JSON.stringify(reverse)].sort()[0];expect(segments.has(signature),'each curved route owns its segments').toBe(false);segments.add(signature);const [x,y,bx,by,cx,cy,ex,ey]=curve;if(Math.abs((bx-x)*(ey-y)-(by-y)*(ex-x))<.01 && Math.abs((cx-x)*(ey-y)-(cy-y)*(ex-x))<.01)straight.push([x,y,ex,ey]);start=curve.slice(6,8);}}
 // Even differently parameterized cubic segments must not hide a shared straight bus.
 for(let i=0;i<straight.length;i++)for(let j=i+1;j<straight.length;j++){const [x,y,ex,ey]=straight[i],[bx,by,bex,bey]=straight[j],dx=ex-x,dy=ey-y,length=Math.hypot(dx,dy);if(length<12)continue;const normal=(px:number,py:number)=>Math.abs((px-x)*dy-(py-y)*dx)/length;if(normal(bx,by)>.1||normal(bex,bey)>.1)continue;const position=(px:number,py:number)=>((px-x)*dx+(py-y)*dy)/length;const a=position(bx,by),b=position(bex,bey),overlap=Math.min(length,Math.max(a,b))-Math.max(0,Math.min(a,b));expect(overlap,'no shared straight bus, including a bus encoded as cubic curves').toBeLessThanOrEqual(12);}
 expect(paths).toHaveLength(chips.length);
 expect(new Set(paths.map(p=>p.d)).size).toBe(paths.length);
 expect(paths.map(p=>p.from===control?p.to:p.from).sort()).toEqual(chips.sort());
 const boxes=await page.locator('[data-control-id]').evaluateAll(ns=>ns.map(n=>({id:n.getAttribute('data-control-id')!,r:n.getBoundingClientRect().toJSON()})));
 const overlaps=boxes.flatMap((a,i)=>boxes.slice(i+1).filter(b=>Math.min(a.r.right,b.r.right)-Math.max(a.r.left,b.r.left)>0&&Math.min(a.r.bottom,b.r.bottom)-Math.max(a.r.top,b.r.top)>0).map(b=>[a.id,b.id]));expect(overlaps).toEqual([]);
 const legend=await page.getByLabel('Map legend').evaluate(e=>({r:e.getBoundingClientRect().toJSON(),children:[...e.children].map(n=>n.getBoundingClientRect().toJSON())}));expect(new Set(legend.children.map(r=>Math.round(r.top))).size).toBeLessThanOrEqual(2);expect(Math.max(...legend.children.map(r=>r.bottom))-Math.min(...legend.children.map(r=>r.top))).toBeLessThan(20);
 const topbar=await page.locator('.chrome-topbar').evaluate(e=>({height:e.getBoundingClientRect().height,labels:[...e.querySelectorAll('.chip strong')].map(n=>({height:n.getBoundingClientRect().height,line:parseFloat(getComputedStyle(n).lineHeight)||parseFloat(getComputedStyle(n).fontSize)*1.5}))}));expect(topbar.height).toBeLessThanOrEqual(58);for(const label of topbar.labels)expect(label.height).toBeLessThanOrEqual(label.line+1);
 const title=await page.locator('.pmap-toolbar').boundingBox();const snapshot=await page.locator('.pmap-toolbar .round21-snapshot').boundingBox();const caption=await page.getByTestId('map-fail-banner').boundingBox();expect(snapshot!.x+snapshot!.width).toBeLessThanOrEqual(caption!.x+1);expect(title!.y+title!.height).toBeLessThanOrEqual((await page.getByTestId('map-rollup-summary').boundingBox())!.y+1);
 await expectMapRoutes(page);
 return {paths,boxes,legend};
}
for(const system of ['podinfo','boutique'])for(const width of [1280,1366,1440])test(`${system} ${width}: independent selected routes, spaced cards and intact map chrome`,async({page},info)=>{
 await page.setViewportSize({width,height:width===1440?900:width===1366?768:800});await load(page,system);const id=system==='podinfo'?'CM-6':'AC-6';await page.locator(`[data-control-id="${id}"]`).click();await expect(page.getByTestId('pipeline-control-panel')).toBeVisible();await page.mouse.move(0,0);await page.screenshot({path:info.outputPath('before-ssp.png')});await fanShape(page,id);
 await navigateWorkspace(page,'export');await page.getByRole('button',{name:'Load sample SSP for this workspace'}).click();await navigateWorkspace(page,'map');await page.mouse.move(0,0);await page.screenshot({path:info.outputPath('after-ssp.png')});await fanShape(page,id);
 await page.getByRole('button',{name:`Open ${id} in Level 2 →`}).click();await expect(page.locator('[data-item-id]').first()).toHaveClass(/selected/);await expect(page.getByTestId('selected-statement-detail')).toContainText('Selected statement');await expect(page.getByTestId('selected-statement-detail')).toContainText('Retained evidence');await expect(page.getByTestId('selected-statement-detail')).not.toContainText('Select a statement');await page.screenshot({path:info.outputPath('level2.png')});
});
for(const system of ['podinfo','boutique'])test(`${system}: selection survives 12 repeated trials, refresh and navigation`,async({page})=>{
 await load(page,system);const id=system==='podinfo'?'CM-6':'AC-6';const tile=page.locator(`[data-control-id="${id}"]`);
 for(let trial=0;trial<12;trial++){
  await tile.click();await expect(tile).toHaveAttribute('aria-pressed','true');
  // A release/menu refresh and a pointer in the newly reflowed map must not undo focus.
  await page.locator('.round21-snapshot>summary').click();await page.keyboard.press('Escape');await expect(tile).toHaveAttribute('aria-pressed','true');await page.mouse.move(200,400);await expect(tile).toHaveAttribute('aria-pressed','true');
  await navigateWorkspace(page,'connections');await navigateWorkspace(page,'map');await expect(tile).toHaveAttribute('aria-pressed','true');
  await page.getByRole('button',{name:`Open ${id} in Level 2 →`}).click();await page.getByTestId('level2-back').click();await expect(tile).toHaveAttribute('aria-pressed','true');
  if(trial%3===0){await page.reload();await expect(tile).toHaveAttribute('aria-pressed','true');}
 }
});
test('Podinfo accepted CM-6 plan stays pinned on the retest snapshot instead of a separate proposed finding',async({page})=>{
 await load(page,'podinfo');await navigateWorkspace(page,'release');await page.getByRole('button',{name:'Open proposed plan CM-6 · Application UID/GID hardening',exact:true}).click();await page.getByRole('button',{name:'Accept proposed draft',exact:true}).click();await expect(page.getByTestId('plan-proposal')).toContainText('Accepted');await page.getByRole('button',{name:'Close proposed plan'}).click();await navigateWorkspace(page,'map');await page.locator('.round21-snapshot>summary').click();await page.getByRole('option').filter({hasText:'#2908682168'}).click();await page.locator('[data-control-id="CM-6"]').click();const pinned=page.locator('.control-plan-pinned');await expect(pinned).toContainText('Application UID/GID hardening');await expect(pinned).toContainText('Accepted');await expect(pinned).not.toContainText('KSV-0125');await page.reload();await expect(pinned).toContainText('Accepted');
});
for(const system of ['podinfo','boutique'])test(`${system}: reflow between pointer down and up cannot clear the selected control`,async({page})=>{
 await page.setViewportSize({width:1440,height:900});await load(page,system);const id=system==='podinfo'?'CM-6':'AC-6',tile=page.locator(`[data-control-id="${id}"]`);await tile.click();await expect(tile).toHaveAttribute('aria-pressed','true');const r=await tile.boundingBox();await page.mouse.move(r!.x+r!.width-2,r!.y+r!.height/2);await page.mouse.down();await page.setViewportSize({width:1280,height:800});await page.mouse.up();await expect(tile).toHaveAttribute('aria-pressed','true');await expect(page.getByTestId('pipeline-control-panel')).toContainText(id);
});
