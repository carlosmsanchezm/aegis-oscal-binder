import {it,expect,vi} from "vitest";
import {connectedRequest} from "../scripts/demo/connected-request";
const address=new URL("https://demo.example"),headers={cookie:"synthetic"};
it("retries transient refresh unavailability and records each retry, without treating it as proof",async()=>{
 const fetch=vi.fn().mockResolvedValueOnce(new Response(null,{status:503})).mockResolvedValueOnce(Response.json({ok:true})),sleep=vi.fn().mockResolvedValue(undefined),mark=vi.fn();
 const response=await connectedRequest(address,"/api/remediation/fix-runner",headers,{operation:"refresh"},mark,{fetch,sleep});
 expect(await response.json()).toEqual({ok:true});expect(fetch).toHaveBeenCalledTimes(2);expect(mark).toHaveBeenCalledWith(1,503);expect(sleep).toHaveBeenCalledWith(2000);
});
it("exhausts bounded service retries and refuses authorization, uncertain transport, or provider writes immediately",async()=>{
 for(const status of [403,409,422,500,502,503,504]){
  const fetch=vi.fn().mockResolvedValue(new Response(null,{status})),mark=vi.fn();
  await expect(connectedRequest(address,"/api/builder",headers,undefined,mark,{fetch,sleep:async()=>{}})).rejects.toMatchObject({httpStatus:status});
  expect(fetch).toHaveBeenCalledTimes([500,502,503,504].includes(status)?4:1);
 }
 const fetch=vi.fn().mockResolvedValue(new Response(null,{status:503}));
 await expect(connectedRequest(address,"/api/remediation/fix-runner",headers,{operation:"enqueue"},()=>{},{fetch,sleep:async()=>{}})).rejects.toMatchObject({httpStatus:503});expect(fetch).toHaveBeenCalledTimes(1);
 const transport=vi.fn().mockRejectedValue(new TypeError("unavailable"));
 await expect(connectedRequest(address,"/api/builder",headers,undefined,()=>{},{fetch:transport,sleep:async()=>{}})).rejects.toBeInstanceOf(TypeError);expect(transport).toHaveBeenCalledTimes(1);
});
