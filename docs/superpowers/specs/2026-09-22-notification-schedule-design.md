# The operator picks the hour the daily notification jobs send

Phase 2 of the notification schedule work. Phase 1 (the household send gate, PR #943) shipped the on/off switch with no UI at all. This phase makes the hour adjustable and gives both settings a control on all three admin clients.

Operator, in their words, about the 09:30 overdue job: it "shouldn't be hardcoded and adjustable in the auntieos".

## The constraint that shapes everything below

`onSchedule({ schedule: 'every day 09:30' })` is Cloud Scheduler configuration. It is fixed when the function deploys and there is no runtime API to read it out of Firestore. Making the cron expression itself dynamic would mean a deploy for every change, which is the thing the operator is asking to stop doing.

So "adjustable" has exactly one shape available: the job ticks on a fixed frequent cadence, reads the operator's hour out of settings on every tick, and returns without acting when this is not the hour.

Everything else in this document follows from that.

## The four jobs

| Job | Today | After |
|---|---|---|
| `invoiceRemindersCron` | `every day 09:00`, `America/New_York` | hourly tick, acts at `householdNotificationHour` in the business zone |
| `invoiceOverdueCron` | `every day 09:30`, `America/New_York` | hourly tick, acts at `householdNotificationHour` in the business zone |
| `scheduleDigestCron` | `every day 07:00`, `America/New_York` | hourly tick, acts at `scheduleDigestHour` in the business zone |
| `kincareReminderCron` | `every 60 minutes`, `America/New_York` | stays rolling. Cron expression normalised only. See "Why kincare keeps no hour" |

Every other scheduled job is out of scope: the purges, token rotation, the error digest, the three notification sweeps, `aiBatchPollCron`. They are internal plumbing with no household audience and no hour an operator would have an opinion about.

## The settings

Three fields on `business_settings/business_settings`, the document every business-wide switch already lives on, read through the same modern-id-then-legacy-`singleton` walk `loadBusinessHoursSettings` performs.

| Field | Type | Default when absent | Governs |
|---|---|---|---|
| `householdNotificationsLive` | bool | `false` (Phase 1, unchanged) | whether household copies send at all |
| `householdNotificationHour` | int 0..23 | `9` | `invoiceRemindersCron`, `invoiceOverdueCron` |
| `scheduleDigestHour` | int 0..23 | `7` | `scheduleDigestCron` |

**No new time zone field.** `business_settings.timeZone` already exists and `businessTodayIso` in `lib/quoteDecision.ts` already reads it, falling back to the ruled `America/Chicago` when the stored value is blank or is a name `Intl` cannot parse. A second zone field would let the two disagree, and the first symptom of that is a notice sent an hour off with nothing on screen to explain it.

**The `America/New_York` in the three cron definitions was the bug.** It was never a decision. Operator ruling 2026-08-11 is that the business runs on `America/Chicago`, and the stored `timeZone` had been left at its `America/New_York` default because no code read it. Once the hour is resolved in the business zone, that hardcode has no job left and it goes.

### Why two hour fields and not one, and not four

One field cannot hold two different defaults, so a single hour would silently move one of these jobs on the deploy that introduced it. The two groups also answer to different people.

`invoiceRemindersCron` and `invoiceOverdueCron` write to households. They are the jobs Phase 1's gate holds shut, they are the ones the operator was talking about, and they already ran within half an hour of each other. Nothing about their contents argues for separating them: the two scans read disjoint sets of invoices (due within three days versus due day already past), so running them in the same hour cannot produce two notices about one bill.

`scheduleDigestCron` is the operator's own morning brief of the next day's visits. It goes to `businessAdmins`, no household ever sees it, and Phase 1's gate does not touch it. Folding it in would mean the operator could not move their own brief without also moving every household's.

Four fields would be four controls and three more ways to get it wrong, for a product with one operator. Two is the smallest number that keeps both defaults honest.

### What the half hour costs

`invoiceOverdueCron` runs at 09:30 today and will run on the hour after this. The thirty minutes existed to stagger two jobs that no longer need staggering, and an hourly tick cannot express it. Whole hours are what the operator gets. If they ever ask for 09:30 back, the tick goes to every thirty minutes and the field becomes `HH:mm`; nothing in this design forecloses that.

### What changes on the day this deploys

With the stored zone still `America/New_York` and both new fields absent:

- reminders: 09:00 becomes 09:00. No change.
- overdue: 09:30 becomes 09:00. Thirty minutes earlier.
- digest: 07:00 becomes 07:00. No change.

If the operator then sets the zone to `America/Chicago` per the ruling, all three move an hour later in New York terms, which is the ruling being applied rather than a side effect.

## The tick

### The cron expression

`0 * * * *` with `timeZone: 'Etc/UTC'`, on all four jobs.

Unix cron rather than App Engine interval syntax, because `every 60 minutes` promises a gap of sixty minutes and does not promise the top of the hour. A job that drifts to :47 answers "is it 09:00 yet" at a different point in the hour every day.

UTC rather than the business zone, because a local-zone hourly cron has to decide what to do with the hour that does not exist in spring and the hour that happens twice in autumn, and the answers are "skip" and "run twice". UTC has neither. The business zone is applied inside the handler, where `zonedNow` already handles the conversion and where the tests can drive it.

### What the handler does, in order

```
1. Load business_settings once.            <- the only unconditional read
2. Read failed?        -> log critical, return.        (see "Unreadable settings")
3. Resolve the hour and the business zone from what was read.
4. Local hour < configured hour?  -> return.           (23 ticks out of 24)
5. Read the run marker for this job.
6. marker.lastRunDayIso == today (business day)?  -> return.
7. Run the scan.
8. Write the marker.
```

Step 4 before step 5, and both before step 7, is the point. The expensive work in these jobs is the `paginateQuery` drain of `invoices` or of the `bookings` collection group, and a tick that is not the hour must never reach it. `runDay` currently performs the settings read at the top of each scan; that read moves up into the tick and the scan is handed the day it already resolved, so a matching tick costs no more reads than today's daily run does.

A non-matching tick before the hour costs **one document read**. A non-matching tick after the hour costs **two** (settings, then the marker).

### The catch-up rule and why it is `>=` rather than `==`

The condition is `localHour >= configuredHour` and `not yet run today`, not `localHour == configuredHour`.

Exact match is the obvious design and it is wrong in one direction that matters: a tick that does not happen is a day that does not happen. Cloud Scheduler can miss a fire, a deploy can land on the hour, a cold start can fail. Under exact match the job waits a full day. Under `>=` the next tick picks it up.

It also matches what the operator will actually do. They open the settings screen at 11am, move the hour from 14 to 09, and the reasonable reading of that is "send them now", not "send them tomorrow".

## The double-send guard

This is the part most likely to be got wrong, so it is specified per job and tested per job.

### The marker, which is the common half

A new server-only collection, one document per job:

```
scheduled_runs/{functionName}
  lastRunDayIso : "YYYY-MM-DD"   the BUSINESS day the scan last completed on
  lastRunAtMs   : number
  hour          : number          the configured hour that run matched, for the log
  timeZone      : string          the zone that day was computed in
```

`lastRunDayIso` is the business day from `zonedNow`, never the UTC day. A UTC day would roll over at 18:00 or 19:00 local and let a late-evening hour fire twice.

**The marker is written after the scan, not before.** A crash mid-scan then leaves the day unmarked and the next tick redoes it, which is safe for all three jobs because each one's per-record stamp makes a redo idempotent. Marking first would be safe against double sends and would instead lose a day to any crash.

**Why not on `business_settings`.** Three clients read, diff and merge that document, and Android's `BusinessSettingsDiffTest` reflects over the model and fails on any field missing from the diff map. A field the server writes every day does not belong in a map the clients are required to enumerate. It is also the wrong lifetime: settings are the operator's, this is the runtime's.

The collection is denied to every client in `firestore.rules`, the posture `integrations_config` already has. The Admin SDK inside the functions bypasses rules, so nothing is lost.

### The 11am scenario, both directions

The operator changes the hour at 11:00, having already had a run or not.

| Change | Already ran today? | Ticks 11..23 do | Result |
|---|---|---|---|
| 14 -> 09 | no (14 not reached) | 11:00 matches (11 >= 9), marker absent, scan runs, marker written. 12..23 see the marker and return | **one send** |
| 09 -> 14 | yes, at 09:00 | 14:00 matches, marker says today, returns | **no second send** |
| 09 -> 08 | yes, at 09:00 | every tick matches, marker says today, returns | **no second send** |
| 14 -> 15 | no | 15:00 matches, scan runs | one send, an hour later than yesterday |

The marker alone answers every row. The hour comparison alone answers none of them: exact match still double-fires on row 2, because 09:00 already happened and 14:00 is still to come.

### Per job

**`invoiceRemindersCron`.** `reminderNotifiedAtMs` on the invoice, already there, written only when a reminder really reached the household (#832). Once per invoice, ever. A second scan in one day is reads and no sends. Unchanged by this work.

**`invoiceOverdueCron`.** `overdueNotifiedAtMs`, plus `overdueDedupeKey(invoiceId)` at the dispatcher with a seven day window as the crash net under it (#871). Once per invoice, ever. Unchanged.

`OVERDUE_SUPPRESSED_RETRY_MS` is 20 hours, chosen to sit under the old 24 hour run period so a suppressed invoice gets one retry per day rather than one per run. Under an hourly tick that reasoning still holds, because the marker means the scan still happens at most once per day. The constant's comment says "under one run period" and cites the 24 hour day; it is reworded to say what now makes it true.

**`kincareReminderCron`.** `upcomingReminderNotifiedAtMs`, already there, same three branch shape. Unchanged, and it is unaffected by the marker because it has no hour.

**`scheduleDigestCron` has no guard today, and that is a defect this work has to fix before it can add a second daily tick.** It calls `enqueueNotification` with no `dedupeKey`, so it falls to the dispatcher's derived identity and its five minute default window. Two scans in one day send two digests. Today that cannot happen because Cloud Scheduler fires it once; the moment it ticks hourly it can.

The fix is the pattern already in the file next door: `enqueueNotificationDetailed` with `dedupeKey: scheduleDigestDedupeKey(dayIso)` (`schedule.digest:2026-09-22`) and a 30 hour window. One digest per business day, whoever asks and however many times.

Marker and dedupe key are not redundant. The marker is the cost gate: it stops the scan, which is a full collection group drain. The dedupe key is the crash net: it covers the window between the enqueue landing and the marker write failing, which is the one ordering the marker cannot protect itself against.

## Unreadable settings

Phase 1 fails closed on a read that throws, logs at `critical`, and says in its own header that the trade flips at launch. This phase is consistent with it: **a settings read that throws skips the tick and logs `critical`.**

The reasoning is better here than it was there, which is worth saying rather than leaning on consistency alone. Under a daily cron, "we could not read our settings" cost a whole day of notices. Under an hourly tick it costs one hour, and the next tick retries. Failing closed got cheaper by a factor of 24 in the same change that made it necessary.

It is a behaviour change and not only a new branch. Today `runDay` calls `businessTodayIso`, whose loader swallows its own read error and returns `null`, which resolves to the fallback zone and lets the scan run. So today an unreadable settings document still sends. After this it does not, until the read recovers.

The digest is the uncomfortable case, and it is named rather than glossed: it is operator-facing, Phase 1's gate does not hold it, and failing closed means a Firestore outage costs the operator their own brief. Accepted, for two reasons. An outage long enough to span the digest hour and every hour after it is an incident the operator needs to know about by other means, and the `critical` log is what tells them. And a digest built from a settings read we could not make is a digest we cannot put an honest date on.

The three states are not collapsed, for the same reason Phase 1 does not collapse its four:

| What the document says | Hour used | Logged |
|---|---|---|
| read threw | none, tick skipped | `critical` |
| field absent | the default (9 or 7) | nothing. This is every document in production today |
| field present, integer 0..23 | the stored value | nothing |
| field present, anything else | the default | `warn` |

**The last row is where this deliberately differs from Phase 1.** Phase 1 reads the gate as `=== true` and treats a `'true'` string or a `1` as off, because a value it cannot read as a literal boolean is not evidence the operator opened the product, and the cost of being wrong is a notice to a real household that cannot be recalled.

The costs are reversed for the hour. A hand-edited `"9"` read strictly would mean no hour ever matches and the job goes permanently silent, with nothing on any screen saying so. A stored hour is not a safety interlock; it is a preference with a sane default sitting behind it. So a value we cannot use falls back to the default and logs `warn`, and the job keeps running.

`firestore.rules` gains `bsInt('householdNotificationHour', 0, 23)` and `bsInt('scheduleDigestHour', 0, 23)` in `validBusinessSettings`, and `bsBool('householdNotificationsLive')`, so no client can put a value there that needs this branch. After that, the `warn` row is reachable only by a hand edit in the Firestore console.

## Cost

Three jobs go from 1 invocation a day to 24. `kincareReminderCron` already runs hourly and does not change.

| | Before | After |
|---|---|---|
| Invocations per day | 3 | 72 |
| Invocations per month | ~90 | ~2,160 |
| Firestore reads per month, non-acting ticks | 0 | ~2,000 |
| Cloud Scheduler jobs | 4 | 4 |

The 69 extra invocations a day are sub-second and sit against a free tier of two million a month. The extra reads sit against 50,000 a day. `FULL_CPU_SERIAL` is `{ cpu: 1, maxInstances: 2 }` with no `minInstances`, so nothing is kept warm and an idle hour bills nothing.

The number that would have mattered is the one this design avoids: 24 full drains of the `invoices` collection and the `bookings` collection group per day. Putting the hour check in front of the scan, before any pagination, is what keeps 23 of every 24 ticks at one or two document reads.

## The UI

Parity is mandatory. A setting on one admin client and not another is a defect here, so all three get it in the same change.

### One panel, both settings

A new **Notification schedule** panel carrying three controls:

- **Send household notices** (toggle). `householdNotificationsLive`. This is Phase 1's flag getting its first control anywhere. Until now the operator has had to edit Firestore by hand, which `docs/RUNBOOK.md` walks them through.
- **Send household notices at** (hour picker, 24 entries). `householdNotificationHour`.
- **Send the daily schedule digest at** (hour picker, 24 entries). `scheduleDigestHour`.

A picker, never a text box. There are 24 legal values and the operator should not be able to type a 25th.

The hours are labelled in the business zone the settings document already carries, so the panel names it rather than leaving the operator to guess which clock they are setting: "Times are in {timeZone}", reading the same field the server reads. No second zone control; the existing one lives on Business profile.

The household toggle sits above the two hours because it outranks them. When it is off, the two invoice jobs still run and still send nothing, and the panel says so in one line rather than leaving the hour looking broken.

The panel says which jobs the hour governs, because the honest answer is not "all notifications". Visit reminders are sent relative to the visit, not at a wall clock hour, and a panel implying otherwise would be the "persists but changes nothing" defect one step along.

### Where it goes

| Client | Location |
|---|---|
| Admin web, `auntieos-admin/src` | Settings, Notifications section, above the existing per-key override editor |
| Admin Android, `auntieos-admin/android` | the notification settings screen, same position |
| Admin desktop, `auntieos-admin/web/composeApp` | the settings screen, same position |

The Notifications section is where an operator looks for this. On web that section currently returns `<NotificationGate />` bare, outside the `AsyncRegion` the settings-backed sections use, because it loads its own data; the new panel is settings-backed, so that branch gains the wrap the other sections already have.

### Saving

Every client already writes `business_settings` as a partial merge, and all three keep doing exactly that.

- **Web**: one `Save` for the panel, sending only its own three fields through the shared `persist`, the `BookingRulesSection` shape.
- **Android**: the three fields are added to `BUSINESS_SETTINGS_DIFF_FIELDS`. Without that entry the field would simply never save, which `BusinessSettingsDiffTest` exists to catch.
- **Desktop**: `saveBusinessSettings` writes the whole model under merge, so the panel must `copy()` the loaded settings and change three fields. Building a `BusinessSettings(...)` from form state is the rebuild trap this repo has been bitten by: every field with no control on screen goes back to its default and the save reverts it.

Each client's model gains the three fields with the defaults in the table at the top, so a document missing them reads the same answer the server reads.

## What this makes stale

Comments that will be wrong the moment this lands, and are corrected in the same change:

- `invoiceRemindersCron`, "Runs daily 09:00 ET", and `invoiceOverdueCron`, "Runs daily 09:30 ET".
- `scheduleDigestCron`, "Runs daily 07:00 ET".
- `OVERDUE_SUPPRESSED_RETRY_MS`, "DELIBERATELY SHORTER THAN THE 24-HOUR RUN PERIOD".
- `householdSendGate.ts`, "the next `invoiceOverdueCron` run at 09:30".
- `docs/RUNBOOK.md`, which tells the operator to set `householdNotificationsLive` from the Firestore console. The console path stays as the fallback, under the UI that replaces it.

## Why kincare keeps no hour

`kincareReminderCron` is listed in scope and comes out of it unchanged apart from its cron expression. The reasoning belongs here rather than in a commit message.

It has no hardcoded hour to make adjustable. It reminds relative to the visit, sweeping a rolling 24 to 48 hour window every hour, and it already reads its own switch (`enableAutoReminder24h`, #519) before it does anything expensive.

Pinning it to an hour would be a regression, twice over:

- Its window is exactly 24 hours wide, so daily scans tile it with no gap only while every day is 24 hours long. On the short day in spring, one hour of visits falls between two scans and is never reminded about. Hourly sweeping has no such edge.
- Today a booking that enters the window gets up to 24 attempts, which is what makes the "nothing was delivered, stamp nothing" branch work: a household that turns email on, or an operator who opens Phase 1's gate, is caught within the hour. Pinned to an hour, that branch gets one attempt a day.

It would also change the lead time from about 48 hours to 24 to 48, which is arguably closer to what its own label promises. That is a product change the operator did not ask for, so it is not made here.

Its schedule string is normalised from `every 60 minutes`, `America/New_York` to `0 * * * *`, `Etc/UTC`, for the alignment and DST reasons in "The cron expression". Nothing else about it moves.

## Out of scope

- Per job hours. Two groups, argued above.
- Minute granularity. Whole hours, argued above.
- A day-of-week schedule. Nobody asked, and `businessHours` and `companyHolidays` already exist for the question it would half answer.
- Making `kincareReminderCron` hour-driven, argued above.
- Flipping Phase 1's fail-closed trade. That is a launch decision and Phase 1 says so in its own header.
