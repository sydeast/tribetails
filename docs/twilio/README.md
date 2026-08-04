# Twilio — Tribe Tails Pet Care

Single source of truth for everything Twilio in this monorepo: where the code
lives, what env vars it needs, how to get a Twilio account wired up from
scratch, and what's currently broken. Written 2026-08-01 by consolidating the
docs listed under "Archived / superseded" at the bottom — read this file
first; only dig into an archived doc if you need the full historical detail
behind a decision.

## There are two separate Twilio integrations here

Tribe Tails uses Twilio in two independent places that do not share code,
credentials, or a Twilio account product:

1. **`auntieos-admin/twilio-service/`** — Auntie's business phone line
   (`tribetailsattendant-8587.twil.io`). A Twilio Serverless (Functions +
   Assets) service that answers inbound calls via a Studio Flow, screens
   callers, records voicemail, and lets the Android admin app place/receive
   calls through the Voice SDK. Deployed with `twilio-run deploy`.
2. **`mytribe/functions/`** — the Kinfolk-facing app's outbound notifications
   (SMS via `src/lib/twilio.ts`) and inbound webhook handlers
   (`src/twilio/twilioInbound.ts`) running as Firebase Cloud Functions. This
   is what texts Kinfolk about bookings/reminders and records inbound
   SMS/voicemail/call events into Firestore.

Keep that distinction in mind below — "set the Twilio env vars" means
different vars in different places depending on which integration you're
touching.

## Where the code lives

| Integration | Path | Deploy mechanism |
|---|---|---|
| Business voice service | `auntieos-admin/twilio-service/functions/` | `twilio-run deploy` (Twilio Serverless) |
| Studio Flow definition | `auntieos-admin/studio_flow_v2.json` | Import into Twilio Console → Studio |
| Studio Flow blueprint (human-readable) | `docs/twilio/studio-flow-reference.md` | reference only |
| Kinfolk app outbound SMS | `mytribe/functions/src/lib/twilio.ts`, `src/notifications/senders/smsChannel.ts`, `src/admin/sendExternalMessage.ts`, `src/admin/broadcastMessage.ts` | `firebase deploy --only functions` |
| Kinfolk app inbound webhooks | `mytribe/functions/src/twilio/twilioInbound.ts` | deployed as Cloud Run services (`twilioinboundsms`, `twilioinboundvoicemail`, `twilioinboundcall`) |
| Smoke tests | `mytribe/functions/docs/NOTIFICATION_SMOKE_TESTS.md` | — |

`auntieos-admin/twilio-functions/` (the old, pre-migration copy of the
business voice functions) has been archived — see "Archived / superseded"
below. Nothing in the active codebase references it.

## Env vars

**Business voice service** (`auntieos-admin/twilio-service/.env` — copy from
`.env.example` in that folder, gitignored, never commit real values):

```
ACCOUNT_SID=                  # Twilio Account SID (Console → Account Info)
AUTH_TOKEN=                   # Twilio Auth Token (Console → Account Info)
DOMAIN_NAME=                  # your deployed *.twil.io domain, e.g. tribetailsattendant-8587.twil.io
TWILIO_BUSINESS_NUMBER=       # the Twilio number this service answers/dials as
TWILIO_PERSONAL_NUMBER=       # Auntie's personal line, excluded from product sends by policy
CLIENT_IDENTITY=auntie
PERSONAL_CLIENT_IDENTITY=personal
TWIML_APP_SID=                # Console → Voice → TwiML Apps (needed for Android Voice SDK)
PUSH_CREDENTIAL_SID=          # Console → Voice → Push Credentials (FCM)
TWILIO_API_KEY_SID=           # Console → Account → API keys & tokens (Standard key)
TWILIO_API_KEY_SECRET=
FCM_DEVICE_TOKEN=
SENDGRID_API_KEY=
SENDGRID_FROM_EMAIL=
MY_EMAIL=
```

**Kinfolk app (mytribe/functions)** — set as Firebase Functions secrets, not
plain env vars, so they're pulled from Secret Manager at deploy time:

```
TWILIO_ACCOUNT_SID
TWILIO_AUTH_TOKEN
TWILIO_FROM_NUMBER            # see "known issue" below before setting this
TWILIO_STATUS_CALLBACK_URL
TWILIO_INBOUND_SMS_URL        # https://us-central1-<project>.cloudfunctions.net/twilioInboundSms
TWILIO_INBOUND_VOICEMAIL_URL  # https://us-central1-<project>.cloudfunctions.net/twilioInboundVoicemail
TWILIO_INBOUND_CALL_URL       # https://us-central1-<project>.cloudfunctions.net/twilioInboundCall
```

## Getting Twilio connected from scratch

If you're setting this up in a new Twilio account (or onboarding a new
developer to the existing one), do this in order:

1. **Create/access the Twilio account.** console.twilio.com → sign up, or get
   added as a user on the existing "TribeTails" account. Grab the **Account
   SID** and **Auth Token** from the Console dashboard — these go in both
   integrations' env above.
2. **Get a phone number.** Console → Phone Numbers → Buy a Number. Pick one
   with Voice + SMS capability in the area code you want. (This repo's
   existing owned number is `+18054636550` — see the known-issues section for
   why the business's *published* number, `+17373432928`, is not the same
   thing and cannot send SMS as-is.)
3. **Deploy the business voice service:**
   ```bash
   cd auntieos-admin/twilio-service
   cp .env.example .env        # fill in ACCOUNT_SID, AUTH_TOKEN, and the rest
   npm install
   npm run deploy              # runs `twilio-run deploy`
   ```
   This publishes to a new `<service-name>-####.twil.io` domain — update
   `DOMAIN_NAME` and anywhere the old domain is hardcoded (Android:
   `CallScreenActivity.kt`, `CallsViewModel.kt`, `TwilioApi.kt`) if you're
   standing up a fresh service rather than reusing the existing one.
4. **Build the Studio Flow.** Console → Studio → Create new Flow → build it
   per `docs/twilio/studio-flow-reference.md` (widget-by-widget graph), or
   import `auntieos-admin/studio_flow_v2.json` directly. That JSON is NOT
   templated: it hardcodes the live domain `tribetailsattendant-8587.twil.io`
   in 13 places and contains no placeholders. A fresh import therefore points
   your new flow at the production service. If you are standing up a separate
   service, search-and-replace that domain with the one from step 3 before you
   publish the flow. Upload the 6 audio assets it references
   (`after_hours_greeting`, `open_hours_greeting`, `open_hours_retry`,
   `gather_intro`, `try_text_suggestion`, `thank_you_vm`) into
   `twilio-service/assets/`.
5. **Point the number at the Flow.** Console → Phone Numbers → your number →
   Voice → "A Call Comes In" → Studio Flow → select the flow from step 4.
6. **Set up the Voice SDK path (if you need in-app calling).** Console →
   Voice → TwiML Apps → create one, set its Voice Request URL to your
   service's `/incoming-call-client` endpoint, put its SID in
   `TWIML_APP_SID`. Console → Voice → API keys → create a Standard key for
   `TWILIO_API_KEY_SID`/`SECRET`. Console → Voice → Push Credentials → add
   your FCM server key for `PUSH_CREDENTIAL_SID`.
7. **Wire the Kinfolk app's inbound webhooks** (mytribe — this is what makes
   inbound SMS/voicemail/calls actually reach Firestore instead of vanishing):
   ```bash
   gcloud run services update twilioinboundsms --region us-central1 \
     --update-env-vars TWILIO_INBOUND_SMS_URL=https://us-central1-<project>.cloudfunctions.net/twilioInboundSms
   gcloud run services update twilioinboundvoicemail --region us-central1 \
     --update-env-vars TWILIO_INBOUND_VOICEMAIL_URL=https://us-central1-<project>.cloudfunctions.net/twilioInboundVoicemail
   gcloud run services update twilioinboundcall --region us-central1 \
     --update-env-vars TWILIO_INBOUND_CALL_URL=https://us-central1-<project>.cloudfunctions.net/twilioInboundCall
   ```
   Then in Console → Phone Numbers → your number:
   - **SMS:** Messaging → "A Message Comes In" → Webhook, HTTP POST → the
     `twilioInboundSms` URL above.
   - **Voicemail:** in the Studio Flow's "Record Voicemail" widget, set
     Transcription Callback URL and Recording Status Callback URL → the
     `twilioInboundVoicemail` URL, method POST.
   - **Call status:** set the number's Voice "Call Status Changes" webhook (or
     the Studio "Trigger" widget's status callback) → the
     `twilioInboundCall` URL, POST.
   Verify: text the number → check Firestore `sms_messages` for a new doc
   keyed by the Twilio `MessageSid`. Leave a voicemail → `voicemails` gets a
   doc. Complete a call → `calls_log` gets a doc. A `403` in
   `gcloud run services logs read twilioinboundsms --region us-central1` means
   the env URL doesn't match what's actually configured in Twilio.
8. **Register for A2P 10DLC** (required before SMS reliably delivers to US
   carriers — see known issues). Console → Messaging → Regulatory Compliance
   → brand registration, then a campaign, then add your number to a
   Messaging Service's sender pool. Two TrustHub customer profiles already
   exist and are approved for this account (`BUabcdcba2...`,
   `BUd494947c...`) — brand registration can build on one of those instead of
   starting cold.
9. **Set the mytribe Functions secrets** (`TWILIO_ACCOUNT_SID`,
   `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER`, plus the inbound URLs from step
   7) via `firebase functions:secrets:set <NAME> --project <project>`, then
   `firebase deploy --only functions`. `mytribe/functions/docs/NOTIFICATION_SMOKE_TESTS.md`
   has the full pre-flight checklist for exercising the send/receive path
   afterward.

Local dev note: setting `SEND_SUPPRESS=1` on the mytribe functions makes
`getTwilio()` return a stub that logs sends instead of contacting Twilio, so
you can develop without any Twilio credentials at all (see
`mytribe/functions/src/lib/twilio.ts`).

## Known issues (last verified against the live account 2026-07-20 — re-verify before trusting)

- **The business's published number, `+17373432928`, cannot send SMS.** It's
  only a Verified Caller ID on this account (grants outbound voice caller-ID
  display, nothing for SMS) — it's not a Twilio-owned number. Every SMS sent
  `from` it fails with error **21659**. This is a product decision (Twilio
  Hosted SMS for that number, a full port, or sending from the owned
  `+18054636550` and leaving the published number voice-only), not a config
  typo — don't just swap the env var without picking a strategy.
- **Both owned numbers' inbound SMS webhook still points at Twilio's demo
  endpoint** (`demo.twilio.com/welcome/sms/reply`), not `twilioInboundSms` —
  inbound texts are invisible to the app until step 7 above is done.
- **A2P 10DLC registration has not been started** (0 brand registrations as
  of the last check) — SMS to US numbers is unreliable/blocked without it.
- **The Voice SDK token endpoint 404s** (`/get-token`) and no TwiML
  Application exists on the account, so in-app calling (Android Voice SDK)
  doesn't work yet — needs step 6 above.
- **`getTwilioFromNumber()` in `mytribe/functions/src/lib/twilio.ts` reads a
  bare env var.** Once a Messaging Service is set up (step 8), the 3 call
  sites (`smsChannel.ts`, `sendExternalMessage.ts`, `broadcastMessage.ts`)
  should switch to passing `messagingServiceSid` instead of `from`, which
  fixes both the 21659 issue and the earlier 10DLC/toll-free errors at once.
- **The Studio Flow's `incomingMessage` node has no destination** — a text
  landing in the voice flow currently goes nowhere silently.

## Archived / superseded

These are kept for historical reference, not deleted, since they document
*why* things are the way they are:

- `auntieos-admin/archive/twilio-functions-deprecated/` — the pre-migration
  copy of the business voice functions. Fully superseded by
  `twilio-service/functions/` since 2026-07-16; nothing deploys or imports
  from here. See its `README.md` for the full migration history.
- `auntieos-admin/docs/archive/2026-07-20-twilio-state-dump.md` — the raw
  live-account audit this doc's "Known issues" section was distilled from.
  Read it if you need exact SIDs, error tables, or the account balance/call
  history at that point in time.
- `auntieos-admin/archive/n8n-workflow-snapshots-2026-05/` — dry-run JSON
  snapshots from the n8n-to-Firebase-Functions migration (includes an old
  n8n "Send Message" workflow that called Twilio). Disposable migration
  debris, kept only because a prior handoff gated its deletion on a
  verification step; safe to delete outright once that's confirmed.

Two operator runbooks still carry Twilio-specific step-by-step instructions
that overlap with section 7 above and haven't been fully folded in yet:
`auntieos-admin/docs/runbooks/RUNBOOK_2026-06-23-operator-leftovers.md` §4
and `auntieos-admin/docs/runbooks/OPERATOR_TODO_2026-06-25.md` §D. They cover
non-Twilio operator tasks too, so they weren't moved — this doc's step 7 is
the deduplicated version of their Twilio content.
