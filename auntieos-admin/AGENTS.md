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

`auntieos-admin/CLAUDE.md` is the authority for this tree and `docs/RUNBOOK.md`
for operations. What follows is the routing map only. Where this file disagrees
with those, they win and this file is the bug.

- **The live operator admin is `src/`** (React + Vite + TanStack). It serves
  auntie.tribetails.com and has since 2026-07-20. Admin features go here.
- `web/composeApp/` is Kotlin Multiplatform: shared logic plus the desktop (jvm)
  build. Its wasm admin was superseded by `src/` and deleted in #481; desktop is
  PAUSED by owner ruling, not withdrawn. Not a delivery target. It still
  compiles, is where `:composeApp:jvmTest` runs, and is not dead code, but
  nothing new goes in it.
- The AuntieOS operator Android app is `android/` (`com.tribetails.auntieos`).
  A permanent surface.
- `mytribe/` is a sibling PREFIX in this same repository, not a separate repo;
  the two were merged on 2026-07-21. It holds three shipping things: the Cloud
  Functions (`mytribe/functions/`, TypeScript, the real backend), the Kinfolk
  portal web app (`mytribe/web/`), and the Kinfolk portal ANDROID app, which is
  the Compose `mytribe/src/` tree (`com.kinfolk.portal`, registered in Firebase
  as MyTribe-Android). That Compose tree is live.
- So this repo ships TWO Android apps: `auntieos-admin/android`
  (`com.tribetails.auntieos`) and `mytribe` (`com.kinfolk.portal`). "Android" on
  its own is ambiguous here. Say which one you mean.
- `sotu-hosting/` is the project status page (SOTU) and Firebase ops scripts. It
  has NO Cloud Functions: its `firebase.json` declares hosting only. Do not
  treat it as the product web app.
- Firebase: one project `auntieos-ttpc`, one Firestore, one Auth tenant, shared
  by every surface above. THREE Functions codebases:
    `mytribe`   -> `mytribe/functions` (TS). The real backend, 185 callables.
    `default`   -> `auntieos-admin/web/functions` (Node). AuntieOS-owned.
    `reconcile` -> `auntieos-admin/web/functions-python` (Python). Dossier/411.
- NEW shared callables belong in `mytribe/functions/`. The other two codebases
  are existing AuntieOS-owned code, not the home for new cross-app callables.

This repo is under git with CI (`.github/workflows/ci.yml`). Branch per task,
never commit on `main`, land through a PR. Several older plans under `docs/` say
"no git in this project"; that was true when they were written and is not an
instruction now.
