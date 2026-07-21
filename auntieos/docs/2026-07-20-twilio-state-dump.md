# Twilio account state dump, 2026-07-20

Every fact below was read from the live account on 2026-07-20 with the
credentials in GCP Secret Manager (`TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN`,
project `auntieos-ttpc`). Nothing here is inferred from an older doc. Where this
contradicts `HANDOFF_2026-07-20.md`, this file wins and the handoff has been
corrected.

Account: `ACebdf660ad2bfc42ba39891047c06166f`, "TribeTails", active, Full type.
One account, zero subaccounts. Balance $17.43 USD.

## The headline: the configured sender is the business's carrier number

`TWILIO_FROM_NUMBER` (secret, latest version) = **+17373432928**.

Per the operator, that is **Tribe Tails' actual published business phone number,
and it lives with a regular phone-plan carrier, not with Twilio.** So it is not a
misconfiguration in the sense of a typo. Someone pointed the sender at the number
clients actually know, which is the right product instinct and the wrong
mechanism.

Twilio's view of it: `IncomingPhoneNumbers?PhoneNumber=%2B17373432928` returns
zero matches, and there are no subaccounts it could be hiding in. The account
holds it only as its single **Verified Caller ID**, friendly name "Tribe Tails
Pet Care". A verified caller ID lets you display that number on outbound *voice*.
It grants nothing for SMS.

So every SMS send since it was configured fails with **21659** ("'From' is not a
Twilio phone number"). Distinct from the A2P problem and hit earlier in the send
path. The handoff said the last sends failed 30034, true of the April batch but
not of the most recent traffic.

Because clients text this number today, every one of those inbound texts lands at
the carrier and is invisible to AuntieOS. That is a direct hit on the comms spine
design, which is inbound-first. Sender strategy for this number is therefore a
product decision, not a config fix. Options under research: Twilio Hosted SMS
(SMS capability moves to Twilio, voice stays on the carrier plan), a full port,
or sending from +18054636550 and leaving the business number voice-only.

Failure history, all 18 messages the account has ever sent:

| Date range | From | Error | Meaning |
|---|---|---|---|
| Mar 19 to Apr 20 | +18054636550 (owned) | 30034 x7, 30032 x2 | 10DLC unregistered; toll-free unverified |
| May 2 to May 5 | +17373432928 (not owned) | 21659 x6, 21211 x2 | invalid From; invalid To (test numbers `+1555555xxxx`) |

One message has been delivered in the account's entire history. Seventeen
failed or went undelivered.

## What the account actually owns

| Number | SMS | MMS | Voice | sms_url | voice_url |
|---|---|---|---|---|---|
| +18054636550 | yes | yes | yes | `demo.twilio.com/welcome/sms/reply` | Studio Flow `FW9b2aa5e0…` |
| <TWILIO_PERSONAL_NUMBER> | yes | yes | yes | `demo.twilio.com/welcome/sms/reply` | Studio Flow `FW2b7fdbf0…` |

Both numbers are SMS-capable and both still point their inbound SMS webhook at
Twilio's demo endpoint. Neither is attached to a Messaging Service
(`messaging_service_sid` is null on both). `twilioInbound`, the
signature-verified inbound handler in MyTribe, has therefore never been invoked
once. Consistent with that: all 18 messages in the account are `outbound-api`.
Zero inbound, ever.

The personal number is `TWILIO_PERSONAL_NUMBER` and is excluded from product use by
standing policy. It also cannot become a WhatsApp sender, because it is already
on personal WhatsApp.

## A2P 10DLC status: not started

- Brand registrations: **0**.
- Campaigns on "Kinfolk Keeper" (`MGffb24f5287d511790db7fcb237820455`):
  `Compliance/Usa2p` returns an empty list.
- Phone numbers in that service's sender pool: **0**.
- Second service `MG17baef4f489ed88361666eb1b438b551` is
  "Default Messaging Service for Conversations", not ours.

The real head start is TrustHub. Two customer profiles exist and both are
already `twilio-approved`:

- `BUabcdcba22c4178d8256ae94dc3acd514` "TribeTails", policy `RN6433641899…`
- `BUd494947cf0a9725c8bbccd3f4321eb82` "Tribe Tails Pet Care", policy `RN13dc4be886…`

Brand registration can be built on one of those rather than started cold.

## Voice

84 calls all-time, 91 minutes, $0.78. All 8 most recent are **inbound** and
completed, routed by Studio Flow. Voice works, in the sense that people call the
business and the Flow answers.

Outbound and in-app calling do not work. Zero TwiML Applications exist on the
account, and the token endpoint the Android Voice SDK needs is dead:

```
https://tribetailsattendant-8587.twil.io/get-token     404
https://tribetailsattendant-8587.twil.io/screen-ui     200
https://tribetailsattendant-8587.twil.io/screen-action 403
```

`VoiceTokenManager.fetchToken` (:57) consequently always returns null and the
SDK never registers, so the Android app cannot place or answer calls.

## Code that has to change

`getTwilioFromNumber()` lives at `MyTribe/functions/src/lib/twilio.ts:52-56` and
is a bare `process.env.TWILIO_FROM_NUMBER` read. Three call sites pass its result
as `from:`:

- `src/notifications/senders/smsChannel.ts:48`
- `src/admin/sendExternalMessage.ts:181`
- `src/admin/broadcastMessage.ts:240`

All three should send `messagingServiceSid` instead of `from`, which fixes 21659
and 30034 at once: the service picks a registered sender from its pool, and there
is no env var holding a number that may not be ours.

## Recommended path, still unapproved by the operator

Step 1, plumbing and A2P. No new product surface, unblocks real data.

1. Decide the sender for +17373432928: host its SMS at Twilio, port it, or leave
   it voice-only and send from +18054636550. This is now the gating decision and
   it belongs to the operator. See the sender-strategy memo.
2. Add whichever number wins to the "Kinfolk Keeper" sender pool.
3. Register brand plus campaign against the approved
   `BUd494947cf0a9725c8bbccd3f4321eb82` TrustHub profile.
4. Switch the three call sites to `messagingServiceSid`.
5. Repoint both `sms_url`s off demo.twilio.com onto `twilioInbound`.

Step 5 needs no A2P approval and is what makes inbound messages start arriving,
which is why comms spine slice 1 was scoped to it.

Step 2, WhatsApp on Programmable Messaging, not a Conversations rewrite. Start
Meta business verification now and run it in parallel with everything else: it
takes weeks and it is the long pole on the whole comms program. Do not use
<TWILIO_PERSONAL_NUMBER>. US Marketing-category templates are undeliverable (63049), so
broadcast traffic stays on SMS and email permanently.

## Verification commands

Read-only, safe to re-run:

```sh
SID=$(gcloud secrets versions access latest --secret=TWILIO_ACCOUNT_SID --project=auntieos-ttpc)
TOK=$(gcloud secrets versions access latest --secret=TWILIO_AUTH_TOKEN --project=auntieos-ttpc)
curl -s -u "$SID:$TOK" "https://api.twilio.com/2010-04-01/Accounts/$SID/IncomingPhoneNumbers.json"
curl -s -u "$SID:$TOK" "https://messaging.twilio.com/v1/a2p/BrandRegistrations"
curl -s -u "$SID:$TOK" "https://trusthub.twilio.com/v1/CustomerProfiles"
curl -s -u "$SID:$TOK" "https://messaging.twilio.com/v1/Services/MGffb24f5287d511790db7fcb237820455/Compliance/Usa2p"
curl -s -u "$SID:$TOK" "https://api.twilio.com/2010-04-01/Accounts/$SID/Messages.json?PageSize=100"
```

Error code meanings were confirmed against twilio.com/docs/api/errors, not
recalled: 21659 From is not a Twilio number, 21211 invalid To, 30032 toll-free
not verified, 30034 10DLC unregistered.
