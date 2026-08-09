// Phase-2 regression gate: app-vs-golden (SAME renderer), strict diff.
//
// Unlike build-report.mjs (app-vs-mockup, cross-renderer, tolerant triage), this compares a
// fresh capture against an operator-approved golden of the SAME surface, so a strict pixel
// diff is valid: anything over the small regression threshold is a real UI change to review.
//
// Modes:
//   node baseline.mjs update         approve ALL current captures as goldens
//   node baseline.mjs update web     approve only one surface
//   node baseline.mjs                verify current captures against goldens (default)
//
// Verify exits non-zero if any screen regresses (so it can gate a CI step; `.github/workflows/ci.yml`
// runs the react surface on every pull request that can change the admin's appearance).
// Env: REGRESSION_PCT             overrides the threshold for EVERY surface.
//      REGRESSION_PCT_<SURFACE>   overrides one, and beats the line above. e.g. REGRESSION_PCT_REACT=0.1
//      PIXEL_THRESHOLD (default 0.1) = per-pixel color delta tolerance (0..1, lower = stricter).
// Per-surface defaults are in SURFACE_REGRESSION_PCT below, with the measurements behind each.
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync, readdirSync } from "node:fs";
import { dirname, join, basename } from "node:path";
import { fileURLToPath } from "node:url";
// pngjs and pixelmatch are declared in BOTH `web/visual/package.json` and
// `auntieos-admin/package.json`, and the second one is the one that matters.
// This directory has its own package.json and its own lockfile, but it is NOT a
// member of the root workspaces list, so a `npm ci` at the repo root never
// installs it. `npm run visual:react:verify` is an auntieos-admin script, and
// auntieos-admin IS a workspace, so node resolves these from the hoisted root
// `node_modules` instead. Declared only here, the command dies with
// ERR_MODULE_NOT_FOUND on every clean checkout, which is what it did from the
// day the react surface landed until 2026-08-09. If you add a dependency to
// this file, add it to `auntieos-admin/package.json` too.
import { PNG } from "pngjs";
import pixelmatch from "pixelmatch";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const visualDir = join(root, "visual");
const baselineDir = join(visualDir, "baselines");
const reportDir = join(visualDir, "report");
// `react` is the fourth surface: the React admin at auntie.tribetails.com, captured by
// `auntieos-admin/e2e/visual.capture.spec.ts`. The other three all render the superseded
// Compose app. It verifies THROUGH THIS FILE deliberately, so all four share one tolerance
// policy and one report rather than growing a second golden store under Playwright's own
// snapshot directory.
const SURFACES = ["web", "desktop", "android", "react"];

/**
 * The regression threshold, PER SURFACE, because one number was never true of all four.
 *
 * 0.5 was the single shared value and it is kept for the three Compose surfaces. Two of them
 * (desktop, android) render through Skia under a JVM and Robolectric, so a text baseline can
 * legitimately land a pixel differently between runs, and nobody has measured how much slack
 * they actually need. Tightening a surface nobody has measured would turn a gate into noise,
 * so they are left exactly where they were.
 *
 * `react` is 0, and that is a measurement rather than an aspiration:
 *
 *   - The capture pins everything that could drift (reduced motion, a frozen clock, a fixed
 *     timezone and locale, a seed dated against the same instant, every non-loopback request
 *     aborted). Four consecutive runs, one of them under TZ=Asia/Tokyo, produced byte-identical
 *     PNGs for all 19 screens when the surface landed (6bd585c).
 *   - On the 2026-08-09 sweep (#317) thirteen screens changed by the nav rail and by NOTHING
 *     else: zero changed pixels in the content column, not merely few.
 *   - A golden recaptured on another day and another machine came back byte-for-byte identical.
 *
 * So on this surface a nonzero diff is a real change every time, and a percentage band only
 * buys the chance to miss one. It already did: a genuine layout change on `invoice-detail`
 * scored 0.226%, reported `ok`, and sat unnoticed for five days.
 *
 * A surface not named here falls back to 0.5, so adding a fifth surface cannot accidentally
 * inherit react's zero.
 */
const SURFACE_REGRESSION_PCT = { web: 0.5, desktop: 0.5, android: 0.5, react: 0 };
const DEFAULT_REGRESSION_PCT = 0.5;

/**
 * `REGRESSION_PCT_<SURFACE>` beats `REGRESSION_PCT` beats the table above.
 *
 * The shared variable still moves every surface, because that is what it has always done and
 * a caller who sets it means it. Prefer the per-surface one: setting the shared variable to
 * loosen desktop would hand react the same slack, which is the coupling this table exists to
 * remove.
 */
function thresholdFor(surface) {
  const specific = process.env[`REGRESSION_PCT_${surface.toUpperCase()}`];
  if (specific !== undefined && specific !== "") return Number(specific);
  const shared = process.env.REGRESSION_PCT;
  if (shared !== undefined && shared !== "") return Number(shared);
  return SURFACE_REGRESSION_PCT[surface] ?? DEFAULT_REGRESSION_PCT;
}

const PIXEL_THRESHOLD = Number(process.env.PIXEL_THRESHOLD ?? "0.1");

const mode = process.argv[2] === "update" ? "update" : "verify";
const onlySurface = process.argv[3];
const surfaces = onlySurface ? SURFACES.filter((s) => s === onlySurface) : SURFACES;

function pngsIn(dir) {
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".png")) : [];
}

if (mode === "update") {
  let copied = 0;
  for (const surface of surfaces) {
    const src = join(visualDir, surface);
    const dst = join(baselineDir, surface);
    mkdirSync(dst, { recursive: true });
    for (const f of pngsIn(src)) {
      copyFileSync(join(src, f), join(dst, f));
      copied++;
    }
  }
  console.log(`Baselines updated: ${copied} golden(s) across ${surfaces.join(", ")} -> ${baselineDir}`);
  process.exit(0);
}

// verify mode
function compare(curPath, goldPath) {
  const a = PNG.sync.read(readFileSync(curPath));
  const b = PNG.sync.read(readFileSync(goldPath));
  if (a.width !== b.width || a.height !== b.height) {
    return { state: "dim-mismatch", cur: `${a.width}x${a.height}`, gold: `${b.width}x${b.height}` };
  }
  const out = new PNG({ width: a.width, height: a.height });
  const changed = pixelmatch(a.data, b.data, out.data, a.width, a.height, { threshold: PIXEL_THRESHOLD });
  const pct = (changed / (a.width * a.height)) * 100;
  return { state: "diffed", pct, out, changed };
}

const rows = [];
let regressions = 0;
let anyBaseline = false;

for (const surface of surfaces) {
  const limit = thresholdFor(surface);
  const goldDir = join(baselineDir, surface);
  const curDir = join(visualDir, surface);
  const golds = pngsIn(goldDir);
  if (golds.length) anyBaseline = true;
  for (const f of golds) {
    const screen = basename(f, ".png");
    const curPath = join(curDir, f);
    if (!existsSync(curPath)) {
      rows.push({ surface, screen, state: "missing-capture" });
      regressions++;
      continue;
    }
    const r = compare(curPath, join(goldDir, f));
    if (r.state === "dim-mismatch") {
      rows.push({ surface, screen, state: "dim-mismatch", detail: `${r.cur} vs golden ${r.gold}` });
      regressions++;
      continue;
    }
    const pct = Number(r.pct.toFixed(3));
    const regressed = pct > limit;
    if (regressed) {
      mkdirSync(join(reportDir, "regress"), { recursive: true });
      writeFileSync(join(reportDir, "regress", `${surface}-${screen}.png`), PNG.sync.write(r.out));
      regressions++;
    }
    rows.push({ surface, screen, state: regressed ? "REGRESSION" : "ok", pct, limit });
  }
  // current captures with no golden yet (e.g. a brand-new screen)
  for (const f of pngsIn(curDir)) {
    if (!golds.includes(f)) rows.push({ surface, screen: basename(f, ".png"), state: "unbaselined" });
  }
}

if (!anyBaseline) {
  console.error("No baselines found. Run `node baseline.mjs update` first to approve current captures as goldens.");
  process.exit(2);
}

const md = [
  `# Visual regression — app vs golden (same renderer)`,
  ``,
  `A screen regresses when more than its surface's threshold of pixels differ (pixel delta tol ${PIXEL_THRESHOLD}).`,
  `Thresholds this run: ${surfaces.map((s) => `${s} ${thresholdFor(s)}%`).join(", ")}.`,
  ``,
  // The diff image is the point of the report: a percentage says a screen moved, the PNG says
  // where. Relative links, so they resolve inside the uploaded artifact directory as well as
  // on disk.
  `Every REGRESSION row links to its diff PNG: changed pixels are painted, unchanged ones are faded.`,
  ``,
  `| surface | screen | result | % changed | threshold | diff |`,
  `|---|---|---|---|---|---|`,
  ...rows
    .sort((a, b) => (a.surface + a.screen).localeCompare(b.surface + b.screen))
    .map((r) => {
      const diff =
        r.state === "REGRESSION" ? `[${r.surface}-${r.screen}.png](regress/${r.surface}-${r.screen}.png)` : "-";
      return (
        `| ${r.surface} | ${r.screen} | ${r.state}${r.detail ? " (" + r.detail + ")" : ""} ` +
        `| ${r.pct ?? "-"} | ${r.limit ?? "-"} | ${diff} |`
      );
    }),
].join("\n");
mkdirSync(reportDir, { recursive: true });
writeFileSync(join(reportDir, "regression.md"), md + "\n");

const ok = rows.filter((r) => r.state === "ok").length;
const unbaselined = rows.filter((r) => r.state === "unbaselined").length;
console.log(`Regression check: ${ok} ok, ${regressions} regression(s), ${unbaselined} unbaselined.`);
console.log(`Report -> ${join(reportDir, "regression.md")}`);
for (const r of rows.filter((r) => ["REGRESSION", "missing-capture", "dim-mismatch"].includes(r.state))) {
  console.log(
    `  ${r.state}: ${r.surface}/${r.screen}` +
      `${r.pct != null ? ` (${r.pct}% changed, threshold ${r.limit}%)` : ""}` +
      `${r.detail ? ` ${r.detail}` : ""}` +
      `${r.state === "REGRESSION" ? ` -> ${join(reportDir, "regress", `${r.surface}-${r.screen}.png`)}` : ""}`,
  );
}
process.exit(regressions > 0 ? 1 : 0);
