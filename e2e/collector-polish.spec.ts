import {test,expect} from '@playwright/test';
import {writeFile} from 'node:fs/promises';
import {navigateWorkspace} from './helpers/navigation';
async function load(page:import('@playwright/test').Page){
 await page.goto('/planning?view=connections');
 await page.getByRole('button',{name:'Load captured Online Boutique evidence',exact:true}).click();
 await expect(page.getByTestId('binder-summary').getByTestId('artifact-arrival-count')).toContainText('complete');
}
test('connected capture shows its first count within two seconds and completes under ten seconds',async({page},info)=>{
 await page.goto('/planning?view=connections');
 await page.evaluate(()=>{
  (window as any).loadFrames=[];
  document.addEventListener('click',event=>{if((event.target as HTMLElement).textContent?.includes('Load captured Online Boutique evidence'))(window as any).loadStarted=performance.now();},true);
  new MutationObserver(()=>{
   const start=(window as any).loadStarted;if(!start)return;
   for(const el of document.querySelectorAll('[data-testid="artifact-arrival-count"]')){
    const text=el.textContent ?? '',count=Number(text.match(/^(\d+)/)?.[1]);
    if(count>0)(window as any).loadFrames.push({count,complete:text.includes('complete'),summary:!!el.closest('[data-testid="binder-summary"]'),ms:performance.now()-start});
   }
  }).observe(document.body,{subtree:true,childList:true,characterData:true});
 });
 await page.getByRole('button',{name:'Load captured Online Boutique evidence',exact:true}).click();
 await expect(page.getByTestId('binder-summary').getByTestId('artifact-arrival-count')).toContainText('complete');
 const frames=await page.evaluate(()=>(window as any).loadFrames as {count:number;complete:boolean;summary:boolean;ms:number}[]);
 const timings={first:frames[0]?.ms,full:frames.find(f=>f.summary && f.complete)?.ms,final:frames.at(-1)?.count};
 await writeFile(info.outputPath('load-timing.json'),JSON.stringify({timings,frames},null,2));
 expect(timings.first).toBeLessThanOrEqual(2000);expect(timings.full).toBeLessThan(10000);
});
test('control selection paints the selected panel within 200 ms on the collected inventory',async({page},info)=>{
 await load(page);await navigateWorkspace(page,'map');await page.mouse.move(0,0);
 const timings=[];
 for(const id of ['AC-6','CM-8','SC-7']){
  const ms=await page.evaluate(id=>new Promise<number>(resolve=>{
   const start=performance.now();const observer=new MutationObserver(()=>{
    const selected=document.querySelector('[data-testid="pipeline-control-panel"] .panel-id');
    if(selected?.textContent===id){observer.disconnect();requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(performance.now()-start)));}
   });observer.observe(document.body,{childList:true,subtree:true});
   (document.querySelector(`[data-control-id="${id}"]`) as HTMLButtonElement).click();
  }),id);
  timings.push({id,ms});
  await page.getByRole('button',{name:'Close panel',exact:true}).click();
  await expect(page.getByTestId('package-map')).toHaveAttribute('data-layout-engine','round21');
 }
 await writeFile(info.outputPath('selection-timing.json'),JSON.stringify(timings,null,2));
 expect(timings).toHaveLength(3);for(const {ms} of timings)expect(ms).toBeLessThan(200);

});

test('current file proposals are unique and every collected citation shows its pinned upstream repo',async({page})=>{
 await load(page);
 const panel=page.getByTestId('mapping-proposals');await expect(panel).toContainText('145 pending');
 await expect(panel.locator('[data-proposal-artifact="authorization-review.json"]')).toHaveCount(1);
 await expect(panel.locator('[data-proposal-artifact="namespace-rbac.json"]')).toHaveCount(1);
 await expect(panel.locator('[data-proposal-artifact="namespace-rbac.json"]')).toContainText("captured measurements are separate");
 await expect(panel.locator('[data-proposal-artifact="namespace-rbac.json"]').getByTestId("source-repo")).toHaveAttribute("href","https://github.com/GoogleCloudPlatform/microservices-demo/tree/38e7348eb289eb5b87c0c6e8cb19ced0449dc389");
 const summary=page.getByTestId('binder-summary');await expect(summary.getByTestId('artifact-arrival-count')).toHaveText('197 artifacts loaded · complete');
 const href='https://github.com/GoogleCloudPlatform/microservices-demo/tree/38e7348eb289eb5b87c0c6e8cb19ced0449dc389';
 await expect(summary.getByTestId('summary-source-repos').getByRole('link',{name:'GoogleCloudPlatform/microservices-demo at 38e7348 ↗'})).toHaveAttribute('href',href);
 await panel.getByLabel('Find a proposed file').fill('network-policy-frontend.yaml');
 const row=panel.locator('[data-proposal-artifact]').first();await expect(row.getByTestId('source-repo')).toHaveAttribute('href',href);
 await row.getByText('Why these controls?',{exact:true}).click();await expect(row).toContainText(/network-policy-frontend\.yaml:\d+/);
 await navigateWorkspace(page,'map');await page.locator('[data-control-id="SC-7"]').click();
 await page.getByTestId('control-proposed-evidence').getByText('Inspect sources and facts',{exact:true}).click();
 await expect(page.getByTestId('control-proposed-evidence').getByTestId('source-repo').first()).toHaveAttribute('href',href);
});

test('expired authorization retest cannot close even with reviewer name and reason supplied',async({page})=>{
 await load(page);await navigateWorkspace(page,'map');await page.locator('[data-control-id="AC-6"]').click();
 await page.getByTestId('pipeline-control-panel').getByRole('button',{name:'Open plan of action',exact:true}).first().click();
 const drawer=page.getByTestId('plan-proposal');await drawer.getByRole('button',{name:'Accept proposed draft',exact:true}).click();
 await drawer.getByLabel('Closure name').fill('Local freshness reviewer');await drawer.getByLabel('Closure reason').fill('Checked the captured correction; it is expired and cannot authorize closure.');
 await expect(drawer).toContainText('retest expired');await expect(drawer.getByRole('button',{name:'Confirm closure',exact:true})).toBeDisabled();
});
