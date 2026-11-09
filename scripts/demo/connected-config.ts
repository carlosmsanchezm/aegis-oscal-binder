import {workerConfigs,privateFile} from "./launcher";
export function connectedConfig(env:NodeJS.ProcessEnv=process.env){
 const address=new URL(env.AEGIS_DEMO_URL??"");
 if(address.username||address.password||address.search||address.hash||address.pathname!=="/"||(address.protocol!=="https:"&&!(["127.0.0.1","localhost"].includes(address.hostname)&&address.protocol==="http:")))throw new Error("Use an HTTPS demo origin or HTTP loopback.");
 if(env.AEGIS_DEMO_ACK_SYNTHETIC!=="true")throw new Error("A dedicated synthetic connection must be acknowledged.");
 // Exact private identity; never default to the public reference fork.
 const repo=env.AEGIS_DEMO_REPO;
 if(repo!=="carlosmsanchezm/aegis-boutique-demo-private")throw new Error("The enumerated private demo repository is required.");
 if(!env.AEGIS_DEMO_COOKIE_FILE||!env.AEGIS_DEMO_WORKERS_FILE)throw new Error("Private owner-cookie and worker configuration files are required.");
 const cookie=privateFile(env.AEGIS_DEMO_COOKIE_FILE),workers=workerConfigs(env.AEGIS_DEMO_WORKERS_FILE);
 if(!cookie||/[\r\n]/.test(cookie))throw new Error("A cookie header is required.");
 const sourceRun=env.AEGIS_DEMO_SOURCE_RUN?Number(env.AEGIS_DEMO_SOURCE_RUN):undefined;
 if(sourceRun!==undefined&&(!Number.isSafeInteger(sourceRun)||sourceRun<=0))throw new Error("Invalid exact source run.");
 const timeout=Number(env.AEGIS_DEMO_TIMEOUT_MS??1800000);
 if(!Number.isSafeInteger(timeout)||timeout<1000||timeout>7200000)throw new Error("Timeout must be from 1000 to 7200000 ms.");
 return {address,repo,cookie,workers,sourceRun,timeout,ref:env.AEGIS_DEMO_REF??"codex/phase4-synthetic"};
}
