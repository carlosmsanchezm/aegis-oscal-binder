import { expect, test } from "@playwright/test";

test("sign in offers Google and Microsoft without workspace tabs", async ({ page }) => {
  await page.goto("/sign-in");
  await expect(page.getByRole("heading", { name: "Sign in with your work account" })).toBeVisible();
  await expect(page.getByTestId("sign-in-google")).toContainText("Continue with Google work account");
  await expect(page.getByTestId("sign-in-microsoft")).toContainText("Continue with Microsoft work account");
  await expect(page.getByTestId("workspace-navigation")).toHaveCount(0);
  await expect(page.getByTestId("account-honesty")).toContainText("Coverage only");
  await expect(page.locator("header")).toContainText("OSCAL binder");
});

test("sign in, claim a workspace, invite a viewer, and keep the planning demo", async ({ page, browser }) => {
  const admin = await page.request.post("/api/auth/test-session", { data: { email: "admin@example.test", name: "Admin Example", provider: "microsoft" } });
  expect(admin.ok()).toBeTruthy();
  await page.goto("/planning");
  await expect(page.locator("footer").getByRole("link", { name: "Account" })).toBeVisible();
  await page.getByRole("radio", { name: /FedRAMP Rev5/ }).check();
  await page.locator("summary").filter({ hasText: "More starting points" }).click();
  await page.locator("button.empty-start").filter({ hasText: "Load planning example" }).click();
  await expect(page.getByTestId("package-map")).toBeVisible();

  await page.goto("/account");
  await page.getByLabel("Organization name").fill("Example Org");
  await page.getByTestId("create-org").click();
  await expect(page.getByRole("heading", { name: "Workspaces" })).toBeVisible();
  await page.getByLabel("Workspace name").fill("Example boundary");
  await expect(page.getByRole("checkbox", { name: /Claim this browser/ })).toBeChecked();
  await page.getByTestId("create-workspace").click();
  await expect(page.getByTestId("package-map")).toBeVisible();
  const stillWriting = await page.request.post("/api/demo/sa1/oscal/ingest", { data: { catalog: "fedramp-rev5", filename: "empty.json", document: "{}" } });
  expect(stillWriting.status()).not.toBe(401);
  expect(stillWriting.status()).not.toBe(403);

  await page.goto("/account/members");
  await expect(page.getByTestId("role-limit")).toContainText("Your role is Admin");
  await page.getByLabel("Work email").fill("viewer@example.test");
  await page.getByLabel("Invitation role").selectOption("viewer");
  await page.getByTestId("send-invite").click();
  await expect(page.getByText("Email is not sent")).toBeVisible();
  const link = await page.getByTestId("invite-link").inputValue();
  await page.goto("/account/settings");
  await expect(page.getByTestId("settings-panel")).toContainText("Not built");
  await page.goto("/account/help");
  await expect(page.getByTestId("help-panel")).toContainText("Not built");

  const viewer = await browser.newContext();
  const viewerPage = await viewer.newPage();
  const signed = await viewerPage.request.post("/api/auth/test-session", { data: { email: "viewer@example.test", name: "Viewer Example", provider: "google" } });
  expect(signed.ok()).toBeTruthy();
  await viewerPage.goto(new URL(link).pathname);
  await viewerPage.getByTestId("join-workspace").click();
  await expect(viewerPage.getByRole("heading", { name: "Workspaces" })).toBeVisible();
  await viewerPage.goto("/account/members");
  await expect(viewerPage.getByTestId("role-limit")).toContainText("Your role is Viewer");
  await expect(viewerPage.getByTestId("send-invite")).toBeDisabled();
  const refused = await viewerPage.request.post("/api/account/invitations", { data: { email: "other@example.test", role: "engineer" } });
  expect(refused.status()).toBe(403);
  await viewerPage.goto("/account");
  await viewerPage.getByRole("button", { name: "Open workspace" }).click();
  await expect(viewerPage).toHaveURL(/\/planning/);
  const ingest = await viewerPage.request.post("/api/demo/sa1/oscal/ingest", { data: { catalog: "fedramp-rev5", filename: "empty.json", document: "{}" } });
  expect(ingest.status()).toBe(403);
  await viewer.close();
});
