## NON-NEGOTIABLE #1: FULLSTACK ON ALL THREE PLATFORMS, OR IT IS NOT DONE

Backend IS in scope and IS reachable. All repos are available to you in this
session — you created them. The MyTribe Cloud Functions live at
`/Users/sydeast/Projects/testai/CascadeProjects/MyTribe/functions/` (separate
dir, same workspace). The AuntieOS React admin, Kotlin tree, functions, android app and visual
harness all live here, in this one repo.

A feature is DONE only as a full vertical slice, delivered on EVERY platform:
  backend (MyTribe Cloud Function) + validation + frontend wiring + routes +
  component + error handling + tests (unit, integration, e2e, happy + sad +
  negative + error)
  on the React admin (`src/`) AND ANDROID. Desktop parity is paused by owner
  ruling, and the wasm admin is superseded, so neither is a delivery target.

A missing callable means BUILD the callable. It is NEVER a reason to stop,
defer, or ship frontend-only. There is NO "gate dark / Not-wired banner" option
for our own code.

The ONLY thing you may ever defer is something needing an EXTERNAL SECRET the
operator must physically provide (third-party OAuth client IDs, calendar
provider keys). For those: STOP and name the exact secret. Nothing else.

Do not invent repo/scope/platform blockers. If you think something is blocked,
assume your default is wrong: re-check, then build it — backend + web + desktop
+ android + tests.

---

Error Handling Philosophy: Fail Loud, Never Fake

Never silently swallow errors. Surface them.
Fallbacks acceptable ONLY when disclosed with a visible banner or warning.
Priority order:
1. Works correctly
2. Fails visibly with clear error
3. Silent degradation (NEVER)

If missing credentials, files, or dependencies:
STOP and ASK. Do not fabricate sample data to continue.

Project Routing Rules (AI + Human)

This repo is the SINGLE AuntieOS source as of 2026-07-21. It absorbed the tree
that used to live under Documents/TribeTails_Docs/Communication/AuntieOS.

- **The live web admin is `src/` (React + Vite + TanStack).** It serves
  auntie.tribetails.com. Build here, and drive this when verifying.
- `web/composeApp/` is Kotlin Multiplatform: shared logic plus the desktop (jvm)
  app. The wasm admin it also builds is SUPERSEDED by `src/` and is not where
  admin features go.
- AuntieOS Android app lives in `android/`. A permanent surface.
- AuntieOS-owned Cloud Functions live in `web/functions/` (Node, Firebase
  codebase `default`) and `web/functions-python/` (codebase `reconcile`).
- MyTribe Cloud Functions (most of the callables this admin invokes) live at
  `/Users/sydeast/Projects/testai/CascadeProjects/MyTribe/functions/`, a sibling
  directory in the same workspace. In scope. New shared callables go there.
- Desktop parity is PAUSED by owner ruling. Web plus mobile only.
- `sotu-hosting/` is infrastructure for SOTU/ops hosting and Firebase helper scripts.
- Do not treat `sotu-hosting/` as the primary AuntieOS product web app unless the task explicitly asks for SOTU, hosting, or functions work there.

