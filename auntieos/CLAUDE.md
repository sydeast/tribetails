## NON-NEGOTIABLE #1: FULLSTACK ON ALL THREE PLATFORMS, OR IT IS NOT DONE

Backend IS in scope and IS reachable. All repos are available to you in this
session — you created them. The MyTribe Cloud Functions live at
`/Users/sydeast/Projects/testai/CascadeProjects/MyTribe/functions/` (separate
dir, same workspace). AuntieOS web/android live here.

A feature is DONE only as a full vertical slice, delivered on EVERY platform:
  backend (MyTribe Cloud Function) + validation + frontend wiring + routes +
  component + error handling + tests (unit, integration, e2e, happy + sad +
  negative + error)
  — on WEB (Wasm) AND DESKTOP (JVM) AND ANDROID. All three. Never two.

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

- AuntieOS product web app lives in `web/` (Compose Multiplatform / Wasm).
- AuntieOS desktop app is the JVM target of the same Compose app in `web/` (jvm/desktop). It is a FIRST-CLASS platform — every feature ships to web, desktop, AND android.
- AuntieOS Android app lives in `android/`.
- MyTribe Cloud Functions (the real backend / callables) live at `/Users/sydeast/Projects/testai/CascadeProjects/MyTribe/functions/` — separate dir, same workspace, in scope. New callables go there.
- `sotu-hosting/` is infrastructure for SOTU/ops hosting and Firebase helper scripts.
- Do not treat `sotu-hosting/` as the primary AuntieOS product web app unless the task explicitly asks for SOTU, hosting, or functions work there.

