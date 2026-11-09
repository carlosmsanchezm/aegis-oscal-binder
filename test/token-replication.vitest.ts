import {it,expect,vi} from "vitest";
import {freshTokenRead} from "../lib/github/token-replication";
it("retries a newly minted token's read using the same operation, with a bounded grace period",async()=>{
 let now=100;const delays:number[]=[],clock={now:()=>now,sleep:async(ms:number)=>{delays.push(ms);now+=ms;}};
 const read=vi.fn().mockRejectedValueOnce({status:404}).mockResolvedValue("verified");
 expect(await freshTokenRead("GET",100,read,clock)).toBe("verified");expect(read).toHaveBeenCalledTimes(2);expect(delays).toEqual([1000]);
 now=100;delays.length=0;const missing=vi.fn().mockRejectedValue({status:404});
 await expect(freshTokenRead("HEAD",100,missing,clock)).rejects.toEqual({status:404});expect(missing).toHaveBeenCalledTimes(4);expect(delays).toEqual([1000,2000,2000]);
});
it("never replays a write, retries a policy denial, or extends an old token's grace",async()=>{
 for(const [method,status,mintedAt] of [["POST",404,100],["PATCH",401,100],["GET",403,100],["GET",404,0]] as const){
  const read=vi.fn().mockRejectedValue({status}),sleep=vi.fn();
  await expect(freshTokenRead(method,mintedAt,read,{now:()=>mintedAt===0?6000:100,sleep})).rejects.toEqual({status});expect(read).toHaveBeenCalledTimes(1);expect(sleep).not.toHaveBeenCalled();
 }
});
