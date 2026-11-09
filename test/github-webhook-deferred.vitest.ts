import {it,expect,vi,afterEach} from "vitest";
import {createHmac,generateKeyPairSync} from "node:crypto";
const handlers=vi.hoisted(()=>({pr:vi.fn(),gate:vi.fn()}));
vi.mock("../lib/github/pull-requests",()=>({applyPrWebhook:handlers.pr}));
vi.mock("../lib/github/poam-gate",()=>({poamGateWebhook:handlers.gate}));
import {receiveGithubWebhook} from "../lib/github/connect";
const secret="synthetic-webhook-test-only";
const key=generateKeyPairSync("rsa",{modulusLength:2048}).privateKey.export({type:"pkcs8",format:"pem"}).toString();
afterEach(()=>{vi.unstubAllEnvs();vi.restoreAllMocks();handlers.pr.mockReset();handlers.gate.mockReset();});
function setup(){vi.stubEnv("GITHUB_APP_ID","42");vi.stubEnv("GITHUB_APP_SLUG","synthetic");vi.stubEnv("GITHUB_APP_PRIVATE_KEY",key);vi.stubEnv("GITHUB_APP_WEBHOOK_SECRET",secret);}
function request(event="pull_request",raw="{}",valid=true){return new Request("https://demo.example/api/github/webhook",{method:"POST",body:raw,headers:{"x-github-event":event,"x-hub-signature-256":valid?"sha256="+createHmac("sha256",secret).update(raw).digest("hex"):"sha256=00"}});}
it("acknowledges a verified PR delivery before provider refresh and executes the same real pipeline afterward",async()=>{
 setup();const jobs:(()=>Promise<void>)[]=[];
 const response=await receiveGithubWebhook(request(),job=>jobs.push(job));
 expect(response.status).toBe(200);expect(await response.json()).toEqual({ok:true,processing:"scheduled"});expect(handlers.pr).not.toHaveBeenCalled();expect(jobs).toHaveLength(1);
 await jobs[0]();expect(handlers.pr).toHaveBeenCalledWith("pull_request",{});expect(handlers.gate).toHaveBeenCalledWith("pull_request",{});
});
it("refuses invalid signatures, malformed JSON and oversized bodies before scheduling",async()=>{
 setup();const schedule=vi.fn();
 for(const [req,status] of [[request("pull_request","{}",false),401],[request("pull_request","{"),400],[request("pull_request","x".repeat(1_000_001)),413]] as const)await expect(receiveGithubWebhook(req,schedule)).rejects.toMatchObject({status});
 expect(schedule).not.toHaveBeenCalled();expect(handlers.pr).not.toHaveBeenCalled();
});
it("keeps non-PR installation handling synchronous and reports deferred failures without payloads",async()=>{
 setup();const schedule=vi.fn();await receiveGithubWebhook(request("installation"),schedule);expect(schedule).not.toHaveBeenCalled();expect(handlers.pr).toHaveBeenCalledTimes(1);
 const log=vi.spyOn(console,"error").mockImplementation(()=>{}),jobs:(()=>Promise<void>)[]=[];
 handlers.pr.mockRejectedValueOnce(new Error("synthetic-private-payload-do-not-log"));await receiveGithubWebhook(request(),job=>jobs.push(job));await jobs[0]();
 expect(log).toHaveBeenCalledWith("GitHub webhook refresh failed",{status:0,category:"refresh-unavailable"});expect(JSON.stringify(log.mock.calls)).not.toContain("synthetic-private-payload");
});
