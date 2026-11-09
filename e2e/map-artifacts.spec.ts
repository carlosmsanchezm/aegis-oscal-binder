import {test,expect} from "@playwright/test";
import {type FixtureSize} from "../test/support/map-fixtures";
import {importFixture} from "./helpers/map-fixtures";
import {writeFileSync} from "node:fs";
test.use({trace:'off',video:'off'});
 for(const size of ["tiny","medium","huge","random"] as FixtureSize[])test(`${size} every artifact card highlights with native input`,async({page},info)=>{
  test.setTimeout(1800000);
  await page.setViewportSize({width:1920,height:1114});await importFixture(page,size);
  const picker=page.locator('.pipeline-file-picker');await picker.locator('summary').click();await picker.getByRole('button',{name:'Show all',exact:true}).click();await picker.locator('summary').click();
  const cards=await page.locator('[data-pipeline-file]').all();
  for(const [index,card] of cards.entries()){
   const painted=(expanded?:boolean)=>card.evaluate((node,expanded)=>node.classList.contains('active')&&/rgb\(191, 231, 223\).*2px/.test(getComputedStyle(node).boxShadow)&&(expanded===undefined||node.getAttribute('aria-expanded')===String(expanded)),expanded);
   await card.hover({force:true});await expect.poll(()=>painted(),{intervals:[20,30,50]}).toBe(true);
   await card.click({force:true});await page.mouse.move(0,0);await expect.poll(()=>painted(true),{intervals:[20,30,50]}).toBe(true);
   await page.keyboard.press('Escape');await expect.poll(()=>card.getAttribute('aria-expanded'),{intervals:[20,30,50]}).toBe('false');
   if((index+1)%250===0)console.info(`${size}: ${index+1} artifact cards checked`);
  }
  writeFileSync(info.outputPath('artifact-highlights.json'),JSON.stringify({size,cards:cards.length,nativeHover:true,nativeClick:true},null,2));
 });
