import type {Page} from "@playwright/test";
import {createHash} from "node:crypto";
import after from "../../lib/reference/online-boutique-after.json" with {type:"json"};
export const referenceAuthorizationPlan = "Open proposed plan AC-6 · Failed check: frontend-secret-read";
export const referencePlanCount = 5;

export const referenceAuthorizationRetestId = createHash("sha256").update(after.rawEvent).digest("hex");

export async function selectAuthorizationRetest(page:Page) {
 const selector=page.getByLabel("Release selection",{exact:true});
 const value=await selector.locator("option").evaluateAll((options,id)=>options.map(option=>(option as HTMLOptionElement).value).find(value=>value.includes(id)),referenceAuthorizationRetestId);
 if(!value) throw new Error("Original authorization retest receipt is missing");
 await selector.selectOption(value);
}
