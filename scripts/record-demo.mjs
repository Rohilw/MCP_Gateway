import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { chromium } from "playwright";

const BASE_UI_URL = process.env.DEMO_UI_URL ?? "http://localhost:3000";
const OUTPUT_DIR = path.resolve(process.cwd(), "artifacts", "demo-recording");

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

async function waitForAnyText(page, candidates, timeoutMs = 45_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    for (const candidate of candidates) {
      const visible = await page.getByText(candidate, { exact: false }).first().isVisible().catch(() => false);
      if (visible) {
        return candidate;
      }
    }
    await page.waitForTimeout(250);
  }
  throw new Error(`Timed out waiting for one of: ${candidates.join(", ")}`);
}

async function run() {
  ensureDir(OUTPUT_DIR);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1366, height: 768 },
    recordVideo: {
      dir: OUTPUT_DIR,
      size: { width: 1366, height: 768 }
    }
  });

  const page = await context.newPage();
  await page.goto(BASE_UI_URL, { waitUntil: "networkidle" });

  await page.getByLabel("Username").fill("hr_bot_user");
  await page.getByLabel("Password").fill("hr-demo-2026");
  await page.getByRole("button", { name: "Login" }).click();
  await page.getByText("token issued", { exact: false }).first().waitFor({ timeout: 20_000 });

  await page.getByLabel("Message").fill("Summarize onboarding guidance and show employee headcount by department");
  await page.getByRole("button", { name: "Send" }).click();
  await waitForAnyText(page, ["Wiki search found", "Wiki search returned no hits"]);
  await page.getByText("SQL query returned", { exact: false }).first().waitFor({ timeout: 20_000 });

  await page.getByRole("link", { name: "View Audit Logs" }).click();
  await page.waitForURL("**/audit", { timeout: 20_000 });
  await page.getByRole("button", { name: "Refresh" }).click();
  await page.getByText("allow", { exact: false }).first().waitFor({ timeout: 20_000 });

  await page.getByRole("link", { name: "Back To Chat" }).click();
  await page.waitForURL("**/", { timeout: 20_000 });

  await page.getByLabel("Username").fill("marketing_bot_user");
  await page.getByLabel("Password").fill("marketing-demo-2026");
  await page.getByRole("button", { name: "Login" }).click();
  await page.getByText("token issued", { exact: false }).first().waitFor({ timeout: 20_000 });

  await page.getByLabel("Message").fill("Show employee headcount by department");
  await page.getByRole("button", { name: "Send" }).click();
  await waitForAnyText(page, ["DENY_SOURCE_NOT_ALLOWED", "forbidden", "Blocked Calls"]);

  await page.waitForTimeout(1500);
  await page.screenshot({ path: path.join(OUTPUT_DIR, "final-frame.png"), fullPage: true });

  const video = page.video();
  await context.close();
  await browser.close();

  const videoPath = video ? await video.path() : null;
  if (!videoPath) {
    throw new Error("Playwright did not produce a video path.");
  }

  const result = {
    ui_url: BASE_UI_URL,
    video_path: videoPath,
    screenshot_path: path.join(OUTPUT_DIR, "final-frame.png")
  };

  console.log(JSON.stringify(result, null, 2));
}

run().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(error);
  process.exit(1);
});
