/** Fixed diagnostic fields only: never serialize an exception, URL, key or body. */
export function backendFailureDiagnostic(error: unknown) {
  const e=error as {name?:string;message?:string;operation?:string;category?:string;upstreamStatus?:number};
  if(e?.name==="DurableStorageError")return {category:["http","network","backend"].includes(e.category??"")?e.category:"backend",operation:["read","write","list"].includes(e.operation??"")?e.operation:"unknown",...(Number.isInteger(e.upstreamStatus)&&e.upstreamStatus!>=400&&e.upstreamStatus!<=599?{upstreamStatus:e.upstreamStatus}:{})};
  const known:Record<string,string>={"Append-only chain verification failed.":"retained-chain-invalid","Concurrent append limit reached; retry the request.":"append-contention","Concurrent remediation update limit reached; retry the request.":"projection-contention","Evidence digest mismatch.":"retained-evidence-invalid","Pilot history limit reached; indexed storage is required.":"history-capacity"};
  return {category:known[e?.message??""]??"backend-unclassified"};
}
export function reportBackendFailure(error:unknown){console.error("Backend unavailable",backendFailureDiagnostic(error));}
