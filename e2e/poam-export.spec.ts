import { chooseStartingPoint, navigateWorkspace } from "./helpers/navigation";
import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { CCM_EXAMPLE } from "../lib/aegis/pipeline-evidence";
import { validatePlanOfAction } from "../lib/aegis/poam";
import { seedReceivedRetest } from "./receiver-seed";
import { loadSampleAssessment } from "./sample-assessment";

async function openIdentityReview(page: Page, load = true, assess = true) {
  await seedReceivedRetest(page);
  await page.goto("/planning/pipeline");
  await page.getByLabel("Evidence system").selectOption("example");await navigateWorkspace(page,"map");
  if (load) {
    await chooseStartingPoint(page, "Load planning example");
    await expect(page.getByTestId("package-map")).toBeVisible();
    await expect(page.getByRole("button", { name: "New package", exact: true })).toBeVisible();
    await expect(page.getByTestId("workspace-navigation")).toHaveAttribute("data-current-view", "map");
  }
  await navigateWorkspace(page, "release");
  await page.getByRole("button",{name:"View open security review items"}).click();
  if (assess) {
    await page.getByRole("button",{name:"Assess review item 1",exact:true}).click();
    await expect(page.getByTestId("assessment-drawer")).toBeVisible();
  }
}

test("assessment-only decisions restore from the server in a fresh tab",async({page,context})=>{
  await openIdentityReview(page);
  await page.getByLabel("Assessment rationale",{exact:true}).fill("Need runtime UID/GID evidence before deciding whether there is a deficiency.");
  await page.getByLabel("Supporting assessment reference",{exact:true}).fill("Internal review reference");
  await page.getByRole("button",{name:"Save assessment",exact:true}).click();
  await expect(page.getByTestId("assessment-drawer").getByRole("status")).toContainText("Assessment saved for this session.");
  const fresh = await context.newPage();
  let releaseRead!:()=>void;
  const readGate=new Promise<void>(resolve=>{releaseRead=resolve;});
  await fresh.route(/\/api\/remediation\?/,async route=>{
    await readGate;
    await route.continue().catch(()=>{});
  });
  await openIdentityReview(fresh,false,false);
  await expect(fresh.getByRole("button",{name:"Assess review item 1",exact:true})).toBeDisabled();
  releaseRead();
  await fresh.getByRole("button",{name:"Assess review item 1",exact:true}).click();
  await expect(fresh.getByLabel("Assessment rationale",{exact:true})).toHaveValue("Need runtime UID/GID evidence before deciding whether there is a deficiency.");
  await expect(fresh.getByLabel("Supporting assessment reference",{exact:true})).toHaveValue("Internal review reference");
  await expect(fresh.getByRole("radio",{name:"Needs verification",exact:true})).toBeChecked();
  const key = `binder.remediation.v1:${CCM_EXAMPLE.pipelineUrl}:${CCM_EXAMPLE.commitSha}`;
  const response = await fresh.request.get(`/api/remediation?key=${encodeURIComponent(key)}`);
  expect((await response.json()).record.plans).toEqual([]);
  await fresh.close();
});

test("failed assessment save reports failure and does not navigate to a draft",async({page})=>{
  const errors:string[]=[];
  page.on("pageerror",error=>errors.push(error.message));
  await openIdentityReview(page);
  await loadSampleAssessment(page);
  await page.route("**/api/remediation",route=>route.request().method()==="PUT" ? route.abort("failed") : route.continue());
  await page.getByRole("button",{name:"Prepare draft POA&M",exact:false}).click();
  await expect(page.getByTestId("assessment-drawer").getByRole("status")).toContainText("Assessment was not saved on the server.");
  await expect(page.getByTestId("assessment-drawer")).toBeVisible();
  await expect(page.getByTestId("draft-drawer")).toBeHidden();
  expect(errors).toEqual([]);
});

test("CM-6 recorded retest downloads a schema-valid, traceable, open OSCAL file",async({page},testInfo)=>{
  await openIdentityReview(page);
  await loadSampleAssessment(page);
  await page.getByRole("button",{name:"Prepare draft POA&M",exact:false}).click();
  await page.getByRole("button",{name:"Save draft",exact:true}).click();
  await expect(page.getByTestId("remediation-workspace")).toBeVisible();
  await page.getByRole("button",{name:"Apply received retest",exact:true}).click();
  await expect(page.getByLabel("Corrective action",{exact:true})).toHaveValue(/10001/);
  await page.getByRole("button",{name:"Record engineering completion",exact:true}).click();
  await expect(page.getByTestId("remediation-workspace").getByRole("status")).toContainText("Draft saved for this session.");
  await page.getByRole("button",{name:"View plan of action",exact:true}).click();
  const dialog=page.getByTestId("plan-of-action");
  await expect(dialog).toContainText("CM-6");
  await expect(dialog).toContainText("cmsanchezm");
  await expect(dialog.locator(".rem-example")).toHaveCount(0);
  await expect(dialog).toContainText("Recorded evidence");
  await page.screenshot({path:testInfo.outputPath("plan-of-action-overview.png")});
  await dialog.getByText("Assessment & decision record",{exact:true}).click();
  await expect(dialog).toContainText("Not recorded with complete closure requirements");
  await page.screenshot({path:testInfo.outputPath("plan-of-action-decision-record.png")});
  const downloading=page.waitForEvent("download");
  await dialog.getByRole("button",{name:"Download OSCAL plan of action",exact:true}).click();
  const download=await downloading;
  expect(download.suggestedFilename()).toBe("plan-of-action-and-milestones.json");
  const file=await download.path();
  expect(file).not.toBeNull();
  const document=JSON.parse(readFileSync(file!,"utf8"));
  expect(validatePlanOfAction(document)).toEqual({ok:true});
  const body=document["plan-of-action-and-milestones"];
  expect(body["system-id"]["identifier-type"]).toBe("urn:aegis:system-id:internal");
  expect(body.risks[0].status).toBe("open");
  expect(body["poam-items"][0].props).toEqual(expect.arrayContaining([
    expect.objectContaining({name:"control-id",value:"CM-6"}),
  ]));
  const draft=JSON.parse(Buffer.from(body["back-matter"].resources[0].base64.value,"base64").toString("utf8"));
  expect(draft.assessment.illustrative).toBe(true);
  expect(draft.tests).toHaveLength(3);
  expect(draft.tests.every((test:{illustrative:boolean})=>test.illustrative===false)).toBe(true);
  expect(draft.releaseRef).toContain("2908682168");
  expect(draft.closure.recorded).toBe(false);
  await dialog.getByRole("button",{name:"Close plan of action",exact:true}).click();
  await expect(page.getByTestId("remediation-workspace")).toBeVisible();
});

test("draft rows stay awaiting result while stored retest evidence is already in both downloads",async({page})=>{
  await openIdentityReview(page);
  await loadSampleAssessment(page);
  await page.getByRole("button",{name:"Prepare draft POA&M",exact:false}).click();
  await page.getByRole("button",{name:"Save draft",exact:true}).click();
  await expect(page.getByTestId("remediation-workspace")).toBeVisible();
  for (const view of [
    {button:"View plan of action",testId:"plan-of-action",download:"Download OSCAL plan of action",root:"plan-of-action-and-milestones",close:"Close plan of action"},
    {button:"View assessment results",testId:"assessment-results",download:"Download OSCAL assessment results",root:"assessment-results",close:"Close assessment results"},
  ]) {
    await page.getByRole("button",{name:view.button,exact:true}).click();
    const dialog=page.getByTestId(view.testId);
    await expect(dialog.getByText("Awaiting result",{exact:true})).toHaveCount(3);
    await expect(dialog.getByText("Recorded evidence",{exact:true})).toHaveCount(0);
    const downloading=page.waitForEvent("download");
    await dialog.getByRole("button",{name:view.download,exact:true}).click();
    const download=await downloading;
    const file=await download.path();
    expect(file).not.toBeNull();
    const document=JSON.parse(readFileSync(file!,"utf8"));
    const body=view.root==="assessment-results" ? document[view.root].results[0] : document[view.root];
    const cm6 = body.observations.find((item: { props?: { name: string; value: string }[] }) => item.props?.some((prop) => prop.name === "control-id" && prop.value === "CM-6"));
    const evidence = JSON.stringify(cm6["relevant-evidence"]);
    expect(evidence).toContain("Configuration rescan no longer reports KSV-0020 or KSV-0021");
    expect(evidence).toContain("Actual application process UID and GID match the corrected manifest");
    expect(evidence).toContain("Corrected workload remains ready and /healthz succeeds");
    expect(cm6.methods).toContain("TEST");
    expect(body.risks[0].status).toBe("open");
    expect(body.risks[0].remediations[0].props.filter((p:{name:string})=>p.name==="required-verification")).toHaveLength(3);
    expect(JSON.stringify(body)).not.toContain("agency-system-id");
    const items = body["poam-items"] as { props: { name: string }[] }[] | undefined;
    if (items) expect(items[0].props.some((prop) => prop.name === "owner" || prop.name === "poam-id")).toBe(false);
    await dialog.getByRole("button",{name:view.close,exact:true}).click();
    await expect(page.getByTestId("remediation-workspace")).toBeVisible();
  }
});
