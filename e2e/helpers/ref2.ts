import {expect,type Page} from "@playwright/test";
import {settleMap} from './map-3b';
import {navigateWorkspace,chooseStartingPoint} from "./navigation";
export async function loadRef2(page:Page){
 await page.route('**/api/pipeline/events',route=>route.fulfill({json:{ok:true,configured:false,evidence:null,releases:[]}}));
 await page.goto('/planning');await page.getByLabel('Evidence system').selectOption('example');
 await chooseStartingPoint(page,'Load planning example');
 await expect(page.getByRole('button',{name:'New package',exact:true})).toBeVisible();
 await navigateWorkspace(page,'map');
 await page.locator('.round21-snapshot > summary').click();await page.getByRole('option').filter({hasText:'#2894050908'}).click();
 const map=page.getByTestId('package-map');
 for(const name of ['SSP evidence','Missing','Suggested','Related','By family'])if(await map.getByRole('button',{name,exact:true}).getAttribute('aria-pressed')!=='true')await map.getByRole('button',{name,exact:true}).click();
 await expect(map.getByRole('button',{name:'Roles',exact:true})).toHaveCount(0);
 await expect(map.locator('.pmap-role')).toHaveCount(0);
 await expect(page.getByRole('checkbox',{name:'Show untouched controls'})).not.toBeChecked();
 await settleMap(page);
}
