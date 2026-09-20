// Memory-safe grove visual check — browser always closes in finally.
// HEMLOCK_PLAYWRIGHT=/tmp/hemlock-gui-qa/node_modules/playwright/index.mjs node scripts/grove-visual-check.mjs
import { pathToFileURL } from "node:url";

const { chromium } = await import(process.env.HEMLOCK_PLAYWRIGHT ? pathToFileURL(process.env.HEMLOCK_PLAYWRIGHT).href : "playwright");

let browser;
try {
  browser = await chromium.launch({ headless: true, executablePath: process.env.HEMLOCK_CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  await page.goto(process.env.HEMLOCK_GUI_URL || "http://localhost:5173/", { waitUntil: "networkidle" });
  await page.locator(".system-bar").waitFor();
  const dockItem = page.locator('.understory-dock .dock-item[aria-label^="Understory Grove,"]');
  if (await dockItem.count()) {
    await dockItem.click();
  } else {
    await page.getByRole("button", { name: "Open all apps", exact: true }).click();
    await page.getByRole("textbox", { name: "Find an app or window", exact: true }).fill("Grove");
    await page.locator(".overview-app").first().click();
  }
  await page.waitForSelector(".grove-canvas", { timeout: 15000 });
  await page.waitForTimeout(4000); // lazy three chunk + first frames
  await page.screenshot({ path: "/tmp/grove-humanoid.png" });
  console.log("screenshot: /tmp/grove-humanoid.png");
} finally {
  await browser?.close();
}
