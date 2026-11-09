import { createHmac } from "node:crypto";
import { expect, type Page } from "@playwright/test";
import { retestEvent } from "../test/support/received-retest";
import { CCM_EXAMPLE } from "../lib/aegis/pipeline-evidence";

export async function seedReceivedRetest(page: Page) {
  // Only the isolated local test server uses this test credential. Never contacts a live host.
  const body=JSON.stringify(retestEvent());
  const signature=createHmac("sha256","local-browser-test-only").update(body).digest("hex");
  const response=await page.request.post("/api/pipeline/events",{data:body,headers:{"content-type":"application/json","X-Aegis-Signature":`sha256=${signature}`}});
  expect(response.status()).toBe(200);
  await page.addInitScript(summary=>sessionStorage.setItem("aegis.planning.release.v1",JSON.stringify(summary)),{
    data:{...CCM_EXAMPLE,subject:{pipelineId:CCM_EXAMPLE.pipelineId,pipelineUrl:CCM_EXAMPLE.pipelineUrl,commitSha:CCM_EXAMPLE.commitSha,image:CCM_EXAMPLE.image,createdAt:CCM_EXAMPLE.createdAt},controlFamilies:CCM_EXAMPLE.families,evidenceGaps:CCM_EXAMPLE.gaps,runtime:{...CCM_EXAMPLE.runtime,observations:[{ready:true,meshSidecarPresent:false},{ready:true,meshSidecarPresent:false}]}},
    provenance:{pipelineId:CCM_EXAMPLE.pipelineId,jobId:CCM_EXAMPLE.artifactJobId},
  });
}
