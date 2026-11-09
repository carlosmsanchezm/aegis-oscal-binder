export type CapturedEvent={id:string;rawEvent:string};
/** Independent receipts can be retained concurrently; finish all in-flight writes
 * before reporting failure or refreshing the workspace. No timers or reread loop. */
export async function importEvidenceEvents(events:CapturedEvent[],publish:(event:CapturedEvent)=>Promise<void>,arrived:(event:CapturedEvent)=>void){
 let next=0,error:unknown,failed=false;
 const workers=Array.from({length:Math.min(4,events.length)},async()=>{
  while(!failed && next<events.length){
   const event=events[next++];
   try{await publish(event);arrived(event);}catch(cause){if(!failed){failed=true;error=cause ?? new Error('Observation import failed.');}}
  }
 });
 await Promise.all(workers);
 if(failed)throw error;
}
