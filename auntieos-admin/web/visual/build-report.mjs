// Pairs each app screenshot against its mockup and emits a browsable contact-sheet report.
// Surfaces: web, desktop, android. Fail loud: a missing app capture is a RED row, never a
// blank pass. Numeric diff only when dimensions match (Skia vs HTML differ by renderer);
// otherwise the side-by-side is the triage artifact and the row is labelled honestly.
import { readFileSync, existsSync, mkdirSync, copyFileSync, writeFileSync } from "node:fs";
import { dirname, resolve, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { PNG } from "pngjs";
import pixelmatch from "pixelmatch";

const here = dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(readFileSync(join(here, "manifest.json"), "utf8"));
const root = resolve(here, "../..");
const visualDir = join(root, "visual");
const reportDir = join(visualDir, "report");
const assetDir = join(reportDir, "assets");
mkdirSync(assetDir, { recursive: true });

const SURFACES = ["web", "desktop", "android"];

function loadPng(p) {
  return PNG.sync.read(readFileSync(p));
}

// Tolerant diff: only meaningful when both images share dimensions.
function diff(appPath, mockPath) {
  const a = loadPng(appPath);
  const m = loadPng(mockPath);
  if (a.width !== m.width || a.height !== m.height) {
    return { status: "dim-mismatch", appDim: `${a.width}x${a.height}`, mockDim: `${m.width}x${m.height}` };
  }
  const out = new PNG({ width: a.width, height: a.height });
  const changed = pixelmatch(a.data, m.data, out.data, a.width, a.height, {
    threshold: 0.25, // tolerant: cross-renderer, flag only large divergences
  });
  const pct = ((changed / (a.width * a.height)) * 100).toFixed(2);
  return { status: "diffed", pct: Number(pct), out };
}

function copyAsset(srcAbs, name) {
  const dest = join(assetDir, name);
  copyFileSync(srcAbs, dest);
  return relative(reportDir, dest);
}

const rows = [];
const gaps = [];
for (const s of manifest.screens) {
  const mockAbs = join(visualDir, "mockups", `${s.screen}.png`);
  const mockOk = existsSync(mockAbs);
  const mockRel = mockOk ? copyAsset(mockAbs, `mock-${s.screen}.png`) : null;
  const cells = {};
  for (const surface of SURFACES) {
    const appAbs = join(visualDir, surface, `${s.screen}.png`);
    if (!existsSync(appAbs)) {
      cells[surface] = { state: "missing" }; // fail loud: red row
      continue;
    }
    const appRel = copyAsset(appAbs, `${surface}-${s.screen}.png`);
    if (!mockOk) {
      cells[surface] = { state: "no-mockup", appRel };
      gaps.push(`${s.screen} (${surface}): app captured but mockup PNG missing`);
      continue;
    }
    let d;
    try {
      d = diff(appAbs, mockAbs);
    } catch (e) {
      cells[surface] = { state: "error", appRel, msg: String(e.message || e) };
      continue;
    }
    if (d.status === "diffed") {
      const diffName = `diff-${surface}-${s.screen}.png`;
      writeFileSync(join(assetDir, diffName), PNG.sync.write(d.out));
      cells[surface] = { state: "diffed", appRel, diffRel: join("assets", diffName), pct: d.pct };
    } else {
      cells[surface] = { state: "dim-mismatch", appRel, appDim: d.appDim, mockDim: d.mockDim };
    }
  }
  rows.push({ screen: s.screen, mockRel, cells });
}

function cellHtml(surface, c, mockRel) {
  if (c.state === "missing")
    return `<td class="missing"><b>${surface}</b><br>app capture MISSING<br><small>fail-loud: run capture-${surface}</small></td>`;
  if (c.state === "error")
    return `<td class="err"><b>${surface}</b><br>ERROR<br><small>${c.msg}</small></td>`;
  const badge =
    c.state === "diffed"
      ? `<span class="${c.pct > 8 ? "bad" : c.pct > 3 ? "warn" : "ok"}">diff ${c.pct}%</span>`
      : c.state === "dim-mismatch"
      ? `<span class="warn">dim ${c.appDim} vs ${c.mockDim} — visual review</span>`
      : `<span class="warn">no mockup</span>`;
  const diffImg = c.diffRel ? `<a href="${c.diffRel}">diff</a>` : "";
  return `<td><b>${surface}</b> ${badge} ${diffImg}<br>
    <div class="pair"><figure><figcaption>app</figcaption><img src="${c.appRel}"></figure>
    ${mockRel ? `<figure><figcaption>mockup</figcaption><img src="${mockRel}"></figure>` : ""}</div></td>`;
}

const html = `<!doctype html><meta charset="utf8"><title>AuntieOS visual report</title>
<style>
 body{font-family:system-ui;margin:24px;background:#11131a;color:#e9e4d8}
 h1{font-weight:600} table{border-collapse:collapse;width:100%}
 td,th{border:1px solid #2a2e3a;padding:10px;vertical-align:top}
 td.missing{background:#3a1414;color:#ffb4b4} td.err{background:#3a2a14;color:#ffd9a0}
 .pair{display:flex;gap:8px} img{max-width:340px;border:1px solid #2a2e3a;border-radius:6px}
 figcaption{font-size:11px;opacity:.6} .ok{color:#8be28b} .warn{color:#e2cf8b} .bad{color:#ff8b8b}
 small{opacity:.6}
</style>
<h1>AuntieOS — UI visual comparison (app ↔ ui-ideas mockups)</h1>
<p>Generated from <code>web/visual/manifest.json</code>. Side-by-side is the triage artifact;
numeric diff shown only when dimensions match (Skia vs HTML differ by renderer).</p>
<table><tr><th>screen</th>${SURFACES.map((s) => `<th>${s}</th>`).join("")}</tr>
${rows
  .map(
    (r) =>
      `<tr><th>${r.screen}${r.mockRel ? "" : '<br><span class="bad">mockup MISSING</span>'}</th>${SURFACES.map(
        (s) => cellHtml(s, r.cells[s], r.mockRel)
      ).join("")}</tr>`
  )
  .join("")}
</table>`;

writeFileSync(join(reportDir, "index.html"), html);
writeFileSync(
  join(visualDir, "report", "mockup-gaps.md"),
  `# Mockup / capture gaps\n\n${gaps.length ? gaps.map((g) => `- ${g}`).join("\n") : "_none_"}\n`
);
const missingCount = rows.reduce(
  (n, r) => n + SURFACES.filter((s) => r.cells[s].state === "missing").length,
  0
);
console.log(`Report -> ${join(reportDir, "index.html")}`);
console.log(`Rows: ${rows.length}  Missing app captures (fail-loud red): ${missingCount}`);
