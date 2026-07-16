# Operator Runbook — leftover items (2026-06-23)

All code is built, deployed, and verified on `auntieos-ttpc`. These are the physical/external steps only you can do. Each is independent unless noted. Project = `auntieos-ttpc` throughout.

Prereqs: `firebase` CLI logged in (`firebase login:list`), `gcloud` logged in to the same project (`gcloud config set project auntieos-ttpc`), `adb` for the APK, and Firebase Console access. The new debug APK is at `android/app/build/outputs/apk/debug/app-debug.apk` (152M).

---

## 1. Sideload the new APK (do first — needed for W8 + the android code-review fixes)

1. Connect the admin Android device by USB, enable USB debugging.
2. `adb devices` — confirm it lists the device.
3. `adb install -r /Users/sydeast/Documents/TribeTails_Docs/Communication/AuntieOS/android/app/build/outputs/apk/debug/app-debug.apk`
4. Repeat for each admin device.

Safe to do now: every new flag defaults OFF, so behavior is unchanged until you flip a flag (steps 4 and 6).

---

## 2. Turn on the AI "last comms" recap (commsRecap) — quick win

Two ways; pick one.

**A) From the app (easiest):** open AuntieOS (web `https://auntieos-ttpc.web.app` or the app) as admin → Settings → Feature Flags → toggle **Communicate: comms recap** ON → Save.

**B) Firestore Console:** Firebase Console → Firestore → `business_settings/feature_flags` → the `flags` map → add/set key `auntieos.communicate.commsRecap` = `true` → Save.

Effect: the "Where things last left off" AI recap appears on the Communicate recipient box. Until then it shows the raw latest message (disclosed). Reversible — set back to `false`.

---

## 3. W32 — backfill `reconcileStatus` on legacy `kin_care_reports`

Makes the reconcile pipeline stop starving legacy KinTale reports. Idempotent; safe to re-run.

```bash
cd /Users/sydeast/Documents/TribeTails_Docs/Communication/AuntieOS/web/functions-python
# dry run first (no writes) — review the count it reports:
GCLOUD_PROJECT=auntieos-ttpc ./venv/bin/python backfill_kincare_reconcile_status.py
# then apply:
GCLOUD_PROJECT=auntieos-ttpc ./venv/bin/python backfill_kincare_reconcile_status.py --allow-prod
```

Auth: it uses the service-account JSON at the repo root (or ADC). If it can't auth, run `gcloud auth application-default login` first.

---

## 4. Close WARNING-8 (server-authoritative inbound comms)

The 3 server webhooks are LIVE. This wires Twilio to them, verifies, then flips the android client off the spoofable push-write path.

### 4a. Set the signature URL env on each webhook (required — wrong/empty URL → 403)
Pick ONE URL form per webhook and use the SAME string in Twilio (step 4b) and here. Recommended (stable alias):
- SMS: `https://us-central1-auntieos-ttpc.cloudfunctions.net/twilioInboundSms`
- Voicemail: `https://us-central1-auntieos-ttpc.cloudfunctions.net/twilioInboundVoicemail`
- Call: `https://us-central1-auntieos-ttpc.cloudfunctions.net/twilioInboundCall`

Set them on the deployed services (no redeploy):
```bash
gcloud run services update twilioinboundsms --region us-central1 \
  --update-env-vars TWILIO_INBOUND_SMS_URL=https://us-central1-auntieos-ttpc.cloudfunctions.net/twilioInboundSms
gcloud run services update twilioinboundvoicemail --region us-central1 \
  --update-env-vars TWILIO_INBOUND_VOICEMAIL_URL=https://us-central1-auntieos-ttpc.cloudfunctions.net/twilioInboundVoicemail
gcloud run services update twilioinboundcall --region us-central1 \
  --update-env-vars TWILIO_INBOUND_CALL_URL=https://us-central1-auntieos-ttpc.cloudfunctions.net/twilioInboundCall
```
(Alternative: add the 3 `TWILIO_INBOUND_*_URL=...` lines to `MyTribe/functions/.env` and `cd MyTribe && firebase deploy --only functions:mytribe`.)

`TWILIO_AUTH_TOKEN` is already set on these functions — no action.

### 4b. Repoint Twilio to the webhooks (your Studio rebuild fits here)
Twilio Console → Phone Numbers → Manage → Active Numbers → your number:
- **SMS:** Messaging → "A MESSAGE COMES IN" → Webhook, **HTTP POST**, URL = the SMS URL above. Save. (Inbound SMS isn't wired today, so this is net-new.)
- **Voicemail:** in the Studio flow's "Record Voicemail" widget (or the `<Record>` TwiML): set **Transcription Callback URL** and **Recording Status Callback URL** = the Voicemail URL above, method POST.
- **Call:** set the call's **statusCallback** (Studio "Connect Call To" / Trigger, or the number's Voice "Call Status Changes" webhook) = the Call URL above, POST.

Keep the existing FCM-notify path (the webhook only writes the record; it does not send the admin push notification).

### 4c. Verify records land server-side
- Text the Twilio number from a test phone → Firestore `sms_messages` should get a new doc whose **doc id = the Twilio MessageSid**, `reconcileStatus: 'pending'`.
- Leave a test voicemail → `voicemails` gets a doc (id = RecordingSid/CallSid).
- Place/complete a test call → `calls_log` gets a doc (id = CallSid).
- If you get nothing: check the function logs `gcloud run services logs read twilioinboundsms --region us-central1 --limit 50` — a `403` there means the URL env (4a) doesn't match the Twilio URL (4b).

### 4d. Flip the android client off the push-write path (do promptly after 4c passes)
App → Settings → Feature Flags → **Inbound comms: server authoritative** ON, OR Firestore `business_settings/feature_flags` → `auntieos.inboundComms.serverAuthoritative` = `true`.

Why promptly: between 4b and 4d both the server and the (old-behavior) client write. `calls_log` dedupes by CallSid (no dup), but sms/voicemail can briefly duplicate until you flip this. After the flip, the client stops writing and the server is the sole source.

---

## 5. Rotate / clean secrets

### 5a. C-6 — Anthropic API key (treat as compromised; it leaked into `_workflow_snapshots`)
1. Anthropic Console → API Keys → create a new key → revoke the old one.
2. Update Secret Manager + redeploy the functions that bind it:
   ```bash
   firebase functions:secrets:set ANTHROPIC_API_KEY --project auntieos-ttpc   # paste the new key
   cd /Users/sydeast/Documents/TribeTails_Docs/Communication/AuntieOS/web
   firebase deploy --only functions:reconcile,functions:default --project auntieos-ttpc
   ```
3. Update local dev copies: `web/functions-python/.env` (`ANTHROPIC_API_KEY=`) and the root `AuntieOS/.env`.

### 5b. W36 — Firebase Admin service-account private key (`android/serviceAccount.json`)
The on-disk key (id `6517f985ab890a9bfd54c0813b4543923d25bbf1`, SA `firebase-adminsdk-fbsvc@auntieos-ttpc.iam.gserviceaccount.com`) sits in a cloud-synced Docs folder.
- GCP Console → IAM & Admin → Service Accounts → `firebase-adminsdk-fbsvc@...` → Keys → **delete** key `6517f985...` → **Add key → JSON** → download the new one → replace `android/serviceAccount.json` (it's gitignored).
- Or, if local scripts can use ADC instead: delete the file and run `gcloud auth application-default login` for local admin work.

### 5c. W37 — Baserow + n8n tokens in `AuntieOS/.env`
- Change the Baserow account password → update `BASEROW_PASSWORD` / `BASEROW_TOKEN` (and the cached JWT lines) in `AuntieOS/.env`.
- Rotate the n8n API token in the n8n console → update `N8N_TOKEN` in `AuntieOS/.env`.
- These die with n8n Phase B (step 6), so if you're shutting n8n down soon you can fold this in there.

### 5d. C-7 — delete PII/secret dumps
```bash
cd /Users/sydeast/Documents/TribeTails_Docs/Communication/AuntieOS
rm -rf backups/ voice/_seed_backup_*.json
# _workflow_snapshots/ holds the n8n rollback backup — delete it as part of Phase B (step 6), not before.
```

---

## 6. n8n retirement — A8 verify, then I run Phase B

Phase A is live (clients call the direct callables; n8n stays as a hot fallback). Phase B (delete the dead n8n code) is irreversible, so it's gated on this verify.

### 6a. A8 device e2e — do on web, desktop, AND android, logged in as admin
1. **Inbox reply:** open a conversation, send an **SMS reply** and an **email reply** to a test recipient. Confirm: the recipient receives them; the `external_messages` doc carries `transactional: true`; an audit row exists.
2. **Suppression:** confirm a suppressed test recipient **still** receives a transactional Inbox reply, but a **one-off Communicate send** to that same recipient is blocked with `recipient_opted_out`.
3. **Refresh intelligence:** open a kinfolk profile, tap **Refresh intelligence** → confirm it completes (reaches `synthesize_kinfolk_profile`) and the dossier updates.

### 6b. Tell me "A8 passed"
Then I run Phase B: delete the n8n server fns (`sendMessage`/`writeDraft`/`getDraft`/`getTrainingDoc`) + the `/api/send-message` rewrite + `N8nClient.kt`/`N8nApi.kt`/`buildN8n` + `_workflow_snapshots/`, then redeploy `functions,hosting` and rebuild the APK.

### 6c. After Phase B (you)
Shut down the Debian box + the Docker n8n stack + the Cloudflare tunnel for `n8n.tribetails.com`; remove `BASEROW_*` / `N8N_*` from `AuntieOS/.env`.

---

## Quick reference — flags you may flip in `business_settings/feature_flags`
- `auntieos.communicate.commsRecap` → `true` (step 2, AI recap)
- `auntieos.inboundComms.serverAuthoritative` → `true` (step 4d, after Twilio verify)

## Deployed W8 webhook URLs
- `https://us-central1-auntieos-ttpc.cloudfunctions.net/twilioInboundSms` (= `https://twilioinboundsms-jhpz5ib3tq-uc.a.run.app`)
- `.../twilioInboundVoicemail` (= `https://twilioinboundvoicemail-jhpz5ib3tq-uc.a.run.app`)
- `.../twilioInboundCall` (= `https://twilioinboundcall-jhpz5ib3tq-uc.a.run.app`)
