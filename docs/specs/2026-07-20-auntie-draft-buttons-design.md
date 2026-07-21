# Auntie draft buttons at every compose box

Date: 2026-07-20
Status: approved, not yet implemented
Surface: `auntieos-admin` (React). No Compose/Kotlin work in this spec.

## Problem

The Auntie voice generator exists to draft visit reports and KinTales when the
operator does not have the energy to write them. It grew to cover email and SMS
so the persona stays consistent. It has never been a sending tool: output always
needs edits before it goes anywhere.

Today the generator lives on exactly one screen, `CommunicatePersonalize.tsx`,
and that screen offers only Email and Text. So drafting anything else means:
generate in Comms, edit, select all, copy, navigate to the real destination,
paste. The clipboard hop is the problem this spec removes.

The fix inverts the arrangement: instead of the operator travelling to the
generator, the generator appears beside every box the operator already types in.

## Non-goals

- The generator still cannot send. Sending stays where it already is.
- Templates. Explicitly out of scope.
- Internal business notes (kin `officeNotes`, booking `kinfolkNotes`,
  kinfolk `entryNotes`). Out of scope, and their boxes render read-only outside
  `KinEdit.tsx` anyway.
- The daily rate limit stays exactly as it is. See "Rate limit" below.

## Current state, verified

- Generator endpoint: `generateAuntieCopy`, an `onRequest` (not `onCall`) at
  `AuntieOS/web/functions/index.js:775`. Core logic `generate.js`, `runGenerate`
  at `:298`, argument validation `:107-127`.
- Allowed types, `generate.js:25`:
  `sms`, `email`, `visit_report`, `social_post`, `blog_post`, `general`.
  There is no `kintale` value and none should be added: `visit_report` IS the
  KinTale type, and the prompt at `generate.js:55` calls it "Auntie's KinTale
  format".
- React client already exists: `generateDraft()` in
  `auntieos-admin/src/api/communicateGenerate.ts:148`, posting to `/api/generate`
  (rewrite at `auntieos-admin/firebase.json:16-17`).
- `GENERATE_COMMUNICATION_TYPES` at `communicateGenerate.ts:60` lists all six
  types and has zero importers. It is dead until this work uses it.
- `CommunicatePersonalize.tsx:101` passes the send channel straight through as
  `communication_type`, which is why the React admin can only ever reach `sms`
  and `email`.
- Confirmed the generator cannot send: its only write is a best-effort
  `generated_drafts` record at `generate.js:324-337`. Sending is a separate
  endpoint, `sendMessage` at `index.js:680`.

## Call sites

| Surface | File | Type | Recipient |
|---|---|---|---|
| KinTale body | `KinTaleCompose.tsx:407` | `visit_report` | kinfolk |
| KinTale comment | `KinTaleDetail.tsx:419` | `general` | kinfolk |
| Chat reply | `ConversationThread.tsx` | `sms` (see below) | kinfolk |
| SMS / Email | `CommunicatePersonalize.tsx` | `sms` / `email` | kinfolk |
| Broadcast | `CommunicateCompose.tsx:283` | `email` | none |
| Blog / social | later | `blog_post` / `social_post` | none |

Build order: KinTale body first and ship it before wiring the rest. It is the
originating use case and the only one in daily use.

The chat reply is in-app, not SMS: `replyToConversation(kinfolkId, body)` at
`inboxThread.ts:40` carries no channel. `sms` is chosen there purely as the
tone and length profile, since `generate.js:53` defines it as "conversational,
2 to 4 sentences max", which is what a chat reply wants. It is a formatting
choice, not a transport claim. If chat replies later want their own register,
that is a `tone_hint`, not a new communication type.

## Backend change: make `recipient` optional

`generate.js:116` currently rejects any blank recipient unconditionally.

This must become optional, not type-gated. Broadcast is `communication_type:
'email'` yet has no single recipient, so keying the requirement off the type
would reject it. Recipient presence and communication type are orthogonal.

When `recipient` is absent, the prompt writes for a general audience instead of
naming someone.

This one change also fixes a live bug. `CommunicateScreen.kt:151`
(`generateRecipient`) returns `""` for types with `needsRecipient = false`, and
`generate.js:116` rejects it, so **Blog generation from the Kotlin Communicate
screen always 400s today**. The same change unblocks broadcast, blog and social
at once.

Prior art: the Python twin `AuntieOS/generate.py:490` has no `recipient`
parameter at all and derives `kinfolk_name` from resolved records at `:345`.
Recipient-less generation is the older, and more correct, contract.

## Rate limit: unchanged

`generateRateLimit.js` caps 200 calls per admin per UTC day, counted in
`generate_rate_limits/{uid}`, added as NOTE-48 defense-in-depth against a
runaway client loop or a leaked admin token driving unbounded Anthropic spend.
It is self-imposed and has nothing to do with Anthropic's own limits.

An earlier draft of this spec proposed raising or removing it, on the assumption
that buttons on seven surfaces would exhaust 200/day. The operator corrected
that: actual volume is low and concentrated on KinTales, and a runaway loop is
exactly the failure they want bounded. The cap stays at 200. Its tests stay.

## Component design

One hook and one button, so behavior cannot drift between call sites.

`useAuntieDraft({ communicationType, recipient, rawNotes })` returns
`{ generate, regenerate, isGenerating, error }`. It wraps the existing
`generateDraft()`; no new API client.

`<GenerateButton>` renders the control, the in-flight state, and the inline
error.

Contract at every call site, identical:

1. Whatever is in the box becomes `raw_notes`. An empty box disables the button:
   the generator turns shorthand into prose, it does not invent content.
2. The returned draft replaces the box contents. The operator edits in place.
3. Sending is untouched. Each screen keeps the button it already has.
4. Regenerate passes the prior opening as `avoid_opening`, reusing the existing
   `draftOpening()` helper at `communicateGenerate.ts:205`, so a second attempt
   does not repeat the first opener.

## Error handling

Fail loud, per house policy. A failed generate leaves the box exactly as the
operator left it and shows the error inline. It never silently no-ops and never
half-writes. The 429 from the rate limiter surfaces as a plain "daily limit
reached" rather than a generic failure.

## Testing

- Unit: `useAuntieDraft` for the happy path, empty-notes guard, error surfacing,
  and that `regenerate` sends `avoid_opening`.
- Per call site: button disabled on an empty box, draft lands in the right
  field, existing send path still works.
- Backend: `runGenerate` accepts a missing recipient and still rejects missing
  `raw_notes`; a present recipient behaves exactly as before.
- Regression: the Blog 400 case, which is the bug this unblocks.

## Open

Whether the KinTale generate button should also produce a `title`. The Kotlin
composer fills `bodyCopy` only, which is why 89 of 92 reports have no title and
why `aiBackfillTaleTitles.ts` exists. Deferred: the generator returns one plain
string today with no JSON mode, so titles need a second call or a structured
response. Worth deciding before the backfill is run again.
