import {test,expect,type Page} from '@playwright/test';
import {CCM_EXAMPLE} from '../lib/aegis/pipeline-evidence';
import {workspaceSystemLabel,pipelineSystemName} from '../lib/aegis/workspace-label';
import {navigateWorkspace} from './helpers/navigation';
async function load(page:Page,system:'podinfo'|'boutique'){
 await page.goto('/planning');await page.getByRole('radio',{name:/FedRAMP Rev5/}).check();
 if(system==='podinfo'){await page.getByLabel('Evidence system').selectOption('example');await navigateWorkspace(page,"map");} else{await page.getByLabel('Evidence system').selectOption('captured-reference');await page.getByRole('button',{name:'Load captured Online Boutique evidence'}).click();await navigateWorkspace(page,"map");}
 await page.locator(`[data-control-id="${system==='podinfo'?'CM-6':'AC-6'}"]`).click();await expect(page.getByTestId('pipeline-control-panel')).toBeVisible();
}
for(const viewport of [{width:1280,height:800},{width:1366,height:768}])for(const system of ['podinfo','boutique'] as const)test(`${system} ${viewport.width}: full control grid fits width and scrolls through wrapped family bands`,async({page},info)=>{
 await page.setViewportSize(viewport);await load(page,system);
 for(const ssp of [false,true]){
  if(ssp){await navigateWorkspace(page,'export');await page.getByRole('button',{name:'Load sample SSP for this workspace'}).click();await navigateWorkspace(page,'map');}
  // Full control faces use a scrollable canvas while keeping the visible width.
  await page.getByRole('checkbox',{name:'Show untouched controls'}).check();
  await expect(page.locator('[data-control-id]')).toHaveCount(323);
  await expect(page.getByTestId('package-map')).toHaveAttribute('data-layout-engine','round21');
  const geometry=await page.locator('[data-testid="map-stage"]').evaluate(stage=>{const r=stage.getBoundingClientRect(),tiles=[...stage.querySelectorAll('[data-family-box]')].map(e=>e.getBoundingClientRect());return {width:innerWidth,height:innerHeight,scale:visualViewport?.scale,dpr:devicePixelRatio,rightGap:r.right-Math.max(...tiles.map(r=>r.right)),leftGap:Math.min(...tiles.map(r=>r.left))-r.left,verticalOverflow:stage.scrollHeight-stage.clientHeight};});
  await info.attach(`grid-${ssp?'ssp':'recorded'}`,{body:JSON.stringify(geometry,null,2),contentType:'application/json'});await page.screenshot({path:info.outputPath(`${system}-${ssp?'ssp':'recorded'}.png`)});
  expect(geometry).toMatchObject({...viewport,scale:1,dpr:1});expect(geometry.rightGap).toBeGreaterThanOrEqual(0);expect(geometry.leftGap).toBeGreaterThanOrEqual(0);expect(geometry.rightGap).toBeLessThanOrEqual(64);expect(geometry.leftGap).toBeLessThanOrEqual(64);expect(geometry.verticalOverflow).toBeGreaterThan(0);
 }
});
test('Podinfo true 1280 header shows complete workspace and catalog and single-line coverage',async({page},info)=>{
 await page.setViewportSize({width:1280,height:800});await load(page,'podinfo');await page.evaluate(()=>document.fonts.ready);
 const metrics=await page.locator('.chrome-topbar').evaluate(header=>{
  const select=header.querySelector<HTMLSelectElement>('.workspace-system-select')!,css=getComputedStyle(select),c=document.createElement('canvas').getContext('2d')!;c.font=`${css.fontWeight} ${css.fontSize} ${css.fontFamily}`;
  const catalog=header.querySelector<HTMLElement>('.chrome-catalog strong')!,coverage=header.querySelector<HTMLElement>('.chrome-lamp')!,range=document.createRange();range.selectNodeContents(coverage);
  return {workspaceText:select.selectedOptions[0].text,workspaceTitle:select.title,workspaceWidth:select.clientWidth,workspaceRequired:c.measureText(select.selectedOptions[0].text).width+parseFloat(css.paddingLeft)+parseFloat(css.paddingRight)+20,catalogText:catalog.textContent,catalogWidth:catalog.clientWidth,catalogScroll:catalog.scrollWidth,coverageLines:(()=>{const walker=document.createTreeWalker(coverage,NodeFilter.SHOW_TEXT),rects:DOMRect[]=[];let node;while((node=walker.nextNode()))if(node.textContent?.trim()){const textRange=document.createRange();textRange.selectNodeContents(node);rects.push(...textRange.getClientRects());}return rects.length && Math.min(...rects.map(r=>r.bottom))>Math.max(...rects.map(r=>r.top))?1:2;})(),headerOverflow:header.scrollWidth-header.clientWidth};
 });await info.attach('header-geometry',{body:JSON.stringify(metrics,null,2),contentType:'application/json'});await page.screenshot({path:info.outputPath('podinfo-header.png')});expect(metrics.workspaceText).toBe(workspaceSystemLabel(pipelineSystemName(CCM_EXAMPLE),"recorded example"));expect(metrics.workspaceTitle).toBe(metrics.workspaceText);expect(metrics.workspaceWidth).toBeGreaterThan(150);expect(metrics.catalogText).toContain('FedRAMP Rev5');expect(metrics.catalogScroll).toBeLessThanOrEqual(metrics.catalogWidth+1);expect(metrics.coverageLines).toBe(1);expect(metrics.headerOverflow).toBeLessThanOrEqual(1);
});
