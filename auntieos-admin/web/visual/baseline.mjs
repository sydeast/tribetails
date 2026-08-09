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
// Verify exits non-zero if any screen regresses (so it can gate a future CI step).
// Env: REGRESSION_PCT (default 0.5) = max % of changed pixels before a screen is a regression.
//      PIXEL_THRESHOLD (default 0.1) = per-pixel color delta tolerance (0..1, lower = stricter).
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

const REGRESSION_PCT = Number(process.env.REGRESSION_PCT ?? "0.5");
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
    const regressed = pct > REGRESSION_PCT;
    if (regressed) {
      mkdirSync(join(reportDir, "regress"), { recursive: true });
      writeFileSync(join(reportDir, "regress", `${surface}-${screen}.png`), PNG.sync.write(r.out));
      regressions++;
    }
    rows.push({ surface, screen, state: regressed ? "REGRESSION" : "ok", pct });
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
  `Threshold: a screen regresses if > ${REGRESSION_PCT}% of pixels differ (pixel delta tol ${PIXEL_THRESHOLD}).`,
  ``,
  `| surface | screen | result | % changed |`,
  `|---|---|---|---|`,
  ...rows
    .sort((a, b) => (a.surface + a.screen).localeCompare(b.surface + b.screen))
    .map((r) => `| ${r.surface} | ${r.screen} | ${r.state}${r.detail ? " (" + r.detail + ")" : ""} | ${r.pct ?? "-"} |`),
].join("\n");
mkdirSync(reportDir, { recursive: true });
writeFileSync(join(reportDir, "regression.md"), md + "\n");

const ok = rows.filter((r) => r.state === "ok").length;
const unbaselined = rows.filter((r) => r.state === "unbaselined").length;
console.log(`Regression check: ${ok} ok, ${regressions} regression(s), ${unbaselined} unbaselined.`);
console.log(`Report -> ${join(reportDir, "regression.md")}`);
for (const r of rows.filter((r) => ["REGRESSION", "missing-capture", "dim-mismatch"].includes(r.state))) {
  console.log(`  ${r.state}: ${r.surface}/${r.screen}${r.pct != null ? ` (${r.pct}%)` : ""}${r.detail ? ` ${r.detail}` : ""}`);
}
process.exit(regressions > 0 ? 1 : 0);
