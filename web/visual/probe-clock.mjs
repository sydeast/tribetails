// Is the Compose frame clock running? Capture two frames 3s apart and compare.
// The ResolvingSplash spinner animates continuously -> if the clock ticks, the
// two PNGs differ. Byte-identical => frame clock frozen (delay()/animation dead).
// Also dumps the JsException stack via pageerror.
import { chromium } from "@playwright/test";
import { createHash } from "node:crypto";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const URL = process.env.PROBE_URL || "http://localhost:8090/?emulator";
const launchArgs = ["--disable-background-timer-throttling", "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows"];
let browser;
try { browser = await chromium.launch({ channel: "chrome", headless: false, args: launchArgs }); }
catch { browser = await chromium.launch({ headless: false, args: launchArgs }); }
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
const page = await ctx.newPage();
page.on("pageerror", (e) => console.log(`[pageerror] ${e.message}\n  STACK: ${e.stack}`));
const client = await page.context().newCDPSession(page);
const shot = async () => {
  const { data } = await client.send("Page.captureScreenshot", { format: "png", fromSurface: true });
  return createHash("md5").update(Buffer.from(data, "base64")).digest("hex");
};
try {
  await page.bringToFront();
  await page.goto(URL, { waitUntil: "load" });
  await page.waitForTimeout(4000);
  const a = await shot();
  await page.waitForTimeout(3000);
  const b = await shot();
  console.log(`\nframe@4s = ${a}\nframe@7s = ${b}\nclock ${a === b ? "FROZEN (identical frames)" : "RUNNING (frames differ)"}`);
} finally { await browser.close(); }
