// Extract the REAL startup error behind Kotlin's generic "JsException". Installs
// window.onerror + unhandledrejection capture BEFORE any app script runs, then
// dumps full messages + stacks. Also logs every failed network request.
import { chromium } from "@playwright/test";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const URL = process.env.PROBE_URL || "http://localhost:8088/?emulator";
const launchArgs = [
  "--disable-background-timer-throttling",
  "--disable-renderer-backgrounding",
  "--disable-backgrounding-occluded-windows",
];

let browser;
try {
  browser = await chromium.launch({ channel: "chrome", headless: false, args: launchArgs });
} catch {
  browser = await chromium.launch({ headless: false, args: launchArgs });
}
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
// Capture errors verbatim before app scripts run.
await ctx.addInitScript(() => {
  window.__errs = [];
  window.addEventListener("error", (e) => {
    window.__errs.push({ kind: "error", message: e.message, stack: e.error && e.error.stack, src: e.filename + ":" + e.lineno });
  });
  window.addEventListener("unhandledrejection", (e) => {
    const r = e.reason;
    window.__errs.push({ kind: "unhandledrejection", message: String(r && (r.message || r)), stack: r && r.stack });
  });
});
const page = await ctx.newPage();
page.on("pageerror", (e) => console.log(`[pageerror] ${e.message}\n  stack: ${e.stack}`));
page.on("requestfailed", (r) => console.log(`[REQFAIL] ${r.url()} :: ${r.failure()?.errorText}`));
page.on("response", (r) => { if (r.status() >= 400) console.log(`[HTTP ${r.status()}] ${r.url()}`); });

try {
  await page.goto(URL, { waitUntil: "load" });
  await page.waitForTimeout(8000);
  const errs = await page.evaluate(() => window.__errs || []);
  console.log("\n=== captured window errors ===");
  console.log(JSON.stringify(errs, null, 2));
} finally {
  await browser.close();
}
