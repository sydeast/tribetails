# Visual harness coverage — Stage 2 + follow-ups

Updated 2026-06-01.

## Result (60 / 60 cells = 20 screens x 3 surfaces) — COMPLETE

- Desktop: **20 / 20** captured.
- Android: **20 / 20** captured.
- Web: **20 / 20** captured.
- No remaining gaps. `formschema-editor` WEB closed 2026-06-01 (Option C full-local, below).

## Closed this round (were red, now captured)

- `template-bank` + `template-assignment` DESKTOP: un-blocked via a `JvmFirestoreFixtures.callableResponses: Map<String,String>` seam. The JVM `platformInvokeCallable` actual now returns `WriteResult.Ok(callableResponses[name])` when a fixture is present (empty map = prior Err behavior, no prod impact). The desktop tests set the raw `listTemplates` / `listTemplateBindings` JSON envelopes the `TemplateService` decoders expect. Verified real renders (template-assignment shows Active 2 / Paused 1 + 3 decoded bindings).

## formschema-editor (WEB) — CLOSED 2026-06-01 (Option C, full-local)

Chose Option C (real functions-emulator wire), executed full-local. All callable-backed web
screens now run against the local functions emulator with seeded data — the harness is fully
prod-independent (hermetic). Decision + full write-up: `docs/2026-06-01-formschema-editor-web-decision.md`.

What it took (all DEV/harness + test-fixture; NO prod/wasm-source-behavior change, NO deploy):
1. `firebase-bridge.js`: `connectFunctionsEmulator(functions,'localhost',5001)` inside the existing
   `?emulator` block (prod path untouched). The bridge is a verbatim-copied wasm resource, so the
   dist copy was patched directly — no wasm recompile, and the other 16 screens stay byte-stable.
2. `web/firebase.dev.json`: functions emulator on 5001 + `:5001` in the dev CSP connect-src.
3. `web/visual/functions-emu/` (NEW shim source): re-exports ONLY the 4 read-only callables
   (`getFormSchema`/`listFormSchemas`/`listTemplates`/`listTemplateBindings`) from MyTribe's
   compiled `lib`. Loading MyTribe's full index would also register its firestore triggers /
   pubsub crons, which fire on seed writes to overlapping collections (`invoices`/`notifications`)
   and break determinism — the shim avoids that. Verified: exactly 4 functions load, zero triggers.
4. `web/visual/seed-emulator.mjs`: +5 emailTemplates, +5 notificationTemplateBindings, +5
   formSchemas (mockup-aligned). `VISUAL_DEMO_SCHEMA_ID=tribeProfile` in `.env`/`.env.example`.

Why the 3 previously-green callable screens were re-baselined: bridge line 39 routes ALL callables,
so wiring the emulator moved `template-bank`/`template-assignment`/`formschema-list` off prod data
onto seeded data. A visual-regression gate must not depend on live prod data (false regressions when
prod moves; that is a smoke/e2e concern). Pre-approval `baseline.mjs verify web` = 16 ok / 3 regression
/ 1 unbaselined — exactly the 4 callable screens, proving zero collateral effect on the other 16.

NOT done (by design): a separate smoke/e2e check for the real prod-callable wire-contract.

## Phase 2 — regression baselines (shipped 2026-06-01)

- `visual/baselines/<surface>/` holds 60 operator-approved goldens (web 20, desktop 20,
  android 20), seeded from the current verified captures.
- `web/visual/baseline.mjs`: `update` (re-approve goldens) and verify (default) modes. Verify
  runs a STRICT same-renderer pixelmatch (pixel tol 0.1) and flags any screen whose changed
  pixels exceed `REGRESSION_PCT` (default 0.5%); writes `visual/report/regression.md` and exits
  non-zero on any regression (so it can gate later).
- Proven deterministic: re-recording desktop directory/inbox/settings diffed at 0.000% vs
  golden; on the 2026-06-01 web functions-emulator change, the 16 non-callable web screens
  diffed clean (16 ok) while only the 4 callable screens moved. Full web verify after approval
  = 20 ok, 0 regression, 0 unbaselined.
- This is the regression gate (app-vs-golden, strict). `build-report.mjs` stays as the
  app-vs-mockup tolerant triage view.

## Foundation / seam changes (desktop JVM target + tests only; no prod/wasm/android-app impact)

- `FirestoreInterop.jvm.kt`: +9 `JvmFirestoreFixtures` seams (8 stream fields + scalar helper,
  plus `callableResponses`); flipped 8 hard-stubbed streams + the `platformInvokeCallable`
  actual to fixture-backed. All default to null/empty = unchanged desktop-app behavior.
- `Platform.jvm.kt`: real `nowIso()` (was a throw stub).
- `composeApp` jvmTest: added `ktor-client-java` engine (N8nClient construction under JVM test).
