# Handoff, 2026-07-20 evening

Everything below was verified by driving the live app or querying live Firestore.
Where something is unverified, it says so. Do not treat a green build as proof
of anything: today shipped four page-blanking crashes past a green tsc and 1850
green tests.

## The single most important thing to know

**`auntie.tribetails.com` now serves the REACT app.** It served Compose wasm
until this evening. The wasm build was moved to the `auntieos-admin` *site* so a
wasm deploy can never overwrite the live React app again.

The site names are inverted from the repo names, which is confusing and
deliberate. Read this before deploying anything:

| Repo | Deploys to site | Serves |
|---|---|---|
| `auntieos-admin/` | site `auntieos-ttpc` | **auntie.tribetails.com** (React, LIVE) |
| `AuntieOS/web/` | site `auntieos-admin` | legacy Compose wasm |

## State of the web app

All 19 routes driven programmatically on the OPERATOR account: **zero crashes,
zero permission errors, zero admin-callable rejections.**

Fixed today, each root-caused against live data:

- **Sandbox scoping never reached the query layer.** Every `CollectionSpec` read
  a whole collection with no `kinfolkId` predicate. Now applied CENTRALLY in
  `useCollection`, set from `resolveAccess` (the one place access is decided), so
  a screen cannot forget it. `kinfolk` scopes by document id; `booking_time_slots`
  and `activity_log` are suppressed in test mode (no `kinfolkId` to scope by).
- **Two queries sorted by fields the data lacks.** Firestore silently drops docs
  missing the sort key. `invoices.orderBy(createdAt)` matched 0 of 18 and returned
  nothing FOR EVERY ACCOUNT; `kin_care_sessions.orderBy(createdAt)` matched 23 of
  99 and hid 76 bookings. Backfilled both as real Timestamps. **Check this
  whenever you add a query.**
- **Page scroll.** `#root` was `height:100%` + `overflow:hidden` while `.shell`
  used `min-height` and grew past it, so half of every screen was unreachable.
- **"Date TBD" on every KinTale.** NOT missing data. 83 of 92 reports store
  `"September 3, 2025 2:02pm"`, which `new Date()` rejects because the meridiem
  is lowercase and unspaced. Fixed in the shared `parseFlexibleDate`, which also
  fixed 14 session timestamps in Bookings.
- **Option A** (below).

## Option A: interfaces are casts, not validation

Every `*Entry`/`*Row` in `src/api/` declared fields the documents do not have
(`serviceType` absent on 76 of 99 sessions; `title` on 89 of 92 reports). Those
fields are now optional, so **an unguarded read is a compile error rather than a
white screen**. Done by 12 parallel agents + a verify pass; 45 files.

Rules that were applied and must keep being applied:

- Fix a compile error by defaulting the READ (`?? ''`, `?? []`, or `str`/`arr`
  from `src/lib/coerce`). NEVER by restoring the non-null type, and never with
  `any` or `!`.
- **Never default a number/money field to 0.** That asserts a financial fact the
  document never made.
- Booleans are not in this bug class (no method calls on them).

One agent correctly REFUSED: `NotificationCatalogEntry` is not a cast, it is the
output of `decodeCatalogEntry`. It hardened the decoder instead and found a real
bug there (`?? ''` guards absence but not wrong TYPE, so a numeric `audience`
throws during decode and kills the whole catalog).

## Backend + data changed today

- `redeemCredit` / `getMyInvoices` deployed. **Credits are NOT refundable**: the
  `originalPaymentMethod` target, the Stripe refund leg, its compensating
  rollback and `creditRefundId` are all gone. An old client sending that target
  now fails loudly at validation.
- `invoices.status` backfilled to real statuses (13 paid, 1 open). It previously
  held `"Yes"`/`"No"` on all 14 real invoices. `status` is canonical;
  `invoiceStatus` is read as a fallback and nothing writes it.
- `createdAt` backfilled on 18 invoices and 76 sessions.
- 5 composite indexes added for the now-scoped queries.
- Sentry `AUNTIEOS-ADMIN-1J` closed: root cause was the SEED writing `viewed` as
  a boolean, not the models.

## Android

- `updatedAt` now STAMPS `serverTimestamp()` instead of round-tripping the old
  value. Adding the field stopped the whole-object save destroying it, but `.set()`
  then wrote back what it read, freezing the timestamp.
- APK version derived from git: `versionCode=38`, `versionName=0.2.0.38-b582550`.
  All three prior App Distribution releases shipped as `0.2.0 (2)`.
- **A new APK has NOT been built since these changes.** Next session should.

## Open, in the order I would take them

1. **KinTale as a destination in the Auntie voice generator.** Owner: this was
   the origin of the whole app and it is not wired. Needs the backend's
   `communication_type` handling plus the React picker. VERIFIED SAFE: generate
   only returns copy, it cannot send (grepped `generateAuntieCopy` for twilio /
   sendgrid / messages.create / sms — zero matches).
2. **Build + distribute a new APK** with the `updatedAt` and version fixes.
3. **Parity.** Owner paused DESKTOP parity for both AuntieOS and MyTribe ("A&M"),
   so this is web + mobile only now. Decision on record: React for web,
   Kotlin native for mobile. The real gaps, device-appropriate differences
   EXCLUDED:
   - Web missing: HouseholdData, TrainingDocuments, TemplateBank, KinTaleLogs,
     KinfolkEdit
   - **Backwards:** ServiceManagement, SchedulingOptions, MoodOptions,
     ReviewBooster, ChecklistEditor are phone-only. Business config belongs on a
     big screen.
   - Correctly mobile-only, do NOT "fix": Calls (SIM), LiveTracking (GPS),
     RouteViewer, Messaging.
4. **~100 `.trim()` sites remain** in form-input paths. Not the crash class (they
   read user input, not documents), but Option A can be extended if desired.
5. **Golden screenshots** are recording instead of asserting, so they guard
   nothing. 10 are uncommitted.
6. `_migratedFrom` / `reconcileStatus` exist on kin_care_reports — there is
   migration history nobody has looked at.

## Gotchas that cost time today

- **`auntieos-admin` intermittently 403s on `.git/index.lock`** for minutes.
  Retry, it clears.
- **Claude cannot run `git` write commands outside the session cwd** here, and
  python/shell cannot write into `auntieos-admin/src`. Use the Edit tool, or
  script it and have the operator run `! bash <script>`.
- `secret-guard.sh` blocks any command containing the literal `.env`, including
  `.env.example` paths.
- Counting a field's PRESENCE in Firestore does not tell you it is USABLE. Both
  `visitDate` (92/92 present, 83 unparseable) and `status` (present, garbage
  value) looked fine by presence and were broken in fact.
