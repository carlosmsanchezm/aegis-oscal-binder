/** GitHub documents brief 404/401 replication lag for newly minted installation tokens.
 * Retry reads with that same token only; never replay provider writes or remint it.
 */
export async function freshTokenRead<T>(method:string,mintedAt:number,read:()=>Promise<T>,clock={now:()=>Date.now(),sleep:(ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms))}):Promise<T>{
 for(let attempt=0;;attempt++){
  try{return await read();}
  catch(error){
   const status=(error as {status?:number})?.status,age=clock.now()-mintedAt;
   if(!["GET","HEAD"].includes(method.toUpperCase())||![401,404].includes(status??0)||age<0||age>=5000||attempt>=3)throw error;
   await clock.sleep(Math.min([1000,2000,2000][attempt],5000-age));
  }
 }
}
