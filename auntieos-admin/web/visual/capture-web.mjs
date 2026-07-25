// Captures the running AuntieOS WEB app (Compose Wasm / Skia canvas) per manifest screen.
// The login form is rendered INSIDE the canvas (no DOM inputs), so we authenticate
// programmatically through the app's own bridge: window.__fb.signIn(email, password, cb).
// One browser context for the whole run keeps the Firebase session alive across screens.
//
// Fail loud (project policy):
//   - VISUAL_ADMIN_EMAIL / VISUAL_ADMIN_PASSWORD unset  -> hard STOP, no fabricated creds.
//   - sign-in fails or user is not admin                -> hard STOP.
//   - a screen never reaches __fbReady / never renders   -> that screen errors loud (non-zero exit).
//   - invoice-detail demo id unresolved                  -> that screen errors loud.
import { chromium } from "@playwright/test";
import { readFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

// Minimal .env loader (no dep): KEY=VALUE lines.
const envPath = join(here, ".env");
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

const EMAIL = process.env.VISUAL_ADMIN_EMAIL;
const PASSWORD = process.env.VISUAL_ADMIN_PASSWORD;
// THE DEFAULT IS THE WASM SITE, NOT auntie.tribetails.com, and the change is a fix.
// Since 2026-07-20 auntie.tribetails.com serves the REACT admin, which has no
// `window.__fb` bridge and no Skia canvas, so this script aimed at it waits the
// full 60 seconds for a bridge that will never appear and then fails every
// screen. Per web/firebase.json the wasm build deploys to the `auntieos-admin`
// site, which is what this now names. Override with VISUAL_BASE_URL to capture a
// local `npm run serve-dist`.
const BASE_URL = process.env.VISUAL_BASE_URL || "https://auntieos-admin.web.app";

if (!EMAIL || !PASSWORD) {
  console.error(
    "FATAL: web capture needs a test-admin credential.\n" +
      "  Set VISUAL_ADMIN_EMAIL and VISUAL_ADMIN_PASSWORD in web/visual/.env (gitignored)\n" +
      "  or as env vars. No fabricated credentials (project fail-loud policy)."
  );
  process.exit(2);
}

const manifest = JSON.parse(readFileSync(join(here, "manifest.json"), "utf8"));
const { width, height } = manifest.viewport;
const outDir = resolve(here, "../../visual/web");
mkdirSync(outDir, { recursive: true });

// Compose Wasm renders via Skiko, which needs WebGL. Headless Chromium disables GPU/WebGL
// by default (canvas stays on the loading dot), so force software WebGL via SwiftShader.
// Compose Wasm renders via Skiko, which needs real WebGL. Playwright's bundled Chromium
// leaves the canvas on the loading dot even headful, so prefer the system Chrome channel
// (real GPU/WebGL stack) headful. Falls back to bundled Chromium if Chrome is absent.
// Compose Wasm drives paint via requestAnimationFrame, which Chromium throttles in
// unfocused/backgrounded windows -> the app paints once (loading dot) then stalls. Disable
// that throttling and keep the page foregrounded. Prefer system Chrome (real WebGL).
const launchArgs = [
  "--disable-background-timer-throttling",
  "--disable-renderer-backgrounding",
  "--disable-backgrounding-occluded-windows",
];
let browser;
try {
  browser = await chromium.launch({ channel: "chrome", headless: false, args: launchArgs });
} catch {
  console.warn("system Chrome not found; falling back to bundled Chromium (canvas may not paint)");
  browser = await chromium.launch({ headless: false, args: launchArgs });
}
const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 2 });
const page = await ctx.newPage();
page.on("console", (m) => {
  if (m.type() === "error") console.log(`  [page error] ${m.text()}`);
});

let failures = 0;
try {
  await page.bringToFront();
  await page.goto(BASE_URL, { waitUntil: "load" });
  // Wait for the Firebase bridge + Wasm to be ready, then let the canvas settle so the
  // sign-in evaluate doesn't race a recomposition that destroys the execution context.
  try {
    await page.waitForFunction(() => window.__fbReady === true && typeof window.__fb === "object", null, {
      timeout: 60000,
    });
  } catch {
    // NAME THE LIKELY CAUSE. The bare Playwright timeout says only that a
    // predicate never became true, and the overwhelmingly common reason is that
    // BASE_URL is serving the React admin rather than the wasm build. A minute
    // of waiting followed by a generic message is how somebody concludes the
    // harness is broken when the URL is simply wrong.
    const isReact = await page
      .evaluate(() => document.querySelector("#root") !== null && document.querySelector("canvas") === null)
      .catch(() => false);
    console.error(
      `FATAL: no Compose wasm bridge at ${BASE_URL} after 60s.\n` +
        (isReact
          ? "  That URL is serving the REACT admin (#root, no canvas). This script drives the\n" +
            "  Compose wasm build, which deploys to the `auntieos-admin` site. Point\n" +
            "  VISUAL_BASE_URL at that host or at a local `npm run serve-dist`.\n" +
            "  The React admin has its OWN browser coverage: see auntieos-admin/e2e/."
          : "  The page loaded but never set window.__fbReady. Check the build actually\n" +
            "  deployed, and that the canvas is painting (see the WebGL notes above).")
    );
    process.exit(2);
  }
  await page.waitForTimeout(3000);

  // Programmatic sign-in via the app's own bridge (retry once if a recomposition
  // tears down the context mid-call).
  async function doSignIn() {
    // Bridge signIn callback receives a JSON string: {ok:true,uid,email} or {ok:false,error}.
    return page.evaluate(
      ([email, password]) =>
        new Promise((res) => {
          window.__fb.signIn(email, password, (resStr) => {
            try {
              const r = JSON.parse(resStr);
              res({ ok: r.ok === true, err: r.error || null });
            } catch {
              res({ ok: false, err: "unparseable signIn result: " + String(resStr) });
            }
          });
        }),
      [EMAIL, PASSWORD]
    );
  }
  let auth;
  try {
    auth = await doSignIn();
  } catch (e) {
    await page.waitForTimeout(2000);
    auth = await doSignIn();
  }
  if (!auth.ok) {
    console.error(`FATAL: sign-in failed: ${auth.err}`);
    process.exit(3);
  }
  const isAdmin = await page.evaluate(
    () =>
      new Promise((res) => {
        if (!window.__fb.isCurrentUserAdmin) return res(true); // older bridge: skip gate
        // Bridge signature is (forceRefresh, cb); force a refresh so the just-set claim loads.
        window.__fb.isCurrentUserAdmin(true, (ok) => res(!!ok));
      })
  );
  if (!isAdmin) {
    console.error("FATAL: signed-in user is not an admin; cannot capture admin screens.");
    process.exit(3);
  }
  console.log(`Signed in as ${EMAIL} (admin) on ${BASE_URL}`);

  // After sign-in the app performs its own post-login redirect to the default
  // (home) route asynchronously. Let that settle before we start driving the
  // hash router, otherwise the FIRST screen's navigation races the redirect and
  // gets overwritten back to home.
  await page.waitForTimeout(3000);

  // Param routes carry a __DEMO_<X>_ID__ placeholder resolved from env var
  // VISUAL_DEMO_<X>_ID (e.g. __DEMO_INVOICE_ID__ <- VISUAL_DEMO_INVOICE_ID).
  // Fail loud + skip a screen whose id is unset (no fabricated ids).
  const resolvePlaceholders = (route) => {
    const tokens = route.match(/__DEMO_[A-Z]+_ID__/g) || [];
    for (const tok of tokens) {
      const envKey = "VISUAL" + tok.replace(/__/g, "_").replace(/_$/, ""); // __DEMO_INVOICE_ID__ -> VISUAL_DEMO_INVOICE_ID
      const val = process.env[envKey];
      if (!val) return { route: null, missing: envKey };
      route = route.replace(tok, val);
    }
    return { route, missing: null };
  };

  for (const s of manifest.screens) {
    const resolved = resolvePlaceholders(s.webRoute);
    if (resolved.route === null) {
      console.error(`  ERROR ${s.screen}: ${resolved.missing} unset; cannot resolve ${s.webRoute}. Skipping (fail-loud).`);
      failures++;
      continue;
    }
    let route = resolved.route;
    try {
      // Navigate, settle, then re-assert: a stray post-redirect or in-app nav can
      // bounce the hash back, so set it twice with a gap and verify it stuck.
      const go = (r) =>
        page.evaluate((rr) => {
          if (window.location.hash !== rr) window.location.hash = rr;
          window.dispatchEvent(new HashChangeEvent("hashchange"));
        }, route);
      await go(route);
      await page.waitForTimeout(800);
      await go(route);
      const landed = await page.evaluate(() => window.location.hash);
      if (!landed.includes(route.replace(/^#/, ""))) {
        console.warn(`  WARN ${s.screen}: hash is "${landed}", expected "${route}"`);
      }
      // Let Compose recompose + Skia paint settle.
      await page.waitForTimeout(1500);
      const canvas = page.locator("canvas").first();
      await canvas.waitFor({ state: "visible", timeout: 15000 });
      const out = join(outDir, `${s.screen}.png`);
      await canvas.screenshot({ path: out });
      console.log(`  captured ${s.screen} (${route}) -> ${out}`);
    } catch (e) {
      console.error(`  ERROR ${s.screen}: ${e.message || e}`);
      failures++;
    }
  }
} finally {
  await browser.close();
}
console.log(`Web capture done. Failures: ${failures}`);
process.exit(failures ? 1 : 0);
