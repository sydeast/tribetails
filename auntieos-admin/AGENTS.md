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

- AuntieOS product web app lives in `web/` (Compose Multiplatform / Wasm) — admin/auntie-facing.
- AuntieOS Android app lives in `android/` — admin/auntie-facing.
- MyTribe kinfolk app lives at `/Users/sydeast/Projects/testai/CascadeProjects/MyTribe/` — client/kinfolk-facing. Its Firebase Functions (TypeScript) live at `MyTribe/functions/`. This is a SEPARATE repo/directory from AuntieOS.
- `sotu-hosting/` is ONLY for the project status page (SOTU) and Firebase ops scripts. Its Functions are the SOTU page backend only — NOT AuntieOS app functions, NOT MyTribe functions.
- Do not treat `sotu-hosting/` as the primary AuntieOS product web app unless the task explicitly asks for SOTU, hosting, or functions work there.
- All three apps (AuntieOS web, AuntieOS Android, MyTribe) share Firebase project `auntieos-ttpc` — one Firestore, one Auth tenant. Two Functions codebases: `MyTribe/functions/` (TS, kinfolk portal) and `sotu-hosting/functions/` (JS, SOTU ops only).
- NOTE: NEW Cloud Functions/callables belong in MyTribe/functions/ (canonical, per CLAUDE.md and the n8n-to-Functions migration plan). web/functions/ and sotu-hosting/functions/ are existing/hosting-helper code, not the home for new callables.

