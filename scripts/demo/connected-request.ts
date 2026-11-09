/** Retry only explicitly idempotent demo reads/refreshes after service unavailability. */
export async function connectedRequest(address:URL,route:string,headers:Record<string,string>,body:unknown,onRetry:(attempt:number,status:number)=>void,io:{fetch:typeof fetch;sleep:(ms:number)=>Promise<void>}={fetch,sleep:ms=>new Promise(resolve=>setTimeout(resolve,ms))}){
 const retryable=body===undefined||(route==="/api/remediation/fix-runner"&&(body as {operation?:string})?.operation==="refresh")||route==="/api/pipeline/github/collect";
 for(let attempt=1;;attempt++){
  // Native collection includes the bounded 300-second deployment function budget.
  const response=await io.fetch(new URL(route,address),{method:body?"POST":"GET",headers,...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(route==="/api/pipeline/github/collect"?330000:180000)});
  if(response.ok)return response;
  if([500,502,503,504].includes(response.status)&&retryable&&attempt<4){await response.body?.cancel();onRetry(attempt,response.status);await io.sleep(attempt*2000);continue;}
  throw Object.assign(new Error("Demo request refused; inspect the authenticated app."),{httpStatus:response.status});
 }
}
