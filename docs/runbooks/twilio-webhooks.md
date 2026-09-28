# Twilio inbound webhooks

Activating and proving the three inbound Twilio webhooks. `docs/twilio/README.md` covers the integrations as a whole.

Moved out of `docs/RUNBOOK.md` on 2026-09-28 so the runbook holds only the release procedure. The text is the runbook's, with cross-references repointed at the new files.

## Activating the Twilio inbound webhooks

Three deployed functions turn inbound SMS, voicemail and calls into Firestore
records: `twilioInboundSms`, `twilioInboundVoicemail` and `twilioInboundCall`
(`mytribe/functions/src/twilio/twilioInbound.ts`). Deploying them activates
nothing. Until Twilio is pointed at them they receive no traffic, and until the
matching URL is pinned they answer **403**.

`docs/twilio/README.md` is the fuller Twilio picture: both integrations, the
account's known issues, the Studio Flow. This section is the part that costs an
operator an evening.

### The three URL pins are environment variables, NOT secrets

| Env var | Set on | Value |
|---|---|---|
| `TWILIO_INBOUND_SMS_URL` | `twilioinboundsms` | `https://us-central1-auntieos-ttpc.cloudfunctions.net/twilioInboundSms` |
| `TWILIO_INBOUND_VOICEMAIL_URL` | `twilioinboundvoicemail` | `.../twilioInboundVoicemail` |
| `TWILIO_INBOUND_CALL_URL` | `twilioinboundcall` | `.../twilioInboundCall` |

**`firebase functions:secrets:set` on these three names does nothing.** A gcfv2
function is mounted only the secrets its own `secrets:` array declares, and all
three exports declare `['TWILIO_AUTH_TOKEN', 'SENTRY_DSN']` and nothing else
(`twilioInbound.ts:518-540`). The handlers read the URLs straight off
`process.env` (`twilioSignature.ts:27-28`), which a Secret Manager entry never
reaches. A value created there sits in the project looking set, and the function
never sees it. That is the same shape as the `GOOGLE_CALENDAR_ID` failure in
the Secrets section, and worth checking for first if one of these was "already
configured".

Set them as Cloud Run environment variables instead. These are `gcloud`
commands, so the operator runs them:

```bash
gcloud run services update twilioinboundsms --region us-central1 \
  --update-env-vars TWILIO_INBOUND_SMS_URL=https://us-central1-auntieos-ttpc.cloudfunctions.net/twilioInboundSms
gcloud run services update twilioinboundvoicemail --region us-central1 \
  --update-env-vars TWILIO_INBOUND_VOICEMAIL_URL=https://us-central1-auntieos-ttpc.cloudfunctions.net/twilioInboundVoicemail
gcloud run services update twilioinboundcall --region us-central1 \
  --update-env-vars TWILIO_INBOUND_CALL_URL=https://us-central1-auntieos-ttpc.cloudfunctions.net/twilioInboundCall
```

Service names are the lowercased export names. The alternative route is three
lines in `mytribe/functions/.env` followed by a deploy of those three functions;
that file is for non-secret configuration only, and a URL is not a secret.
**Nothing in this repo establishes whether a `gcloud`-set variable survives the
next `firebase deploy` of the same function**, so after any redeploy of these
three, re-read the value before trusting it:

```bash
gcloud run services describe twilioinboundsms --region us-central1 \
  --format='value(spec.template.spec.containers[0].env)'
```

### Why the URL has to match character for character

Twilio's signature is an HMAC over the **exact URL it POSTed to** plus the form
parameters. `twilioVerify` prefers the pinned env value and falls back to
rebuilding the URL from the request when it is unset:

```ts
const url = (process.env[urlEnv] || '').trim() || `https://${req.hostname}${req.originalUrl}`;
```

That fallback is a coin flip. Behind Cloud Functions and its proxies the
observed `req.hostname` and `req.originalUrl` can differ from what Twilio
hashed, and when they do `validateRequest` returns false, the handler answers
**403 `bad-signature`**, and the log line is `twilioInboundSms.verify.fail`,
which reads as a signature or credentials problem and is really a missing
config. A trailing slash, `http` instead of `https`, or the console holding the
`.run.app` form while the env holds the `cloudfunctions.net` form all produce
the identical 403. Both URL forms reach the same service, so either is fine as
long as **the console and the env var hold the identical string**. Use the
`cloudfunctions.net` form, since that is what the rest of these docs quote.

**With `TWILIO_AUTH_TOKEN` unset, all three fail closed with 403** and no
signature is checked at all (`twilioSignature.ts:52`). That is deliberate, so
a forged request can never be accepted before activation, but it means an
unmounted auth token and a mismatched URL look exactly alike from the outside.
Rule the token out first: it is a real declared secret on all three functions,
so `functions:secrets:set` plus a redeploy of those three is the fix for that
one.

### Each surface needs TWO Twilio callbacks, both pointed at the same function

This is the part that is not visible from the Twilio console, and getting it
half right loses data permanently rather than loudly. Settled by PRs #345 and
#347; the field-by-field ownership tables live in the handler comments.

**Calls → `twilioInboundCall`.** Two callbacks land on `calls_log/{CallSid}` and
neither carries what the other does:

- the `<Record>` **recordingStatusCallback** carries `RecordingUrl` and no
  `CallStatus`;
- the **call statusCallback** carries `CallStatus` and, for a `<Record>`-verb
  recording, no `RecordingUrl`. Twilio only puts one there when `record` is set
  on the `<Dial>`.

Wire only the status callback and no call ever gets a recording link, and there
is no second copy of that link anywhere in this system. Wire only the recording
callback and every call's status stays whatever the FCM push guessed. The
handler writes each field only when a callback actually states it, precisely so
the second one to arrive cannot blank the first. Twilio gives no ordering
guarantee between separate requests.

**Voicemail → `twilioInboundVoicemail`.** Same shape on
`voicemails/{RecordingSid}`:

- **transcribeCallback** carries `TranscriptionText`, and `From`/`Caller`, and
  no `RecordingDuration`;
- the `<Record>` **recordingStatusCallback** carries `RecordingDuration` and no
  transcript, no `From` and no `Caller`.

Wire only the transcription callback, the obvious single choice since it is the
one with the words in it, and every voicemail's duration stays 0 forever.
Wire only the recording callback and there is no transcript, no caller number,
and so no kinfolk match either.

In the Studio Flow's "Record Voicemail" widget that means setting **both** the
Transcription Callback URL and the Recording Status Callback URL, both POST,
both to the `twilioInboundVoicemail` URL. Pointing two callbacks at one function
is correct and intended: they write disjoint fields onto one document, keyed by
`RecordingSid`.

### Prove it

Text the number and look for a new `sms_messages` document keyed by the Twilio
`MessageSid`. Leave a voicemail and check `voicemails` has both a `transcript`
and a non-zero `durationSec`. One without the other means one of the two
callbacks is not wired. Complete a call and check `calls_log` has both a
`status` and a `recordingUrl`. A 403 in the function's logs means the URL pin
and the console disagree, or the auth token is not mounted.
