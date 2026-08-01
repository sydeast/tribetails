// Renders each manifest mockup HTML to a PNG via Playwright (Chromium).
// Single source of mockup truth, reused by web/desktop/android pairing.
// Fail loud: missing manifest, missing mockup file, or render error STOPS with a clear message.
import { chromium } from "@playwright/test";
import { readFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const manifestPath = join(here, "manifest.json");
if (!existsSync(manifestPath)) {
  console.error(`FATAL: manifest not found at ${manifestPath}`);
  process.exit(1);
}
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const { width, height } = manifest.viewport;
const mockupDir = resolve(here, manifest.mockupDir);
const outDir = resolve(here, "../../visual/mockups");
mkdirSync(outDir, { recursive: true });

// Pre-flight: no screen may point at a design the operator rejected. Those live
// under ui-ideas/WrongUIDesigns-UpdateKill/, and rendering one puts a dead design
// back in visual/mockups/ where the next agent reads it as current.
const REJECTED_DIR = "WrongUIDesigns-UpdateKill";
const rejected = manifest.screens.filter((s) => s.mockup.split(/[\\/]/).includes(REJECTED_DIR));
if (rejected.length) {
  console.error(`FATAL: manifest points at rejected designs under ${REJECTED_DIR}/:`);
  for (const s of rejected) console.error(`  - ${s.screen}: ${s.mockup}`);
  console.error("Move the screen to pendingRemock until a replacement mockup arrives.");
  process.exit(1);
}

// Pre-flight: every referenced mockup file must exist (fail loud, no silent skip).
// A screen whose mockup was withdrawn belongs in manifest.pendingRemock, so this
// firing means the manifest and ui-ideas have drifted apart.
const missing = manifest.screens
  .map((s) => ({ s, p: join(mockupDir, s.mockup) }))
  .filter(({ p }) => !existsSync(p));
if (missing.length) {
  console.error("FATAL: mockup HTML files missing:");
  for (const { s, p } of missing) console.error(`  - ${s.screen}: ${p}`);
  console.error("If the design was withdrawn, move the screen to manifest.pendingRemock.");
  process.exit(1);
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 2 });
let ok = 0;
try {
  for (const s of manifest.screens) {
    const url = pathToFileURL(join(mockupDir, s.mockup)).href;
    await page.goto(url, { waitUntil: "networkidle" });
    // Let blob/keyframe animations settle to a stable frame.
    await page.waitForTimeout(600);
    const out = join(outDir, `${s.screen}.png`);
    await page.screenshot({ path: out, fullPage: true });
    console.log(`  captured ${s.screen} -> ${out}`);
    ok++;
  }
} finally {
  await browser.close();
}
console.log(`Mockup capture done: ${ok}/${manifest.screens.length}`);
