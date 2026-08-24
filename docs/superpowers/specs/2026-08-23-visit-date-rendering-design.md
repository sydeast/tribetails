# Visit date rendering: one rule across every message that names dates

Date: 2026-08-23
Status: DRAFT, awaiting operator review
Issues: follows #532 and #533; supersedes the `{{bookingDates}}` span shipped in #534

## The problem

#534 gave `kincare.requested` a `{{bookingDates}}` token that renders a whole
booking as a count and a span:

```
4 visits, Sep 4 to Sep 7
```

That is safe only while the date set is contiguous and never changes. The
operator named the case where it is neither: **visits get cancelled or deleted
individually while the booking survives.** The moment Sep 5 is cancelled from a
Sep 4 to Sep 7 booking, the span is not merely vague, it is false. It reports
four visits when three remain and it still implies Sep 5.

It is also wrong for a set that was never contiguous. Four Thursdays across a
month render as `4 visits, Sep 4 to Sep 25`, which is literally true and reads
as a four week block. For the office that is the difference between staffing
four consecutive days and four Thursdays.

Operator ruling, 2026-08-23: **no summarising.** Kinfolk and Aunties both need
to know exactly which days. "Between" was rejected as still ambiguous.

## Scope: this is not one template

The same rule has to hold everywhere a message names more than one visit:

| Moment | Key | Audience |
|---|---|---|
| Request arrives | `kincare.requested` | office |
| Request approved / booking confirmed | `kincare.booking.confirm` | kinfolk (+ office) |
| "Are we still good for these?" | `kincare.upcoming.reminder` | kinfolk |
| Visit assigned or changed | `assignment.assigned`, `assignment.changed` | the Auntie |
| Request declined | `kincare.request.declined` | kinfolk |

Aunties are in scope, not an afterthought: `writeEnvelope` stamps a default
assignee on every visit, so the caregiver receives date-bearing messages too.

## Decisions taken

1. **Never summarise the dates.** Enumerate them.
2. **Every message states the truth at SEND time**, not at dispatch time. A
   stored rendered string, or a `startTimeMsList` captured when the booking was
   made, is stale the moment a visit is cancelled.
3. **Say what changed.** When the set has shrunk since the household was last
   told, the message names the removed dates as well as the surviving ones.
   Operator's words: they will want to know a date was dropped, not be left to
   infer it from a shorter list.
4. **Channel capability, not channel policy.**
   - **Email** carries every date, always. No cap.
   - **SMS** stays ONE segment always. It gives the count and the next date and
     points at the portal. It never prints a partial list that looks complete.
   - **Push** cannot enumerate: the OS truncates the body, so a long list looks
     complete and is not. Push gives the count and the next date and deep-links
     via the `dataRoute` field `pushTemplates/{id}` already supports.
5. **The operator owns the layout, not just the wording.**

## Decision 5 is the one that shapes the code

`{{bookingDates}}` as shipped is a pre-formatted blob. The Template Bank can
move it; it cannot restyle it. Changing bullets to commas would be a code change
and a deploy.

That is avoidable. `pushChannel` / `smsChannel` / the email sender render with
Handlebars over `{ ...data }`, and `stripUnresolvedTokens` runs AFTER
compilation. So if the emitter puts a STRUCTURED ARRAY in `data` rather than a
joined string, the template author gets the loop.

Verified against the real Handlebars version in `mytribe/functions`:

```handlebars
Still good for these?
{{#each visits}}  - {{this.weekday}}, {{this.date}} at {{this.time}}
{{/each}}{{#if removed}}
{{#each removed}}{{this.date}} was cancelled and is not happening.
{{/each}}{{/if}}
```

renders as

```
Still good for these?
  - Thu, Sep 4 at 9:00 AM
  - Sat, Sep 6 at 9:00 AM

Sep 5 was cancelled and is not happening.
```

and with `removed: []` the whole trailing block disappears cleanly.
`stripUnresolvedTokens` does not damage block helpers, because by the time it
runs there are none left.

So the split of responsibility is:

- **Code** supplies correct, live, structured data and enforces the SMS
  one-segment rule.
- **Template Bank** decides how it reads, per template and per channel. The
  Auntie's message and the household's do not have to look alike.

## Data shape

Emitters put this in `enqueueNotification({ data })`:

```ts
{
  visits: Array<{
    dateIso: string;    // '2026-09-04', for sorting and for the portal link
    weekday: string;    // 'Thu'
    date: string;       // 'Sep 4'
    time: string;       // '9:00 AM'
    visitId: string;
  }>,
  visitCount: number,
  nextVisit: { weekday, date, time } | null,   // SMS and push
  removed: Array<{ weekday, date, dateIso }>,  // empty when nothing was dropped
  removedCount: number,
  portalUrl: string,                            // SMS and push land here
}
```

All formatting is done server-side in the business timezone
(`business_settings.timeZone`, falling back to America/New_York), the way
`enrichTemplateData` already does it. Template authors never format a date.

`{{bookingDates}}` stays for one release as a rendered convenience string so
nothing breaks mid-migration, then is removed.

## Where the live set comes from

A shared reader, `loadEnvelopeVisits(kinfolkId, batchId, opts)`:

- reads `families/{kinfolkId}/bookings/{batchId}/kinCares` at CALL time
- excludes `cancelled` and `unavailable` from `visits`
- sorts by `startTime` ascending
- optionally windows to the next N days (the reminder)

Note the deliberate difference from #534: `onBookingEnvelopeCreate` reads ALL
children including already-confirmed ones, because `maybeAutoConfirm` can flip
them before the trigger runs and filtering there would produce an empty list.
That exception is correct for the CREATE moment only. Every later moment wants
cancelled visits excluded. This is written down because the two rules look
contradictory and are not.

## The diff: what "and what changed" needs

Decision 3 needs to know what the household was last told. Proposal: a single
field on the envelope,

```
families/{kinfolkId}/bookings/{batchId}.lastNotifiedVisitIds: string[]
lastNotifiedAtMs: number
```

written in the same operation that dispatches a date-bearing kinfolk
notification. `removed` is then
`lastNotifiedVisitIds` minus the current live set, resolved back to dates.

Consequences to accept:
- The first message after this ships has no prior set, so `removed` is empty.
  Correct: we have not told them anything yet under the new rule.
- Only KINFOLK-facing dispatches update the field. The office and the Auntie
  have their own view of the booking; a reminder to the Auntie must not consume
  the household's diff.
- A removal the household was never told about still surfaces on the next
  message, which is the point.

**Open question for the operator:** should `removed` accumulate across several
messages, or reset once reported? Proposal: reset once reported, so a date is
announced as cancelled exactly once and does not follow them around.

## The reminder needs more than a token change

`scheduled/kincareReminderCron.ts` is PER VISIT today: it scans `kinCares`,
reminds on each visit whose `startTime` falls in a 24 to 48 hour window, and
stamps `upcomingReminderNotifiedAtMs` on that visit. There is no concept of
"these upcoming visits" at all.

To send one reminder naming several upcoming visits it has to become
envelope-grained:

- group the window's due visits by `batchId`
- one dispatch per envelope, listing every visit in the reminder window
- move the notified stamp to the envelope, or keep per-visit stamps and dispatch
  on the first due visit in each envelope

**Open question:** the reminder window. 24 to 48 hours names at most one or two
visits, so "these upcoming visits" barely applies. A 7 day window makes the
plural real. That is an operator call about how far ahead they want to be asked.

## Order of work

1. `loadEnvelopeVisits` + the formatter + the data shape. Tests.
2. Adopt in `kincare.requested` and `kincare.request.declined`. Seeds rewritten
   as `{{#each}}` blocks. This retires the #534 span.
3. `kincare.booking.confirm`, which also needs the envelope-grain fix in #536,
   so do them together.
4. The diff store and `removed`.
5. The reminder cron regrained, once the window is decided.
6. `assignment.*` for the Auntie, once the operator says what she should see.

Steps 1 and 2 are shippable alone and already fix the false span. Steps 4 to 6
each need an operator answer first.

## Not in scope

- The admin queue row in `VisitRequestsSection` (#535) keeps its own short
  `rowWhen`. It is a table cell an operator can click, not a message someone
  receives with no way to ask a follow-up question. Revisit after the messages
  land.
- Retiring `{{bookingDate}}` on single-visit keys. It is correct for a message
  about one visit and there is no reason to touch it.

## Release note that applies to every step

Templates render from Firestore documents, not from the bundled corpus, and a
CHANGED template is skipped by `importSeedTemplates` unless its id is named in
`overwriteIds`. Every step here rewrites seeds, so every step needs the operator
to re-import and to name the changed ids explicitly.
