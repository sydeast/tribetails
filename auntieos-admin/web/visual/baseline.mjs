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
//      VISUAL_BASELINE_DIR        directory holding one subdirectory of goldens per surface.
//                                 Defaults to `visual/baselines`. See the block above `baselineDir`.
//      VISUAL_APPROVAL_SCOPE      the branch whose entries in `approvals.json` are live this run.
//                                 Defaults to the checkout's current branch. See `loadApprovals`.
// Per-surface defaults are in SURFACE_REGRESSION_PCT below, with the measurements behind each.
//
// Verify exit codes: 0 clean, 1 at least one UNDECLARED regression, 2 no goldens exist at all,
// 3 `approvals.json` is malformed: a declaration nobody can parse approves nothing, so it stops
// the run rather than silently approving none of what it names.
import { execFileSync } from "node:child_process";
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
/**
 * The golden ROOT: a directory holding one subdirectory of PNGs per surface.
 *
 * `visual/baselines` on every local run, which is what it has always been. CI overrides it
 * because the goldens committed here were recorded on macOS and the runner is Linux, so the
 * react gate photographs the BASE BRANCH on the runner and uses that as the golden instead
 * (`.github/workflows/ci.yml`, job `admin-visual`). Before this variable existed, the job got
 * there by `rm -rf`-ing `visual/baselines/react` inside its own checkout, which meant a branch
 * could not commit a golden the job would ever look at, and left the runner's tree dirty for
 * every step after it. Pointing the reader somewhere else destroys nothing.
 */
const baselineDir = process.env.VISUAL_BASELINE_DIR || join(visualDir, "baselines");
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

/**
 * APPROVING AN INTENDED CHANGE.
 *
 * A gate that cannot be satisfied is not a gate. Until #405 a deliberate UI change was
 * permanently red. The react threshold is 0%, CI compared the pull request against its base,
 * and there was no label, flag or file that said "this diff is the point of the pull request".
 * The only way to ship one was to merge past a failing check, which teaches everyone to ignore
 * red, which is how a real regression gets through.
 *
 * `web/visual/approvals.json` is that declaration. It names the SCREEN, the BRANCH the approval
 * belongs to, WHO approved it, WHEN, and WHY, in the same committed-JSON-with-prose idiom as
 * `manifest.json`. Being a committed file rather than a label, it arrives in the diff a reviewer
 * is already reading, it survives in `git blame`, and it says which screens moved rather than
 * only that somebody clicked something.
 *
 * ONLY THE ENTRIES FOR THE CURRENT BRANCH ARE LIVE, and that is the whole reason `branch` is a
 * required field. An approval merged to main would otherwise sit there forever, silently
 * blessing that screen on every later pull request, exactly the undeclared change this gate
 * exists to catch. Scoped to a branch, a merged entry is inert: it is history, readable by the
 * next person who wonders why that screen moved, and it approves nothing.
 *
 * The scope is `VISUAL_APPROVAL_SCOPE` if set (CI sets it to the pull request's head ref,
 * because a PR checkout is detached and has no branch name), otherwise the checkout's current
 * branch, so a local `npm run visual:react:verify` on the branch that wrote the entry honours
 * it with no ceremony and reproduces exactly what CI does.
 */
const APPROVALS_FILE = join(here, "approvals.json");
const APPROVAL_REQUIRED = ["screen", "branch", "reason", "approvedBy", "date"];
const APPROVAL_OPTIONAL = ["notes"];
// A reason short enough to be meaningless is not a reason. "wip", "yes" and "ok" are the three
// this has to refuse; ten characters refuses them without turning into a writing course.
const APPROVAL_MIN_REASON = 10;

function currentBranch() {
  try {
    const branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: here,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    // A detached HEAD (every CI pull-request checkout) reports the literal string "HEAD".
    return branch && branch !== "HEAD" ? branch : "";
  } catch {
    return "";
  }
}

function invalidApprovals(message) {
  console.error(`approvals.json is invalid: ${message}`);
  console.error(`  file: ${APPROVALS_FILE}`);
  console.error(`  Every entry needs ${APPROVAL_REQUIRED.join(", ")}. Nothing was approved.`);
  process.exit(3);
}

/**
 * Parses and validates the declaration, and returns the entries live for `scope`.
 *
 * Every shape problem is fatal rather than ignored, because the failure mode of a tolerant
 * reader here is the worst one available: an entry with `aprovedBy` or a misspelt screen name
 * is silently inert, the run stays red, and the author is looking at an approval they believe
 * they already wrote. Loud beats subtle. A MISSING file is not an error: it means no branch
 * has ever declared a change, which is the normal state.
 */
function loadApprovals(surfacesInPlay, scope) {
  if (!existsSync(APPROVALS_FILE)) return { live: new Map(), declared: 0 };
  let doc;
  try {
    doc = JSON.parse(readFileSync(APPROVALS_FILE, "utf8"));
  } catch (err) {
    invalidApprovals(`not valid JSON (${err.message})`);
  }
  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) {
    invalidApprovals("the top level must be an object keyed by surface");
  }
  const live = new Map();
  let declared = 0;
  for (const [key, entries] of Object.entries(doc)) {
    if (key.startsWith("_")) continue; // `_note` and friends, the manifest's own convention
    if (!SURFACES.includes(key)) {
      invalidApprovals(`"${key}" is not a surface (expected one of ${SURFACES.join(", ")})`);
    }
    if (!Array.isArray(entries)) invalidApprovals(`"${key}" must be an array of approvals`);
    const seen = new Set();
    for (const entry of entries) {
      declared++;
      const where = `${key} entry ${declared}`;
      if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
        invalidApprovals(`${where} is not an object`);
      }
      for (const field of APPROVAL_REQUIRED) {
        const value = entry[field];
        if (typeof value !== "string" || value.trim() === "") {
          invalidApprovals(`${where} is missing a non-empty "${field}"`);
        }
      }
      for (const field of Object.keys(entry)) {
        if (!APPROVAL_REQUIRED.includes(field) && !APPROVAL_OPTIONAL.includes(field)) {
          invalidApprovals(`${where} has an unknown field "${field}"`);
        }
      }
      // No wildcards and no paths: an approval names ONE screen. "approve everything" is the
      // request this file exists to refuse, and a glob is how it would arrive.
      if (!/^[a-z0-9][a-z0-9-]*$/.test(entry.screen)) {
        invalidApprovals(`${where} names "${entry.screen}", which is not a single screen name`);
      }
      if (entry.reason.trim().length < APPROVAL_MIN_REASON) {
        invalidApprovals(`${where} needs a reason of at least ${APPROVAL_MIN_REASON} characters`);
      }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(entry.date)) {
        invalidApprovals(`${where} has date "${entry.date}", expected YYYY-MM-DD`);
      }
      const dedupe = `${entry.screen}@${entry.branch}`;
      if (seen.has(dedupe)) {
        invalidApprovals(`${key} approves "${entry.screen}" twice on branch "${entry.branch}"`);
      }
      seen.add(dedupe);
      if (scope && entry.branch === scope && surfacesInPlay.includes(key)) {
        live.set(`${key}/${entry.screen}`, entry);
      }
    }
  }
  return { live, declared };
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

const scopeEnv = process.env.VISUAL_APPROVAL_SCOPE;
const approvalScope = scopeEnv !== undefined ? scopeEnv.trim() : currentBranch();
const { live: approvals, declared: approvalsDeclared } = loadApprovals(surfaces, approvalScope);
// Said before the verdict, not after it, so a log read top to bottom answers "was anything
// allowed to move, and who allowed it" before it shows what moved.
console.log(
  `Approval scope: ${approvalScope || "(none, so every difference must be clean)"}` +
    `, ${approvals.size} live of ${approvalsDeclared} declared in ${APPROVALS_FILE}`,
);
for (const [key, entry] of approvals) {
  console.log(`  declared intended: ${key} by ${entry.approvedBy} on ${entry.date}: ${entry.reason}`);
}

// A live approval for a screen that has neither a golden nor a capture is almost always a typo
// in the screen name, and a typo here is the one failure that looks like success from the
// author's chair: the entry is in the diff, the run is still red, and nothing explains why.
{
  const known = new Set();
  for (const surface of surfaces) {
    for (const f of pngsIn(join(baselineDir, surface))) known.add(`${surface}/${basename(f, ".png")}`);
    for (const f of pngsIn(join(visualDir, surface))) known.add(`${surface}/${basename(f, ".png")}`);
  }
  for (const key of approvals.keys()) {
    if (!known.has(key)) invalidApprovals(`"${key}" names a screen with no golden and no capture`);
  }
}

const rows = [];
let regressions = 0;
let anyBaseline = false;
const approvalsUsed = new Set();

for (const surface of surfaces) {
  const limit = thresholdFor(surface);
  const goldDir = join(baselineDir, surface);
  const curDir = join(visualDir, surface);
  const golds = pngsIn(goldDir);
  if (golds.length) anyBaseline = true;
  for (const f of golds) {
    const screen = basename(f, ".png");
    const curPath = join(curDir, f);
    const approval = approvals.get(`${surface}/${screen}`);
    if (!existsSync(curPath)) {
      // Deleting a screen should have to be said out loud. An approval IS saying it out loud,
      // so the same declaration that covers a moved screen covers a removed one.
      if (approval) {
        rows.push({ surface, screen, state: "approved", detail: "screen removed", approval });
        approvalsUsed.add(`${surface}/${screen}`);
      } else {
        rows.push({ surface, screen, state: "missing-capture" });
        regressions++;
      }
      continue;
    }
    const r = compare(curPath, join(goldDir, f));
    if (r.state === "dim-mismatch") {
      const detail = `${r.cur} vs golden ${r.gold}`;
      if (approval) {
        rows.push({ surface, screen, state: "approved", detail, approval });
        approvalsUsed.add(`${surface}/${screen}`);
      } else {
        rows.push({ surface, screen, state: "dim-mismatch", detail });
        regressions++;
      }
      continue;
    }
    const pct = Number(r.pct.toFixed(3));
    const over = pct > limit;
    if (over) {
      // The overlay is written for an APPROVED change too. A reviewer approves a picture, not a
      // percentage, so the picture has to survive into the uploaded artifact either way.
      mkdirSync(join(reportDir, "regress"), { recursive: true });
      writeFileSync(join(reportDir, "regress", `${surface}-${screen}.png`), PNG.sync.write(r.out));
      if (approval) approvalsUsed.add(`${surface}/${screen}`);
      else regressions++;
    }
    const state = over ? (approval ? "approved" : "REGRESSION") : "ok";
    rows.push({ surface, screen, state, pct, limit, approval: over ? approval : undefined });
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

const approvedRows = rows.filter((r) => r.state === "approved");
// An entry that matched no moved screen. Not fatal: the commonest cause is an author who
// declared the change before capturing and then found the screen did not move after all, and
// failing THAT would punish caution. It is reported so the entry can be dropped rather than
// left to look like it is doing something.
const staleApprovals = [...approvals.entries()].filter(([key]) => !approvalsUsed.has(key));

const md = [
  `# Visual regression — app vs golden (same renderer)`,
  ``,
  `A screen regresses when more than its surface's threshold of pixels differ (pixel delta tol ${PIXEL_THRESHOLD}).`,
  `Thresholds this run: ${surfaces.map((s) => `${s} ${thresholdFor(s)}%`).join(", ")}.`,
  ``,
  // The diff image is the point of the report: a percentage says a screen moved, the PNG says
  // where. Relative links, so they resolve inside the uploaded artifact directory as well as
  // on disk. Approved rows link to theirs too: an approval a reviewer cannot see the picture of
  // is a rubber stamp.
  `Every REGRESSION and every approved row links to its diff PNG: changed pixels are painted, unchanged ones are faded.`,
  ``,
  `| surface | screen | result | % changed | threshold | diff |`,
  `|---|---|---|---|---|---|`,
  ...rows
    .sort((a, b) => (a.surface + a.screen).localeCompare(b.surface + b.screen))
    .map((r) => {
      const hasDiff = r.state === "REGRESSION" || (r.state === "approved" && r.pct != null);
      const diff = hasDiff ? `[${r.surface}-${r.screen}.png](regress/${r.surface}-${r.screen}.png)` : "-";
      return (
        `| ${r.surface} | ${r.screen} | ${r.state}${r.detail ? " (" + r.detail + ")" : ""} ` +
        `| ${r.pct ?? "-"} | ${r.limit ?? "-"} | ${diff} |`
      );
    }),
  ``,
  `## Declared intended changes`,
  ``,
  `Approval scope: \`${approvalScope || "(none)"}\`. Only \`web/visual/approvals.json\` entries whose`,
  `\`branch\` matches that scope are live, so an entry merged to main approves nothing later.`,
  ``,
  ...(approvedRows.length
    ? [
        `| surface | screen | % changed | approved by | date | reason |`,
        `|---|---|---|---|---|---|`,
        ...approvedRows.map(
          (r) =>
            `| ${r.surface} | ${r.screen} | ${r.pct ?? r.detail ?? "-"} ` +
            `| ${r.approval.approvedBy} | ${r.approval.date} | ${r.approval.reason} |`,
        ),
      ]
    : [`No visual change was declared intended on this scope.`]),
  ...(staleApprovals.length
    ? [
        ``,
        `Stale approvals (live for this scope, but the screen did not move, so drop them):`,
        ``,
        ...staleApprovals.map(([key, entry]) => `- \`${key}\`, ${entry.approvedBy}, ${entry.date}`),
      ]
    : []),
].join("\n");
mkdirSync(reportDir, { recursive: true });
writeFileSync(join(reportDir, "regression.md"), md + "\n");

const ok = rows.filter((r) => r.state === "ok").length;
const unbaselined = rows.filter((r) => r.state === "unbaselined").length;
console.log(
  `Regression check: ${ok} ok, ${regressions} regression(s), ` +
    `${approvedRows.length} approved, ${unbaselined} unbaselined.`,
);
console.log(`Report -> ${join(reportDir, "regression.md")}`);
for (const r of rows.filter((r) => ["REGRESSION", "missing-capture", "dim-mismatch"].includes(r.state))) {
  console.log(
    `  ${r.state}: ${r.surface}/${r.screen}` +
      `${r.pct != null ? ` (${r.pct}% changed, threshold ${r.limit}%)` : ""}` +
      `${r.detail ? ` ${r.detail}` : ""}` +
      `${r.state === "REGRESSION" ? ` -> ${join(reportDir, "regress", `${r.surface}-${r.screen}.png`)}` : ""}`,
  );
}
for (const r of approvedRows) {
  console.log(
    `  APPROVED: ${r.surface}/${r.screen}` +
      `${r.pct != null ? ` (${r.pct}% changed, threshold ${r.limit}%)` : ""}` +
      `${r.detail ? ` ${r.detail}` : ""}` +
      ` by ${r.approval.approvedBy} on ${r.approval.date}: ${r.approval.reason}`,
  );
}
for (const [key, entry] of staleApprovals) {
  console.log(`  STALE APPROVAL: ${key} did not move, so drop the entry (${entry.approvedBy}, ${entry.date}).`);
}
process.exit(regressions > 0 ? 1 : 0);
