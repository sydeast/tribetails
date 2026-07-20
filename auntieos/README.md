# AuntieOS Workspace Map

This repository contains multiple subprojects. Use this map to avoid targeting the wrong one.

## Canonical Targets

- `web/` - **AuntieOS product web app** (Compose Multiplatform / Wasm) — admin/auntie-facing
- `android/` - **AuntieOS product Android app** — admin/auntie-facing
- `/Users/sydeast/Projects/testai/CascadeProjects/MyTribe/` - **MyTribe kinfolk app** (Kotlin / Compose Multiplatform) — client/kinfolk-facing; lives in a SEPARATE directory outside this repo. Its TypeScript Functions are at `MyTribe/functions/`.
- `sotu-hosting/` - SOTU hosting + Firebase ops scripts (**not** the product web app)
- `twilio-functions/` - Twilio Function scripts

## Task Routing Rules

1. If the task says "AuntieOS web app", work in `web/`.
2. If the task says "MyTribe" or "kinfolk app" or "client app", work in `MyTribe/`.
3. Only use `sotu-hosting/` when the task explicitly mentions SOTU, hosting, or Firebase ops/scripts.
4. MyTribe functions (TypeScript, at `/Users/sydeast/Projects/testai/CascadeProjects/MyTribe/functions/`) and `web/functions/` (JavaScript: setAdminClaim, listAdmins, signCloudinaryUpload, searchMapbox, retrieveMapbox, sendMessage, generate) are separate Firebase Functions codebases deploying to the same project `auntieos-ttpc`. Never mix them. Owner ruling 2026-07-15: **MyTribe's are the right ones**; plan item A7 folds `web/functions` into that codebase.
   (Corrected 2026-07-15: this line used to name `sotu-hosting/functions/`. **That directory does not exist.** `sotu-hosting/` is hosting-only — a static status site, `"site": "auntieos"`, with no functions and no firestore config.)
5. If a request is ambiguous, ask which target before changing code.

## Git

Local repo since 2026-07-15. No remote yet (hosting waits on key rotation).

**Enable the pre-commit gate after cloning** — `core.hooksPath` is local config and
does not travel with the repo:

```
git config core.hooksPath .githooks
```

It blocks, in ~1s: credentials in staged content (scanned by CONTENT, because
filename patterns are not sufficient here — `android/Scratch Folder/fcmChannelFirebase.json`
is a real service-account key matching none of them), `web/firestore.rules`
drifting from MyTribe's copy (both deploy to the same project), and failing
`web/functions` tests.

There is deliberately no `.github/workflows`: with no remote it would never run.
MyTribe has exactly that dead file — `functions-ci.yml` exists, `MyTribe/.git`
does not, so it has never executed.

## Quick Start Commands

### Web app (`web/`)

```bash
cd /Users/sydeast/Documents/TribeTails_Docs/Communication/AuntieOS/web
./gradlew :composeApp:wasmJsBrowserDevelopmentRun
```

Prod-like local run:

```bash
cd /Users/sydeast/Documents/TribeTails_Docs/Communication/AuntieOS/web
./gradlew wasmJsBrowserProductionWebpack
firebase emulators:start --project auntieos-ttpc --only hosting,functions
```

Open `http://127.0.0.1:5000`.

Production deploy:

```bash
cd /Users/sydeast/Documents/TribeTails_Docs/Communication/AuntieOS/web
./gradlew wasmJsBrowserProductionWebpack
firebase deploy --config firebase.json --project auntieos-ttpc --only hosting,functions,firestore
```

This is the canonical deploy path for the AuntieOS web app. It ships the web
bundle from `web/composeApp/build/dist/wasmJs/productionExecutable`, the same-origin
`/api/*` Hosting rewrites, the shared Cloud Functions under `sotu-hosting/functions/`,
and the Firestore rules in `sotu-hosting/firestore.rules`.

NOTE: NEW Cloud Functions/callables belong in MyTribe/functions/ (canonical, per CLAUDE.md and the n8n-to-Functions migration plan). web/functions/ and sotu-hosting/functions/ are existing/hosting-helper code, not the home for new callables.

### Android app (`android/`)

```bash
cd /Users/sydeast/Documents/TribeTails_Docs/Communication/AuntieOS/android
./gradlew assembleDebug
```

### SOTU tooling (`sotu-hosting/`)

```bash
cd /Users/sydeast/Documents/TribeTails_Docs/Communication/AuntieOS/sotu-hosting
npm run push
```

`sotu-hosting/` is not the deploy root for the product web app. Use `web/`
for real AuntieOS web production deploys.
