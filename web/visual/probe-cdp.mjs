// CDP screenshot probe. Tests whether Page.captureScreenshot{fromSurface:true}
// grabs the Compose/Skia compositor surface that canvas.screenshot() returns blank for.
// Target: prod login screen (full UI painted INSIDE the canvas, no auth needed).
// Captures three ways for comparison: element-screenshot, page.screenshot, raw CDP fromSurface.
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "probe-out");
mkdirSync(outDir, { recursive: true });

const BASE_URL = process.env.PROBE_URL || "https://auntie.tribetails.com";
const launchArgs = [
  "--disable-background-timer-throttling",
  "--disable-renderer-backgrounding",
  "--disable-backgrounding-occluded-windows",
];

let browser;
try {
  browser = await chromium.launch({ channel: "chrome", headless: false, args: launchArgs });
  console.log("launched system Chrome (headful)");
} catch {
  console.warn("system Chrome not found; bundled Chromium");
  browser = await chromium.launch({ headless: false, args: launchArgs });
}
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
const page = await ctx.newPage();
page.on("console", (m) => m.type() === "error" && console.log(`  [page err] ${m.text()}`));

try {
  await page.bringToFront();
  await page.goto(BASE_URL, { waitUntil: "load" });
  await page.waitForFunction(() => window.__fbReady === true, null, { timeout: 60000 }).catch(() => {
    console.warn("  __fbReady not seen in 60s; capturing anyway");
  });
  // Let the canvas paint the login UI.
  await page.waitForTimeout(5000);

  // (1) element screenshot — the method that returns blank dots
  const canvas = page.locator("canvas").first();
  await canvas.waitFor({ state: "visible", timeout: 15000 });
  await canvas.screenshot({ path: join(outDir, "1-element.png") });
  console.log("  wrote 1-element.png (the suspect method)");

  // (2) page.screenshot — Playwright's Page.captureScreenshot, fromSurface default
  await page.screenshot({ path: join(outDir, "2-page.png") });
  console.log("  wrote 2-page.png");

  // (3) raw CDP Page.captureScreenshot {fromSurface:true, captureBeyondViewport:true}
  const client = await page.context().newCDPSession(page);
  const { data } = await client.send("Page.captureScreenshot", {
    format: "png",
    fromSurface: true,
    captureBeyondViewport: true,
  });
  const { writeFileSync } = await import("node:fs");
  writeFileSync(join(outDir, "3-cdp-fromsurface.png"), Buffer.from(data, "base64"));
  console.log("  wrote 3-cdp-fromsurface.png (angle 1 candidate)");
} finally {
  await browser.close();
}
console.log("probe done -> web/visual/probe-out/");
