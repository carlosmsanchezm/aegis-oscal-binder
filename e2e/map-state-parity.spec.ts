import {test,expect,type Page} from '@playwright/test';
import {stressTestTimeoutMs} from '../lib/ci-runner-budget';
import {readFileSync,writeFileSync} from 'node:fs';
import {loadRef2} from './helpers/ref2';
import {navigateWorkspace} from './helpers/navigation';
import {receivedRetest} from '../test/support/received-retest';
import {settleMap,mapMembership,mapUnitGeometry,expectPlanningFit,expectPlanningHub,expectPlanningRoutes} from './helpers/map-3b';

for(const width of [1280,1440,1920])test(`3b at ${width}: focus glides, overlay panels and Fit preserve catalog membership`,async({page},info)=>{
 await page.setViewportSize({width,height:width===1280?800:width===1440?900:1114});await loadRef2(page);
 const map=page.getByTestId('package-map'),membership=await mapMembership(page);
 const initial=await mapUnitGeometry(page);
 await expectPlanningFit(page);
 await expect(map.locator('[data-family-box][data-focus="center"]')).toHaveCount(1);
 await expect(map.getByRole('button',{name:'Roles',exact:true})).toHaveCount(0);
 await expect(map.locator('.pmap-role')).toHaveCount(0);
 await page.mouse.move(0,0);await page.screenshot({path:info.outputPath('parity-reference-closed.png'),animations:'disabled'});
 const states:Record<string,unknown>={initial};
 for(const [name,selector,panel] of [
  ['family','[data-family-header="CM"] .pmap-family-open','map-family-panel'],
  ['control','[data-control-id="CM-6"]','pipeline-control-panel'],
  ['owner','[data-control-id="AC-2"]','pipeline-control-panel'],
  ['evidence','[data-evidence-id="EV-CM2-01"]','map-node-panel'],
 ] as const){
  await page.locator(selector).click();await expect(page.getByTestId(panel)).toBeVisible();
  await settleMap(page);
  expect(await mapMembership(page)).toEqual(membership);
  if(name==='family')await expect(map.locator('[data-family-box="CM"]')).toHaveAttribute('data-focus','center');
  if(name==='control'||name==='owner')await expectPlanningHub(page,name==='control'?'CM-6':'AC-2');
  if(name==='owner') {
   const picker=page.getByTestId(panel).getByLabel('Owner in side panel');
   const options=await picker.locator('option').evaluateAll(nodes=>nodes.map(node=>(node as HTMLOptionElement).value).filter(Boolean));
   expect(options.length).toBeGreaterThan(0);
   const before=await mapUnitGeometry(page);await picker.selectOption(options[0]);await settleMap(page);
   expect(await mapUnitGeometry(page)).toEqual(before);expect(await mapMembership(page)).toEqual(membership);
   await picker.selectOption('');
  }
  await expectPlanningFit(page);await expectPlanningRoutes(page);
  const focused=await mapUnitGeometry(page);
  await map.getByRole('button',{name:'Fit',exact:true}).click();
  expect(await mapUnitGeometry(page)).toEqual(focused);
  states[name]=focused;
  await page.mouse.move(0,0);await page.screenshot({path:info.outputPath(`parity-reference-${name}.png`),animations:'disabled'});
  await page.keyboard.press('Escape');await settleMap(page);
  expect(await mapMembership(page)).toEqual(membership);
  await expectPlanningFit(page);
 }
 expect(states.control).not.toEqual(initial);
 writeFileSync(info.outputPath('geometry.json'),JSON.stringify(states,null,2));
});

test('same imported control set preserves membership and deterministic 3b focus across all workspaces, sources, snapshots and panel states',async({browser},info)=>{
 test.setTimeout(stressTestTimeoutMs());
 let membership:string[]|undefined;
 const measurements=[];
 for(const workspace of ['/planning','/planning?view=release'])for(const source of ['recorded example','received pipeline','captured reference','uploaded package'] as const){
  const context=await browser.newContext({viewport:{width:1920,height:1114}});
  const page=await context.newPage();
  try{
   const evidence=receivedRetest();
   await page.route('**/api/pipeline/events',route=>route.fulfill({json:{ok:true,configured:false,evidence,releases:[{evidence,receivedAt:evidence.createdAt}]}}));
   await page.goto(workspace);await navigateWorkspace(page,'map');
   await page.getByRole('radio',{name:/FedRAMP Rev5/}).check();
   await page.getByLabel('OSCAL package').setInputFiles({name:'same-control-set.json',mimeType:'application/json',buffer:readFileSync('public/samples/sample-oscal-ssp-rev5.json')});
   await page.getByRole('button',{name:'Upload OSCAL',exact:true}).click();
   await expect(page.getByRole('button',{name:'New package',exact:true})).toBeVisible();
   if(source==='captured reference'){
    await navigateWorkspace(page,'connections');
    await page.getByRole('button',{name:'Load captured Online Boutique evidence',exact:true}).click();
    await expect(page.getByTestId('binder-summary').getByTestId('artifact-arrival-count')).toContainText('complete');
   }else await page.getByLabel('Evidence system').selectOption(source==='recorded example'?'example':source==='received pipeline'?'pipeline':'');
   await navigateWorkspace(page,'map');await page.getByRole('checkbox',{name:'Show untouched controls'}).check();
   await expect(page.locator('.pmap-control')).toHaveCount(323);
   await settleMap(page);membership??=await mapMembership(page);
   await page.locator('.round21-snapshot > summary').click();
   const snapshots=await page.getByRole('listbox',{name:'Map release selection'}).getByRole('option').allTextContents();
   await page.keyboard.press('Escape');
   for(let snapshot=0;snapshot<snapshots.length;snapshot++){
    await page.locator('.round21-snapshot > summary').click();
    await page.getByRole('listbox',{name:'Map release selection'}).getByRole('option').nth(snapshot).click();
    await settleMap(page);expect(await mapMembership(page)).toEqual(membership);
    await expect(page.getByRole('button',{name:'Pipeline',exact:true}))[source==='uploaded package'?'toBeDisabled':'toBeEnabled']();
    await expect(page.getByRole('button',{name:'Roles',exact:true})).toHaveCount(0);
    const selections:Record<string,unknown>={};
    for(const [selection,selector,panel] of [
     ['control','[data-control-id="CM-6"]','pipeline-control-panel'],
     ['family','[data-family-header="CM"] .pmap-family-open','map-family-panel'],
     ['owner','[data-control-id="AC-2"]','pipeline-control-panel'],
     ['evidence','[data-evidence-id]','map-node-panel'],
    ] as const){
     await page.locator(selector).first().click();await expect(page.getByTestId(panel)).toBeVisible();
     await settleMap(page);expect(await mapMembership(page)).toEqual(membership);
     if(selection==='control'||selection==='owner')await expectPlanningHub(page,selection==='control'?'CM-6':'AC-2');
     if(selection==='family')await expect(page.locator('[data-family-box="CM"]')).toHaveAttribute('data-focus','center');
     if(selection==='owner') {
      const picker=page.getByTestId(panel).getByLabel('Owner in side panel');
      const value=await picker.locator('option').evaluateAll(nodes=>nodes.map(node=>(node as HTMLOptionElement).value).find(Boolean));
      expect(value).toBeTruthy();const before=await mapUnitGeometry(page);await picker.selectOption(value!);await settleMap(page);
      expect(await mapUnitGeometry(page)).toEqual(before);await picker.selectOption('');
     }
     await expectPlanningFit(page);await expectPlanningRoutes(page);
     const focused=await mapUnitGeometry(page);await page.getByRole('button',{name:'Fit',exact:true}).click();
     expect(await mapUnitGeometry(page)).toEqual(focused);selections[selection]=focused;
     await page.keyboard.press('Escape');await settleMap(page);expect(await mapMembership(page)).toEqual(membership);
    }
    measurements.push({workspace,source,snapshot:snapshots[snapshot].trim(),membership,selections});
   }
   await page.mouse.move(0,0);await page.screenshot({path:info.outputPath(`parity-${workspace.includes('release')?'pipeline-workspace':'planning'}-${source.replaceAll(' ','-')}.png`),animations:'disabled'});
  }finally{await context.close();}
 }
 expect(measurements.length).toBeGreaterThanOrEqual(8);
 writeFileSync(info.outputPath('source-snapshot-panel-matrix.json'),JSON.stringify(measurements,null,2));
});
