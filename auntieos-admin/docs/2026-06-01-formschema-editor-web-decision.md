# Decision needed — capturing `formschema-editor` on WEB

Date: 2026-06-01. **Status: RESOLVED 2026-06-01 — chose Option C (full functions-emulator), full-local variant. Web is now 20/20, full suite 60/60.** Owner: you.

## Resolution (2026-06-01)

Picked **C**, but executed as the **full-local** variant after a blocker the original options missed:
bridge line 39 routes ALL callables, so wiring the functions emulator also moved the three
already-baselined prod-callable web screens (`template-bank`, `template-assignment`,
`formschema-list`) onto the emulator. Leaving them on prod would have meant a fragile gate that
depends on live prod data (a smoke/e2e concern, not a visual-regression one), so the harness was
made fully prod-independent for callables and those 3 goldens were re-approved against seeded data.

What shipped (all DEV/harness + test-fixture; NO prod/wasm-source-behavior change, NO deploy):
- `firebase-bridge.js`: added `connectFunctionsEmulator(functions,'localhost',5001)` inside the
  existing `?emulator` block (prod path untouched). Dist copy patched verbatim (resource is copied
  byte-for-byte; no wasm recompile needed, keeps the other 16 screens byte-stable).
- `web/firebase.dev.json`: functions emulator on 5001 + `:5001` added to the dev CSP connect-src.
- `web/visual/functions-emu/`: NEW harness-only shim source that re-exports ONLY the 4 read-only
  callables (`getFormSchema`/`listFormSchemas`/`listTemplates`/`listTemplateBindings`) from
  MyTribe's compiled `lib` — the real handler wire, but WITHOUT MyTribe's firestore triggers /
  pubsub crons (which would fire on seed writes to overlapping collections `invoices`/`notifications`
  and break determinism). Verified: only 4 functions load, zero triggers.
- `web/visual/seed-emulator.mjs`: seeds 5 emailTemplates + 5 notificationTemplateBindings +
  5 formSchemas (mockup-aligned). `VISUAL_DEMO_SCHEMA_ID=tribeProfile` added to `.env`/`.env.example`.
- Re-captured 20 web screens (0 failures); all 4 callable screens verified rendering real seeded
  data. `baseline.mjs verify web` before approval = 16 ok / 3 regression / 1 unbaselined (exactly the
  callable screens), proving the change had zero collateral effect on the other 16. Approved -> 20 ok.

Follow-up (NOT done, by design): the prod-callable wire-contract signal (does prod `listTemplates`
etc. still return the shape the UI expects) belongs in a SEPARATE smoke/e2e check, not this
pixel-regression gate.

---

## Original decision doc (kept for context)

## One-line

The web (Playwright/wasm) screenshot of the `formschema-editor` screen is the only
remaining uncaptured cell (59 of 60 done). It cannot be un-blocked with config/seed
changes alone. Desktop and android already capture this screen. Pick a path below, or
leave it as a documented gap.

## Why the "just run the Functions emulator" idea does not work as-is

Two independent blockers (researched 2026-06-01, with file:line):

1. The wasm app never wires the Functions emulator.
   `web/composeApp/src/wasmJsMain/resources/firebase-bridge.js:39` hard-binds callables to
   production: `const functions = getFunctions(app, 'us-central1')`. The `?emulator` branch
   (lines 44-55) wires only `connectAuthEmulator` (9099) and `connectFirestoreEmulator`
   (8085). There is no `connectFunctionsEmulator` anywhere. So even with a Functions
   emulator running, `getFormSchema` would still hit prod `us-central1`.

2. The form-schema callables are not in this repo.
   `getFormSchema` / `listFormSchemas` / `saveFormSchema` / `deleteFormSchema` (and the
   template callables) live in the separate MyTribe repo
   (`/Users/sydeast/Projects/testai/CascadeProjects/MyTribe/functions`, e.g.
   `src/portal/getFormSchema.ts:129`). AuntieOS `web/functions/index.js` exports none of them.

So the Functions-emulator route is not config-only: it needs a wasm code change AND standing
up the external MyTribe functions codebase.

## Why desktop + android already capture this screen

The `FormSchemaEditorScreen` composable takes an injectable `repository: FormSchemaRepository`
param (default = the prod `CloudFormSchemaRepository`). The desktop Roborazzi test passes an
inline fake repo returning a demo `FormSchema`; the android test mocks the repository. The
web app is the only surface that has no injected fake -- it only runs the prod callable path.

## Options

### A. Leave as a documented gap (recommended)

Stop here. The screen is covered on desktop + android; web stays one fail-loud red cell,
already documented in `visual/report/coverage-gaps.md`. No prod/wasm change, no external
repo, no deploy. Final coverage: 59/60 cells.

Pick this if the goal is "every screen has at least one real visual reference" -- which is
already met for formschema-editor.

### B. Inject a demo repository behind the `?emulator` flag (cheapest real fix)

Mirror what desktop/android already do, in the wasm app. When the `?emulator` query flag is
set, route `FormSchemaEditorScreen` (and `FormSchemaListScreen`) to a demo in-memory
`FormSchemaRepository` instead of `CloudFormSchemaRepository`. Then rebuild the dist and
re-run `capture-web.mjs`.

- Touches: the wasm app's screen wiring (App routing) + a small demo repo, gated on the
  emulator flag so the prod path is untouched. Requires a wasm dist rebuild + emulator re-run.
- Does NOT need: the MyTribe repo, a Functions emulator, or CSP changes.
- Cost: ~half a day (wasm change + rebuild + verify). Same demo data the desktop test uses.

### C. Full Functions-emulator path (most faithful, most work)

Use the real `getFormSchema` callable end to end.

1. Add `connectFunctionsEmulator(functions, 'localhost', 5001)` to the `__useEmulator` block
   in `firebase-bridge.js`; rebuild the wasm bundle.
2. Add `http://localhost:5001 http://127.0.0.1:5001` to the `connect-src` CSP in
   `web/firebase.dev.json`, and add a `functions` emulator block.
3. Run the MyTribe functions codebase against `auntieos-ttpc` with
   `--only functions,hosting,auth,firestore` (its `lib/index.js` is already built).
4. Seed a `formSchemas/{id}` doc into the Firestore emulator and set `VISUAL_DEMO_SCHEMA_ID`.

- Cost: ~1-1.5 days, spans two repos, plus a wasm change + CSP change.
- Benefit: exercises the real callable wire (closest to prod behavior).

## Recommendation

A if the harness goal is reference coverage (the screen is already captured twice). B if you
specifically want the web surface filled with the least work and no cross-repo dependency. C
only if you need the real callable path exercised on web.

No work on this item has been started; everything above is reversible and gated on your choice.
