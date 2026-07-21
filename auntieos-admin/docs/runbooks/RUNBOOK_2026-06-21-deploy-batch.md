# Deploy Runbook: n8n cutover + 4 critical fixes (2026-06-21)

Operator-executed. All code is built and green; nothing is live. This runbook orders the deploys, names the validation gate after each, and gives the exact rollback per step. Source handoff: `docs/archive/handoffs/HANDOFF_2026-06-21-n8n-retirement-EXECUTED.md`. Review resolutions: top of `docs/reviews/CODE_REVIEW_2026-06-18.md`.

No tree is a git repo, so "rollback" means redeploy the prior artifact. Before each deploy that has a rollback, keep the currently-live version (copy the rules file, note the current function revision).

## What is shipping

Two independent change sets, one operator session:

1. **n8n retirement** (expand-contract migration). Expand is already in code: the web and android clients call the direct `sendExternalMessage` callable for Inbox/Messaging replies, and call `synthesize_kinfolk_profile` for the "Refresh intelligence" button. The n8n endpoints stay live as a hot fallback through the verify gate. Contract (Phase B) deletes n8n only after the gate passes.
2. **Four critical fixes** (C-1 android log gate, C-2 sandbox rules, C-4 portal permission gate, C-5 reconcile idempotency). Each is additive and rides one of the deploys below.

## Risk per change

| Change | Deploy | Blast radius | Primary risk | Mitigation |
|---|---|---|---|---|
| `sendExternalMessage` transactional flag (A1) | `functions:mytribe` | one callable | a transactional reply skips suppression when it should not | default `false` is byte-identical to today (proven by the suppression-honored tests); A8 verifies a one-off send to a suppressed recipient is still blocked |
| `synthesize_kinfolk_profile` (A6b) | `functions:reconcile` | new callable + nightly pipeline | button calls a callable that is not live | fails loud (button shows an error); deploy before relying on it; admin-gated, single-kin scope |
| C-2 sandbox rules | `firestore:rules` | global (all reads/writes) | a wrong split locks out legitimate test-admin writes, or fails to close the hole | 75 rules tests + the new exploit test; both mirror files byte-identical |
| C-4 portal permission gate | `functions:mytribe` | 7 portal callables | a legacy primary with no member doc is locked out | anti-lockout fallback (missing member doc falls back to the existing membership check); operators bypass; the perm model is the documented one |
| C-5 reconcile claim-first | `functions:reconcile` | nightly + on-demand synthesis | the real (test-Fake-only) transaction path misbehaves, or logs strand in `in_progress` | read-validated; `in_progress` is the safe failure mode (no double-merge); reconcile after the first run (below) |

## Execution order

Deploy backend before the clients that call it, so a client's new call always hits a live target. The n8n endpoints stay up the whole time, so there is no window where a reply has nowhere to go.

1. **`firestore:rules` (C-2).** Isolated. Deploy from the canonical rules location (the header in `firestore.rules` names it; both mirror files are identical). Gate: in a prod-like project, run the test-admin re-tag of a live doc and confirm it is denied (`functions/test/rules/testAdminSandbox.test.ts` covers it). Rollback: redeploy the prior rules file.
2. **`functions:mytribe`.** One deploy covers `sendExternalMessage` (n8n A8 backend), the C-4 portal permission gate, and the C-3 redeemCredit race fix. Gate: callable list shows `sendExternalMessage` updated; a transactional reply send succeeds; a one-off send to a suppressed test recipient still throws `recipient_opted_out`; a `kintales_only` secondary is denied on `addKin`/`payInvoice`/`saveHomeAccess`; redeeming the same credit invoice twice (concurrently or in sequence) applies it once and the second throws `Credit already redeemed.` Rollback: redeploy the prior `functions:mytribe` revision.
3. **`functions:reconcile`.** One deploy covers `synthesize_kinfolk_profile` (A6b) and the C-5 claim-first fix. Gate: `synthesize_kinfolk_profile` is listed; an on-demand synth for one kinfolk completes and updates that kin's dossier; no logs strand `in_progress` after it runs. Rollback: redeploy the prior `functions:reconcile` revision.
4. **Web: rebuild wasm + `hosting:auntieos-ttpc`.** Ships the Inbox-reply repoint (A3) and the dropped profile ping (A4). Verify the live app-wasm hash changed (the project has a known false-up-to-date trap; use `rm -rf composeApp/build/dist/wasmJs/productionExecutable && ./gradlew :composeApp:wasmJsBrowserDistribution --rerun-tasks` before the hosting deploy). Rollback: redeploy the prior hosting release.
5. **Android: build + sideload APK.** Ships C-1 (release log gate), the reply repoints (A5/A6), and the `synthesizeProfile` repoint (A6b). No server deploy; the APK is the artifact. Rollback: sideload the prior APK.

## Verify gate (A8). Phase B does not start until this passes on all three platforms.

With a real admin login on web, desktop, and android:
- Send an Inbox SMS reply and an email reply to a test recipient. Confirm delivery, the `external_messages` doc carries `transactional: true`, and an audit row exists.
- Confirm a suppressed test recipient still receives a transactional Inbox reply, but a one-off Communicate send to that recipient is still blocked with `recipient_opted_out`.
- Tap "Refresh intelligence" (android) and confirm it reaches `synthesize_kinfolk_profile` and updates the dossier.

## Phase B (contract): only after A8 passes. Irreversible.

1. `web/functions/index.js`: delete `sendMessage` (proxy), `writeDraft`, `getDraft`, `getTrainingDoc`, and the `N8N_*` secrets/helpers. `web/firebase.json`: drop the `/api/send-message` rewrite. Redeploy `functions,hosting:auntieos-ttpc`.
2. Delete `web/.../data/N8nClient.kt`, `android/.../data/api/N8nApi.kt`, `RetrofitClient.buildN8n`, and the now-dead `AuntieRepository.sendMessage` method (deleting `N8nApi` without it breaks the build). Move web `generate` into a non-n8n client. Rebuild + redeploy web, rebuild APK.
3. Delete `create_n8n_workflows.py` and `_workflow_snapshots/` (the latter also removes the leaked Anthropic key). Operator removes `BASEROW_*`/`N8N_*` from `.env`.
4. Operator shuts down the Debian box, the Docker n8n stack, and the Cloudflare tunnel for `n8n.tribetails.com`.

## Data reconciliation (run once, after the first nightly reconcile post-deploy)

The C-5 claim-first fix writes `reconcileClaimedAt` when it flips a log to `in_progress`. A log that crashed mid-flight stays `in_progress` (safe: it is skipped, not double-merged). To re-process stranded logs, query the six log collections for `reconcileStatus == 'in_progress'` with an old `reconcileClaimedAt`, and reset them to `pending`. The lease timestamp exists for exactly this sweep; an automated reclaim is a later enhancement.

## Rollback summary

- Pre-Phase-B client regression (a reply fails): repoint the client reply call back to `n8n.sendMessage` and redeploy that client. n8n is still live. The backend flag is additive, so the backend needs no rollback.
- Rules / functions / python: redeploy the prior revision (kept before each deploy).
- Phase B: no rollback. It is gated on A8 for that reason. Keep the `_workflow_snapshots` backup only until the operator confirms the shutdown, then delete it (it holds the leaked key).

## Open decisions before Phase B

- C-4 `saveHomeAccess` is gated on `kin_edit`. If gate-code/wifi secrets should be primary-only, change it to `requirePrimary` and redeploy `functions:mytribe` (one-line change) before A8.
- C-3 redeemCredit double-redeem race is now FIXED (claim-first transaction + Stripe `idempotencyKey`); it rides the `functions:mytribe` deploy alongside C-4.
- Two pre-existing android unit-test failures (`FeatureFlagsTest` count, `KinTaleReportDeliveryTest` GPS) are unrelated to this batch and do not gate it.
