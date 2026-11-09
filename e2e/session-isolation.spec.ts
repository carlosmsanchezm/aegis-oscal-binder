import { expect, test } from "@playwright/test";

test("two browsers keep separate packages and reset returns one to empty", async ({ page, browser, baseURL }) => {
  const origin = baseURL ?? "http://127.0.0.1:3000";
  const contextB = await browser.newContext();
  const pageB = await contextB.newPage();

  await page.goto("/workspace?editor=classic");
  await expect(page.getByRole("heading", { name: "No package loaded" })).toBeVisible();
  await page.getByRole("radio", { name: /FedRAMP Rev5/ }).check();
  await page.getByLabel("OSCAL package").setInputFiles("public/samples/sample-oscal-ssp-rev5.json");
  await page.getByRole("button", { name: "Upload OSCAL" }).click();
  await expect(page.getByText("Upload sample CSP").first()).toBeVisible();
  await expect(page.getByText("bnd-upload-rev5")).toBeVisible();
  await expect(page.getByRole("button", { name: "New package" })).toBeVisible();

  const cookiesA = await page.context().cookies();
  const sessionA = cookiesA.find((cookie) => cookie.name === "aegis_sid");
  expect(sessionA?.httpOnly).toBe(true);
  expect(sessionA?.sameSite).toBe("Lax");

  await pageB.goto(`${origin}/workspace?editor=classic`);
  await expect(pageB.getByRole("heading", { name: "No package loaded" })).toBeVisible();
  await expect(pageB.getByRole("button", { name: "Upload OSCAL" })).toBeDisabled();
  await pageB.getByRole("radio", { name: /FedRAMP Rev5/ }).check();
  await expect(pageB.getByRole("button", { name: "Upload OSCAL" })).toBeDisabled();
  await expect(pageB.getByRole("button", { name: "Load demo sample package" })).toBeEnabled();
  await pageB.getByLabel("OSCAL package").setInputFiles("public/samples/sample-oscal-ssp-rev5.json");
  await pageB.getByRole("button", { name: "Upload OSCAL" }).click();
  await expect(pageB.getByText("Upload sample CSP").first()).toBeVisible();
  await expect(pageB.getByText("bnd-upload-rev5")).toBeVisible();

  const cookiesB = await contextB.cookies();
  const sessionB = cookiesB.find((cookie) => cookie.name === "aegis_sid");
  expect(sessionB?.value).toBeTruthy();
  expect(sessionB?.value).not.toBe(sessionA?.value);

  await page.reload();
  await expect(page.getByText("Upload sample CSP").first()).toBeVisible();
  await expect(page.getByRole("heading", { name: "No package loaded" })).toHaveCount(0);

  const anon = await browser.newContext();
  const anonPackage = await (await anon.request.get(`${origin}/api/package`)).json();
  expect(anonPackage.packageState.loaded).toBe(false);
  expect(anonPackage.packageState.workspaceName).toBeNull();
  await anon.close();

  await page.getByRole("button", { name: "New package" }).click();
  await expect(page.getByRole("heading", { name: "No package loaded" })).toBeVisible();
  await expect(page.getByText("None loaded")).toBeVisible();
  await expect(page.getByRole("radio", { name: /FedRAMP Rev5/ })).toBeChecked();
  await expect(page.getByRole("button", { name: "Upload OSCAL" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Load demo sample package" })).toBeEnabled();

  await expect(pageB.getByText("bnd-upload-rev5")).toBeVisible();
  await expect(pageB.getByRole("heading", { name: "No package loaded" })).toHaveCount(0);
  const stillB = await (await contextB.request.get(`${origin}/api/package`)).json();
  expect(stillB.packageState.loaded).toBe(true);
  expect(stillB.packageState.boundaryId).toBe("bnd-upload-rev5");

  await contextB.close();
});
