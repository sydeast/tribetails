// Diagnose the local-emulator loading-dot stall. Renders localhost:8088/?emulator
// with system Chrome headful (the config proven against prod), dumps ALL console
// output, reports whether the #loading skeleton is still present (= Compose never
// mounted) vs replaced by the Skia canvas, then CDP-screenshots.
import { chromium } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "probe-out");
mkdirSync(outDir, { recursive: true });
const URL = process.env.PROBE_URL || "http://localhost:8088/?emulator";
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
  browser = await chromium.launch({ headless: false, args: launchArgs });
  console.log("launched bundled Chromium");
}
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
const page = await ctx.newPage();
page.on("console", (m) => console.log(`  [console.${m.type()}] ${m.text()}`));
page.on("pageerror", (e) => console.log(`  [PAGEERROR] ${e.message}`));
page.on("requestfailed", (r) => console.log(`  [REQFAIL] ${r.url()} :: ${r.failure()?.errorText}`));

try {
  await page.bringToFront();
  await page.goto(URL, { waitUntil: "load" });
  await page.waitForFunction(() => window.__fbReady === true, null, { timeout: 30000 }).then(
    () => console.log("  __fbReady = true"),
    () => console.log("  __fbReady NOT seen in 30s")
  );
  // Give Compose time to instantiate the wasm + mount the canvas.
  await page.waitForTimeout(8000);

  const diag = await page.evaluate(() => {
    const loading = document.getElementById("loading");
    const canvas = document.querySelector("canvas");
    return {
      fbReady: window.__fbReady === true,
      loadingPresent: !!loading,
      loadingDisplay: loading ? getComputedStyle(loading).display : "(gone)",
      loadingText: loading ? loading.textContent : null,
      canvasPresent: !!canvas,
      canvasSize: canvas ? `${canvas.width}x${canvas.height}` : "(none)",
      bodyChildren: Array.from(document.body.children).map((c) => c.tagName + (c.id ? "#" + c.id : "")),
    };
  });
  console.log("  DIAG:", JSON.stringify(diag, null, 2));

  const client = await page.context().newCDPSession(page);
  const { data } = await client.send("Page.captureScreenshot", { format: "png", fromSurface: true, captureBeyondViewport: true });
  writeFileSync(join(outDir, "local-render.png"), Buffer.from(data, "base64"));
  console.log("  wrote local-render.png");
} finally {
  await browser.close();
}
