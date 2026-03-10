// @ts-check
const { test, expect } = require("@playwright/test");
const fs = require("node:fs");
const path = require("node:path");

const BASE_UI_URL = process.env.DEMO_UI_URL ?? "http://localhost:3000";
const OUTPUT_DIR = path.resolve(process.cwd(), "artifacts", "demo-recording");

test.use({
  viewport: { width: 1366, height: 768 },
  video: "on"
});

test("record full demo flow", async ({ page }, testInfo) => {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  await page.goto(BASE_UI_URL, { waitUntil: "networkidle" });

  await page.getByLabel("Username").fill("hr_bot_user");
  await page.getByLabel("Password").fill("hr-demo-2026");
  await page.getByRole("button", { name: "Login" }).click();
  await expect(page.getByText("token issued", { exact: false }).first()).toBeVisible({ timeout: 20_000 });

  await page
    .getByLabel("Message")
    .fill("Summarize onboarding guidance and show employee headcount by department");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(
    page.getByText(/Wiki search found|Wiki search returned no hits/, { exact: false }).first()
  ).toBeVisible({ timeout: 45_000 });
  await expect(page.getByText("SQL query returned", { exact: false }).first()).toBeVisible({ timeout: 20_000 });

  await page.getByRole("link", { name: "View Audit Logs" }).click();
  await expect(page).toHaveURL(/\/audit/);
  await page.getByRole("button", { name: "Refresh" }).click();
  await expect(page.getByText("allow", { exact: false }).first()).toBeVisible({ timeout: 20_000 });

  await page.getByRole("link", { name: "Back To Chat" }).click();
  await expect(page).toHaveURL(/\/$/);

  await page.getByLabel("Username").fill("marketing_bot_user");
  await page.getByLabel("Password").fill("marketing-demo-2026");
  await page.getByRole("button", { name: "Login" }).click();
  await expect(page.getByText("token issued", { exact: false }).first()).toBeVisible({ timeout: 20_000 });
  await page.getByLabel("Message").fill("Show employee headcount by department");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByText(/DENY_SOURCE_NOT_ALLOWED|Blocked Calls|forbidden/, { exact: false }).first()).toBeVisible({
    timeout: 45_000
  });

  await page.waitForTimeout(1500);
  await page.screenshot({ path: path.join(OUTPUT_DIR, "final-frame.png"), fullPage: true });

  await testInfo.attach("final-frame", {
    body: fs.readFileSync(path.join(OUTPUT_DIR, "final-frame.png")),
    contentType: "image/png"
  });
});
