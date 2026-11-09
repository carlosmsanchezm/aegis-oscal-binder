import {it,expect} from "vitest";
import {generateKeyPairSync} from "node:crypto";
import {spawnSync} from "node:child_process";
import {readFileSync} from "node:fs";
/** Keys are generated inside this test only, never by the demo or application. */
it.skipIf(process.env.AEGIS_LIVE_DEMO!=="1")("live collector → stdio MCP demo → signed offline export and tamper refusal",()=>{
 const pair=generateKeyPairSync("ed25519");
 const result=spawnSync("pnpm",["agent:demo"],{encoding:"utf8",timeout:180_000,env:{...process.env,AEGIS_DEMO_TEST_SIGNER:"1",AEGIS_MANIFEST_SIGNING_KEY:Buffer.from(pair.privateKey.export({type:"pkcs8",format:"pem"})).toString("base64"),AEGIS_MANIFEST_PUBLIC_KEY:Buffer.from(pair.publicKey.export({type:"spki",format:"pem"})).toString("base64")}});
 // Do not echo child error objects, environment, or key material.
 expect(result.status,"Live demo failed; see the redacted transcript CI artifact.").toBe(0);
 const report=JSON.parse(readFileSync("out/agent-demo/report.json","utf8"));
 expect(report).toMatchObject({source:"live GitHub fetch",recorded:false,manifestStatus:"signed",verifyExitCode:0,tamperExitCode:1,closureConfirmed:false,measuredRetestFixed:true});
 expect(typeof report.retestFresh).toBe("boolean");
 expect(report.readyForClosureReview).toBe(report.retestFresh);
 expect(report.staleRetestRefused).toBe(!report.retestFresh);
 expect(report.chain.valid).toBe(true);expect(report.timeline.filter((r:any)=>typeof r.body.summary.configurationFindings==="number").map((r:any)=>r.body.summary.configurationFindings)).toEqual([79,77]);
},200_000);
