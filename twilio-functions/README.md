# DEPRECATED — do not deploy, do not edit

**Canonical tree: [`../twilio-service/`](../twilio-service/)** (it has the
`.twilioserverlessrc` + `package.json` deploy config and the `assets/` folder).

## Why this exists

This directory holds the *original* Twilio Functions for the live voice service
`tribetailsattendant-8587.twil.io` (the one Android hardcodes in
`CallScreenActivity.kt`, `CallsViewModel.kt`, `RetrofitClient.kt`). A migration
into `twilio-service/` began 2026-05-16 but stalled after only 4 of the 14
functions moved. That left a deploy footgun (WARNING/assessment §4.3): the tree
WITH the deploy config held only 4 functions, so `twilio-run deploy` from it
would have published 4 functions and 0 assets to the live service, deleting the
10 functions Android depends on.

## What changed 2026-07-16

The migration was completed: the 10 un-migrated functions here
(accept-call, conference-timeout, conference-wait, get-token,
incoming-call-client, play-recording, reject-call, screen-action, screen-ui,
voicemail-choice) were copied verbatim into `twilio-service/functions/`. The 3
overlaps (check-hours, notify-voicemail, screen-notify) already existed there in
newer, behavior-preserving/superset form (check-hours gained a try/catch;
screen-notify made the dialed identity `context.CLIENT_IDENTITY || 'auntie'`),
so those newer versions were kept. `notify-recording` is unique to
`twilio-service/`.

`twilio-service/functions/` is now the complete 14-function superset. Deploying
it is non-destructive.

## Still required before go-live (operator / external)

- **A2P 10DLC** brand + campaign registration (Twilio console, operator identity,
  fee, carrier review). The one true external blocker; no code unblocks it.
- **Record + upload the 6 audio assets** (after_hours_greeting,
  open_hours_greeting, open_hours_retry, gather_intro, try_text_suggestion,
  thank_you_vm) into `twilio-service/assets/` (currently empty).
- **Point the inbound webhooks** at the deployed `twilioInbound` function and set
  its 3 URL env pins (closes WARNING-8); until then inbound writes come from
  spoofable unauthenticated FCM.
- **Give `incomingMessage` a destination** in `studio_flow_v2.json` (repo root) —
  today `next` is null, so a text hitting this voice flow vanishes silently.

Once those land, `twilio-service` deploys the whole service and this directory
can be deleted.
