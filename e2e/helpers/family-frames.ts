import {expect,type Page} from "@playwright/test";

/** Lowest painted opacity a family frame, header or name may have in any map state. */
export const FAMILY_FRAME_MIN_OPACITY=0.9;
/** Lowest painted opacity an unrelated control card may drop to; below this its face is not legible. */
export const CARD_MIN_OPACITY=0.5;

/** Every family that holds a painted control, with the painted opacity (ancestors included) and size of its frame, header and name. */
export async function familyFrameVisibility(page:Page){
 return page.getByTestId("package-map").evaluate(map=>{
  const effective=(node:Element)=>{
   let opacity=1;
   for(let el:Element|null=node;el&&el!==map.parentElement;el=el.parentElement){
    const style=getComputedStyle(el);
    if(style.display==="none"||style.visibility==="hidden")return 0;
    opacity*=Number(style.opacity);
   }
   return Math.round(opacity*1000)/1000;
  };
  const painted=(node:Element)=>{const box=node.getBoundingClientRect();return box.width>0&&box.height>0;};
  const item=(node:Element|null|undefined)=>node?{opacity:effective(node),painted:painted(node),text:node.textContent?.trim()??""}:null;
  const cards=[...map.querySelectorAll<HTMLElement>(".pmap-control[data-family]")].filter(card=>painted(card)&&effective(card)>0);
  const families=[...new Set(cards.map(card=>card.dataset.family!))].sort();
  return {
   planning:map.classList.contains('pmap-focus-layout'),
   families:families.map(id=>{
    const header=map.querySelector(`[data-family-header="${CSS.escape(id)}"]`);
    return {id,focus:map.querySelector(`[data-family-box="${CSS.escape(id)}"]`)?.getAttribute('data-focus'),box:item(map.querySelector(`[data-family-box="${CSS.escape(id)}"]`)),header:item(header),name:item(header?.querySelector(".pmap-family-open, strong"))};
   }),
   cards:cards.map(card=>({id:card.dataset.controlId!,family:card.dataset.family!,opacity:effective(card),related:card.dataset.relatedControl!=null,selected:card.getAttribute("aria-pressed")==="true"})),
  };
 });
}

/** Family frames, headers and names stay painted at full strength; unrelated control cards stay legible. */
export async function expectFamilyFramesVisible(page:Page){
 await expect.poll(async()=>{
  const {planning,families,cards}=await familyFrameVisibility(page);
  const hidden=families.flatMap(row=>(["box","header","name"] as const)
   .filter(part=>{const item=row[part];return !item||!item.painted||(planning?item.opacity!==(row.focus==='far'?.6:1):item.opacity<FAMILY_FRAME_MIN_OPACITY)||(part==="name"&&item.text!==row.id);})
   .map(part=>`${row.id} ${part} ${JSON.stringify(row[part])}`));
  const faint=cards.filter(card=>card.opacity<CARD_MIN_OPACITY).map(card=>`${card.id} card ${card.opacity}`);
  return families.length?[...hidden,...faint]:["no family holds a painted control"];
 },{message:"family structure stays visible in a selected or focused map"}).toEqual([]);
}

/** Related lines leave the selected card and end on related cards that are painted at full strength inside visible families. */
export async function expectSelectedRelationsVisible(page:Page,selectedId:string){
 const map=page.getByTestId("package-map");
 await expect(map.locator(`.pmap-control[data-control-id="${selectedId}"]`)).toHaveAttribute("aria-pressed","true");
 await expectFamilyFramesVisible(page);
 const {cards}=await familyFrameVisibility(page);
 if(!cards.some(card=>card.related))return;
 await expect(map.locator('path[data-rel="related"][d=""]')).toHaveCount(0);
 const lines=await map.locator('svg.pmap-wires path[data-rel="related"]').evaluateAll(nodes=>nodes.map(node=>({
  from:node.getAttribute("data-from")!,to:node.getAttribute("data-to")!,opacity:Number(getComputedStyle(node).opacity),length:(node as SVGPathElement).getTotalLength(),
 })));
 expect(lines.length,`${selectedId} draws related lines`).toBeGreaterThan(0);
 for(const line of lines){
  expect(line.from===selectedId||line.to===selectedId,`${line.from}->${line.to} touches ${selectedId}`).toBe(true);
  expect(line.opacity,`${line.from}->${line.to} opacity`).toBeGreaterThanOrEqual(FAMILY_FRAME_MIN_OPACITY);
  expect(line.length,`${line.from}->${line.to} length`).toBeGreaterThan(0);
 }
 const ends=new Set(lines.map(line=>line.from===selectedId?line.to:line.from));
 await expect.poll(async()=>(await familyFrameVisibility(page)).cards.filter(card=>(card.selected||ends.has(card.id))&&card.opacity<FAMILY_FRAME_MIN_OPACITY).map(card=>`${card.id} ${card.opacity}`),{message:"selected and related cards are painted at full strength"}).toEqual([]);
}
