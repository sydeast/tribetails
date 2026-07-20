# Operator To-Do — consolidated (2026-06-25)

Everything in code is built, tested, and deployed/verified on `auntieos-ttpc`. This is the
list of physical/external/in-app steps only you can do. Detailed Twilio/secret steps live
in `RUNBOOK_2026-06-23-operator-leftovers.md`; this supersedes it and adds this session's items.

Nothing here is blocking the app — it runs today. These activate the new features and close
the security/retirement loops.

---

## A. App setup (in-app, ~2 min each)
1. **Weather area** — Settings → Weather area → enter `Austin, TX` (city/metro/ZIP, NOT a street address) → Save. Until set, both weather widgets show "set your weather area". US-only (NWS).
2. **Payment handles** — Settings → Payment options → Venmo / PayPal / Cash App → Save. Until set, the invoice "How to pay" section + the PDF omit them.
3. **Home widgets** — Home → Edit → Hidden cards → add: Cash Flow, Gatekeeper, Weather Watchdog, Heat Stroke Index. (Gatekeeper + Cash Flow are web-only for now; weather pair is on android too.)
4. **Sideload the latest APK** (sent in chat) on the A8 device — includes A8 android parity + weather + the code-review crit fixes.

## B. n8n retirement — verify gate (unblocks me deleting n8n)
Phase A is LIVE: Inbox 1:1 replies call the direct `sendExternalMessage` callable (transactional bypass); n8n stays as a hot fallback until you confirm.
5. **A8 e2e verify** on web + desktop + android, logged in as admin:
   - Inbox **SMS reply** + **email reply** to a test recipient arrive; `external_messages` doc has `transactional: true`; an audit row exists.
   - A **suppressed** test recipient STILL gets a transactional Inbox reply, but a one-off **Communicate** send to that same recipient is blocked (`recipient_opted_out`).
   - **Refresh intelligence** on a kinfolk profile completes (hits `synthesize_kinfolk_profile`) + the dossier updates.
6. **Tell me "A8 passed"** → I run Phase B: delete the n8n server fns + `/api/send-message` rewrite + `N8nClient.kt`/`N8nApi.kt` + dead `AuntieRepository.sendMessage` + `_workflow_snapshots/`, redeploy functions+hosting, rebuild APK.
7. **After Phase B (you):** shut down the n8n Debian box + Docker stack + Cloudflare tunnel for `n8n.tribetails.com`.

## C. Security — rotate / clean (do soon; some leaked)
8. **Anthropic API key (C-6, treat as compromised — leaked into `_workflow_snapshots`):** Anthropic Console → new key → revoke old → `firebase functions:secrets:set ANTHROPIC_API_KEY --project auntieos-ttpc` → `firebase deploy --only functions:reconcile,functions:default --project auntieos-ttpc`.
9. **Firebase service-account key (W36, `android/serviceAccount.json`, id `6517f985…`):** GCP IAM → Service Accounts → `firebase-adminsdk-fbsvc@…` → Keys → delete that key → add new JSON → replace the file (gitignored). Or switch local scripts to ADC and delete it.
10. **Baserow + n8n tokens (W37, `AuntieOS/.env`):** rotate `BASEROW_*` + `N8N_TOKEN`. These die with n8n Phase B — can fold into step 7.
11. **Delete PII/secret dumps (C-7):** `rm -rf backups/ voice/_seed_backup_*.json` (delete `_workflow_snapshots/` as part of Phase B).
12. **Delete the stale root twin** `AuntieOS/reconcile_comms.py` — the live one is `web/functions-python/reconcile_comms.py`. The root copy is unused + has the OLD non-idempotent code.

## D. Twilio inbound (WARNING-8 — optional; wires server-authoritative inbound)
The 3 webhooks are LIVE. Full steps in the 2026-06-23 runbook §4.
13. Set the 3 signature-URL envs on the webhooks (§4a).
14. Repoint Twilio SMS / Voicemail / Call to the 3 webhook URLs (§4b).
15. Verify records land server-side (§4c).
16. Flip `auntieos.inboundComms.serverAuthoritative` = `true` (§4d).

## E. Optional quick wins
17. `auntieos.communicate.commsRecap` → `true` (AI "last comms" recap).
18. W32 — backfill `reconcileStatus` on legacy `kin_care_reports` (script in runbook §3).

---

## Done this session (no action needed — FYI)
- **Live Bookings error fixed:** `kinCares.status` collection-group index deployed + **READY**; Bookings → Incoming requests loads.
- **All 5 code-review CRITS closed + live:** C-1 OkHttp token leak (release=NONE, in APK), C-2 test-admin update-isolation (rules), C-3 redeemCredit claim-first, C-4 portal permission gate (9 callables), C-5 reconcile idempotency. (1061 vitest + 9 pytest green; deployed.)
- **Android Bookings parity:** already present on the Schedule screen (verified) — no build needed.
- **Weather widgets W16/W17 + Cash Flow + Gatekeeper:** shipped (see A).
- **A8 android parity (K2/D1/B5/B7/B9/KT1/K1/K3/A1 + Payments + notif-master):** shipped in the APK.
