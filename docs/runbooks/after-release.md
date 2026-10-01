# After a release: details

The full procedure for each template import, backfill, repair and report the release checklist in `docs/RUNBOOK.md` names. Each row there says which section here to open.

Moved out of `docs/RUNBOOK.md` on 2026-09-28 so the runbook holds only the release procedure. The text is the runbook's, with cross-references repointed at the new files.

### Templates to import after a release

Some merges add a notification template that the release cannot load for you.
The seed files ship inside the functions deploy, and templates reach Firestore
only through the importer (operator ruling, issue #468). So each row below is an
operator step after the first release that contains it.

Until a template is imported, its notification still goes out on the generic
fallback (`mytribe/functions/src/notifications/fallbackTemplate.ts`): email and
push carry content-free copy pointing at AuntieOS, and **SMS is skipped**
(operator ruling 2026-08-23, a segment costs money).

| Template | Added by | What is missing until it is imported |
|---|---|---|
| `security.account.locked.operator` | #869 | The operator's lockout alert names neither the household nor the account email, and sends no SMS. |
| `security.failedLogin.attempts.operator` | #877 | The operator's 5-failure warning does not name the household, the account email or the attempt count, and sends no SMS. |
| `security.failedLogin.budgetExhausted.operator` | #891 | The alert that an account's failed sign-ins stopped counting for 24 hours names neither the household nor the account email, and sends no SMS. |
| `security.account.locked.spike.operator` | #891 | The alert that 3 or more accounts locked within 30 minutes does not give the count or the window, and sends no SMS. |
| `security.breach_attempt.staff` | #892 | When a staff account uses "I did not ask for this reset", the alert does not name the staff account, the IP or the incident record. |
| `invoice.payment.unapplied` | #1003, wording #1022 | The alert that a card payment arrived for an invoice already paid, and is held for your decision, does not name the amount, the invoice or the reason. |

To import, follow the list below:
Admin, then **Templates**, then **Import from repo** on web or the **Import** tab
on Android, then read the plan before pressing **Import**. A template new to
Firestore shows `create` on every channel and needs nothing ticked. Do not tick
**Replace the stored copy with the repo wording** on an unrelated `skipped` row to
get it in.

The import, on the web admin or the phone:
1. Admin, then **Templates**.
2. **Import from repo** on web, or the **Import** tab on Android.
3. Read the plan. It writes nothing yet. `invoice.payment.disputed` (and
   `invoice.payment.unapplied`, added for docket Q5) shows one
   line per channel: `create` where Firestore has no copy, `unchanged` where the
   stored copy already matches, `skipped` where it differs.
4. A `skipped` line means the stored copy differs from the repo: somebody edited
   that template here, or it predates #953 (see below). Tick **Replace the
   stored copy with the repo wording** only if you mean to lose that edit.
5. Press **Import**. The button names how many documents it will write.
A template that is refused (a Handlebars triple stash, an unparseable seed file)
is named with the reason, and nothing for it is written, including its other two
channels.

**The first release after #953 is different.** #953 converted every seed to
the visual email format, so every template already in Firestore differs from
the repo and shows `skipped`, whether or not anyone edited it. For a template
nobody edited, tick **Replace the stored copy with the repo wording**. For one
that was edited, leave it unticked, open it in the Template Bank, where it
shows **Old format**, and press **Convert**. Convert shows both versions
before it saves anything.

#### What the failed-login lock does and does not see (#891)

The lock counts only failures our own sign-in clients report to
`recordFailedLogin`. A script that calls Firebase Auth directly never reports,
so it never warns or locks anyone here; against that, the only protection is
Firebase Auth's own throttling (`TOO_MANY_ATTEMPTS_TRY_LATER`). The reports
themselves are limited to 30 per client IP per 5 minutes (the IP Google
appended, not one the caller wrote) and 15 per email per 24 hours. When a real
account uses its 15, you get `security.failedLogin.budgetExhausted.operator`,
because for the next 24 hours nothing warns or locks that account. When 3 or
more accounts lock within 30 minutes, you get `security.account.locked.spike.operator`
on top of each lock's own alert. A locked account can still request up to 10
resets per lock from portal Android and portal desktop.

#### Confirm the IP key after the release (#891, #908, #910)

Each callable answers on two URLs, and both must key on your real address. You
run these; they call production.

Steps 2 and 3 cover `recordFailedLogin` and `requestPasswordReset`. Step 5 adds
`requestPrimaryRecovery`, which #910 moved onto the same key.

1. Get the `run.app` URL of each callable:

   ```bash
   gcloud run services describe recordfailedlogin --region us-central1 --project auntieos-ttpc --format 'value(status.url)'
   gcloud run services describe requestpasswordreset --region us-central1 --project auntieos-ttpc --format 'value(status.url)'
   ```

   If `run services describe` finds nothing, the same URL is in
   `gcloud functions describe recordFailedLogin --gen2 --region us-central1 --project auntieos-ttpc --format 'value(serviceConfig.uri)'`.

2. Send one forged report to each URL of `recordFailedLogin`. The address is not
   an account, so nobody is warned or locked:

   ```bash
   curl -s -X POST 'https://us-central1-auntieos-ttpc.cloudfunctions.net/recordFailedLogin' -H 'Content-Type: application/json' -H 'X-Forwarded-For: 1.2.3.4' -d '{"data":{"email":"ip-probe-891@example.com"}}'
   curl -s -X POST '<recordfailedlogin run.app URL>' -H 'Content-Type: application/json' -H 'X-Forwarded-For: 1.2.3.4' -d '{"data":{"email":"ip-probe-891@example.com"}}'
   ```

   Both answer `{"result":{"ok":true}}`. In the Activity Log, the two newest
   `AUTH_LOGIN_FAIL` rows must each show your real address as `ip`.

3. Send one forged reset to each URL of `requestPasswordReset`, using a test
   kinfolk account you own (an audit row is written only for a real account).
   Each sends that account a reset email and uses one of its 3 resets for the day:

   ```bash
   curl -s -X POST 'https://us-central1-auntieos-ttpc.cloudfunctions.net/requestPasswordReset' -H 'Content-Type: application/json' -H 'X-Forwarded-For: 1.2.3.4' -d '{"data":{"email":"<test kinfolk email>"}}'
   curl -s -X POST '<requestpasswordreset run.app URL>' -H 'Content-Type: application/json' -H 'X-Forwarded-For: 1.2.3.4' -d '{"data":{"email":"<test kinfolk email>"}}'
   ```

   The two newest `AUTH_PASSWORD_RESET_REQUESTED` rows must show your real address.

4. In Logs Explorer, filter on `jsonPayload.event="clientIp.untrustedRightmost"`
   and on `jsonPayload.event="clientIp.noForwardedFor"` for the last hour. Both
   should be empty.

5. #910: send one forged recovery request naming a household you own. It files a
   real `recoveryRequests` row for you to review and close, emails
   `AUNTIE_NOTIFY_EMAIL`, and uses one of that household's 3 requests per address
   per hour:

   ```bash
   curl -s -X POST 'https://us-central1-auntieos-ttpc.cloudfunctions.net/requestPrimaryRecovery' -H 'Content-Type: application/json' -H 'X-Forwarded-For: 1.2.3.4' -d '{"data":{"familyId":"<your test tribe id>","contactMethod":"email","newContact":"ip-probe-910@example.com"}}'
   ```

   It answers `{"result":{"ok":true}}`, and the newest
   `AUTH_RECOVERY_REQUESTED` row must show your real address as `ip`.

   `getInvitePreview` and `claimInviteSignup` key the same way but write no audit
   row, so they are confirmed by step 4 being empty rather than by a row.

What a failure means:

- A row shows `1.2.3.4`: that URL adds no entry of its own, so the function keys
  on what the caller wrote. Stop and report it.
- A `clientIp.untrustedRightmost` error, or rows showing `untrusted` as `ip`: that
  URL adds more entries than one. Its `rangeClass` says what sat in the rightmost
  place (`googleFrontEnd`, `private` and so on). The function refuses to guess
  further left, so every caller on that URL shares one 30-per-5-minute bucket
  until `TRUSTED_PROXY_HOPS` in `loginSecurity.ts` is fixed in the next release.
  Report it.
- Every row shows the same Google address: the hop count is wrong in a way the
  ranges did not catch. Report it.

#### Rate-limit ledgers expire by TTL (#908)

`ipRateLimits`, `failedLoginEmailRateLimits`, `unknownLoginAttempts` and
`passwordResetEmailRateLimits` now carry `expiresAt` (their longest window plus
one hour), with TTL policies declared in `mytribe/firestore.indexes.json` next
to `notificationDedupe.expiresAt`. That file changed, so the release's index
step (step 3) asks before deploying it: a detached `deploy:bg` run refuses and
tells you to run the release in the foreground. After it deploys, the Firebase
console under Firestore, then TTL, lists the five policies; a new policy can take
a while to show as serving. Documents written before this release have no
`expiresAt` and stay until their next write. No backfill: they are a few hundred
bytes each, nothing lists these collections, and every new write carries the
field.

### Backfills to run after a release

Some merges change which key a stored setting belongs to. Run each row once,
after the first release that contains it and after that release's template
import above. Every backfill here is a dry run by default, and **before any
write, run `npm run test:scripts:emulator` and read the pass count.**

| Backfill | Added by | What it fixes |
|---|---|---|
| `backfill:operator-warning-override` | #877 | An operator who turned off or locked the failed-login warning, or one of its channels, on the Business tab saved that on `auth.failedLogin.attempts`. That key is household-only now, so the setting stopped applying to operators. This copies it to `security.failedLogin.attempts.operator`, only where that key has no setting yet. |
| `backfill:emergency-contacts` | #829 | Copies the flat `emergencyContact*` fields, and for a household with none the old `families` customFields copy, into `emergencyContacts[0]` - the array the callable and every client now read. |
| `backfill:invoice-amount-due` | #902 | Migrated invoices carry a `total` and no `amountDue` at all. Every reader derives the balance now (one rule, `functions/src/lib/amountDueRule.ts`), so nothing is broken without this; the backfill writes the figure down so a stored balance is what the ledger sums and what a query can filter on. It writes `amountDue`, `amountDueCents` and the ADR-0002 state stamp, and **nothing else: no `updatedAt` and no server timestamp, so these records keep the original system's dates**. It refuses any invoice whose write would tell a household about a payment made long ago, and lists those for you. |

For `backfill:operator-warning-override`:

1. `npm run test:scripts:emulator`
2. `npm --prefix mytribe/functions run backfill:operator-warning-override`
   Reads only. The first line is the project and the second the target: check
   they name the right project and `PRODUCTION`. Then read the old value and
   the planned `WRITE` line.
3. `npm --prefix mytribe/functions run backfill:operator-warning-override -- --allow-prod`
   Needs `GOOGLE_APPLICATION_CREDENTIALS`. It takes the project from `--project <id>`
   or from `project_id` in that credentials file and refuses to guess, and it
   refuses to run while `FIRESTORE_EMULATOR_HOST` is set.
4. Re-run step 2. It reports `target-exists`, or the same no-op as before.

For `backfill:invoice-amount-due`:

1. `npm run test:scripts:emulator`, and read the pass count.
2. `npm --prefix mytribe/functions run report:legacy-amount-due -- --project <id> --allow-prod`
   The read-only count first, so you know the size of what follows. The first
   line is the target: check it names the right project and `PRODUCTION`. Read
   the per-status counts, and the `overdrawn` line in particular.
3. `npm --prefix mytribe/functions run backfill:invoice-amount-due -- --project <id>`
   DRY RUN, the default. One `[write]` line per invoice, naming the status it
   will stamp and the balance it will write. Nothing is written.
4. `npm --prefix mytribe/functions run backfill:invoice-amount-due -- --project <id> --allow-prod`
   Needs `GOOGLE_APPLICATION_CREDENTIALS`. `--dry-run` beats `--allow-prod` in
   either order, so a run you are unsure about can always be made safe by adding it.
5. Re-run step 3. It plans zero: a document that states a balance is out of scope,
   which is what makes this idempotent.
6. Act on the `NEEDS OPERATOR` list by hand, if there is one. Those are bills whose
   payment rows already cover them: writing the zero balance would have sent the
   household an `invoice.payment.applied` about a payment made months ago, so the
   script left them alone. Settle each through `markInvoicePaid` or
   `repairInvoicePayments`, where the notice is a decision rather than a side effect.
   Where the rows EXCEED the total, there are no refunds: put the difference on the
   household's account balance. The backfill never writes a negative balance, so it
   has minted no credit for you to undo.

The script never overwrites a setting the new key already has. It copies the
whole business-stream setting, locks and lock reason included, because a
locked channel delivers differently from an unlocked one.

For `backfill:emergency-contacts`:

1. `npm run test:scripts:emulator`
2. Rehearse the real write against a local emulator first (`--emulator-apply`,
   #893), never production: from `mytribe/`, `firebase emulators:start --only
   firestore --project mytribe-scripts-emulator-test`, then in a second
   terminal, with `FIRESTORE_EMULATOR_HOST` set to the address it printed
   (`127.0.0.1:8080` by default, from `mytribe/firebase.json`):
   `FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 npm --prefix mytribe/functions run backfill:emergency-contacts -- --emulator-apply`
   Refuses without `FIRESTORE_EMULATOR_HOST` set, and refuses alongside
   `--allow-prod`. Read the printed counts and the per-household diff.
3. `npm --prefix mytribe/functions run backfill:emergency-contacts`
   Dry run against PRODUCTION (no `FIRESTORE_EMULATOR_HOST` this time). The
   first two lines are the project and the target: check they say the right
   project and `PRODUCTION`. Read the diff for every household and every
   stale `families` row before applying.
4. `npm --prefix mytribe/functions run backfill:emergency-contacts -- --allow-prod`
   Needs `GOOGLE_APPLICATION_CREDENTIALS` and refuses while
   `FIRESTORE_EMULATOR_HOST` is set.
5. Re-run step 3. Every plan should now report `skip` (`already-has-array` or
   `no-flat-fields`) - nothing left to migrate.

Never overwrites a non-empty `emergencyContacts` array, never bumps
`updatedAt`, and never deletes the kinfolk flat fields (they stay readable
until this run is verified). Dates on the migrated contact are the original
record's, never the migration time.

### Repairs to run after a release

A repair rewrites data a shipped defect already wrote. The code fix stops new bad
data; it does nothing for what is stored, because Firestore keeps what it was
given. Every repair here is a dry run by default, and **before any write, run
`npm run test:scripts:emulator` and read the pass count.**

| Repair | Added by | What it fixes |
|---|---|---|
| `repair:duplicate-vet-clinic-id` | #901 | Before #873 (PR #900), portal web appended a second `vetClinicId` row to `families/{id}.customFields` on every no-schema save, so a household's list grew by one row per press of Save Changes. #900 stops new duplicates but only folds a key a client actually sends, so stored ones stay. This keeps the NEWEST copy (the last in the array, which is the one portal web already displays) at the oldest copy's position, drops the rest, and leaves every other row and every timestamp alone. |

For `repair:duplicate-vet-clinic-id`:

1. `npm run test:scripts:emulator`
2. `npm --prefix mytribe/functions run repair:duplicate-vet-clinic-id -- --project <id> --allow-prod`
   Reads only. The first line printed is the target: check it names the right
   project, `PRODUCTION` and `DRY RUN (writes nothing)`. Then read the counts and
   the per-household lines. `Households whose copies disagree` is the number
   where the older copies name a different clinic from the newest, so the repair
   changes what the office would read off the record, not just the row count.
3. `npm --prefix mytribe/functions run repair:duplicate-vet-clinic-id -- --project <id> --allow-prod --apply`
   Needs `GOOGLE_APPLICATION_CREDENTIALS`. `--allow-prod` says WHERE and
   `--apply` says WHETHER TO WRITE; `--allow-prod` is refused while
   `FIRESTORE_EMULATOR_HOST` is set, and without it nothing reaches production.
   `--dry-run` forces the dry run back and wins in either flag order.
4. Re-run step 2. It reports zero households: the repair is idempotent.

`updatedAt` is not bumped and no repair stamp is written, so a repaired household
keeps the times it already had.

### Deleting the fake-address test records (#1082)

Operator ruling 2026-09-30. Test records with invented addresses
(`@tribetails.test` and the like) make every send to them bounce, and the
bounces hurt the sender rating. `purge:fake-records` finds every Auth user and
contact record whose address is on a reserved domain (`.test`, `.example`,
`.invalid`, `.localhost`, `.local`, `example.com`, `example.net`, `example.org`),
plus the records tied to those households and accounts, and deletes them only
when asked. It finds them by address, not from a list of ids.

It never touches `e2e-admin@tribetails.com`, `catch@hanasamku.com`,
`pawsome@hanasamku.com` or any `@tribetails.com` address. If anything it would
delete carries one of those, or any address that is not on a reserved domain,
the delete run stops before the first delete and names the record, the field and
the domain.

1. `npm run test:scripts:emulator` (from `mytribe/functions`) and read the pass count.
2. Read only:

   ```
   npm --prefix mytribe/functions run purge:fake-records -- --project auntieos-ttpc --allow-prod
   ```

   Writes nothing. The first line is the target: check it says `PRODUCTION`,
   `auntieos-ttpc` and `READ ONLY (writes nothing)`. The next line is the
   household send gate (`householdNotificationsLive`), ON or OFF in plain words.
   The line after it names the deployed `onClientsWrite`, read from the commit
   in `.release-state`. Until a release containing #1085 has shipped it says
   the trigger "predates #1085", and the run refuses any fake client whose
   household is linked to another account (`TRIGGER:` lines), because that
   trigger would wipe the real link. Release first, then run step 2 again.
   Then the fake households, every Auth user and every document it would delete
   with counts per collection, the real `clients` records that name a fake
   household (left alone), and any `WOULD REFUSE` lines. The last line is
   `Plan fingerprint: <12 characters>`. Paste the whole output into the docket
   before step 3.
3. Delete, with the fingerprint from step 2 in place of `<fingerprint>`:

   ```
   npm --prefix mytribe/functions run purge:fake-records -- --project auntieos-ttpc --allow-prod --apply --confirm <fingerprint>
   ```

   Scans again and prints the same list. If anything changed since step 2, the
   fingerprint no longer matches and it stops before the first delete; go back
   to step 2. Otherwise it deletes exactly that list, Auth users last. Each
   deletion prints a `DELETED` line and writes one `activity_log` row
   (`PURGE_FAKE_RECORD`, actor `system:purgeFakeRecords`). It then waits 10
   seconds (`--settle-seconds` changes it) and deletes again any listed record
   a trigger brought back: deleting a `clients` record makes `onClientsWrite`
   write `uid: ''` onto its household, which can recreate a household it just
   deleted.
4. Re-run step 2. It lists nothing. A trigger that lands after the settle wait
   can still leave a `kinfolk/<id>` holding only `uid: ''` and no address, which
   step 2 cannot find. Open each household id step 2 listed in the Firebase
   console and delete any such stub by hand.

`--allow-prod` says WHERE and `--apply` says WHETHER TO DELETE. Without
`--apply` nothing is written, `--dry-run` forces the read-only run in either flag
order, and `--allow-prod` is refused while either emulator host is set. Needs
credentials that can read and delete in Firestore and Firebase Auth.

### Read-only reports to run after a release

These write nothing. Run each once after the first release that contains it and
read the counts. A non-zero count is a list of documents to look at, not
something to fix from the terminal.

| Report | Added by | What it answers |
|---|---|---|
| `report:duplicate-kinfolk` | #890 | Whether Add Kinfolk already made two households for one family: households with the same primary phone or email created close together, by `createdAt`, or by the document's create time for households made before `createdAt` was stamped. |
| `report:duplicate-notifications` | #832, #866 | Whether a household was already sent the same notification twice, or two payment confirmations about one invoice within 10 minutes. |
| `report:legacy-amount-due` | #902 | How many invoices carry a `total` and no `amountDue` at all, grouped by their stored `status` spelling, with what the shared rule says each group owes and how many hold payment rows or are overdrawn. **Run this one BEFORE the release that ships #902, not after.** Those invoices used to classify `paid` and were never chased; they classify `open` from the moment that release deploys, so the overdue and reminder crons become free to chase every one of them with a due date in range. The count is the size of that batch, and it may be zero. Run it again before `backfill:invoice-amount-due`. Prints ids, status spellings and counts only, never an amount. |
| `report:truncated-custom-fields` | #873 | Which households already lost `customFields` rows to a portal save before #873's merge-by-key fix (PR #900), found from the `activity_log` and `homeAccess.updatedByUid` evidence a save leaves behind, since no before-state is stored. Its LOCKOUT RISK section separately counts, for every household, migrated or not, lists over 40 rows or 64 KiB, unlabeled rows, and values over 1000 characters: shapes a save could be refused over, though none of them locks a household out today. Prints household ids, document paths, row keys and counts, never a value. |

1. `npm --prefix mytribe/functions run report:duplicate-kinfolk -- --allow-prod --project <id>`
   The first line printed is the target: check it names the right project and
   production. It refuses `--allow-prod` while `FIRESTORE_EMULATOR_HOST` is set,
   and without `--allow-prod` it runs only against the emulator.
2. `npm --prefix mytribe/functions run report:duplicate-notifications -- --project <id>`
   It has no `--allow-prod` flag because there is nothing to allow: its test
   greps the source and fails on any write call.
3. `npm --prefix mytribe/functions run report:legacy-amount-due -- --project <id> --allow-prod`
   The first line printed is the target. It refuses `--allow-prod` while
   `FIRESTORE_EMULATOR_HOST` is set, and its test greps the source for write
   calls, so every run is the dry run.
4. `npm --prefix mytribe/functions run report:truncated-custom-fields -- --project <id> --allow-prod`
   The first line printed is the target: check it names the right project and
   production. It refuses `--allow-prod` while `FIRESTORE_EMULATOR_HOST` is set.
   Read the truncated-rows list and the LOCKOUT RISK counts.

### Scripts and the data re-upload

Eleven scripts have lived in `mytribe/functions/package.json` without ever
being written up here or in `CALLABLE_CONTRACT.md`. PR #937 found the gap.
Each one has a long header explaining what it fixes, but none of them says
what to do with it now that all production data is about to be deleted and
re-uploaded. This settles that, script by script, from the header and the
actual query each one runs, not from the header's prose alone.

Three statuses, and only these three:

- **historical, superseded by the reload** - the bug it fixes can only be
  produced by application code that no longer runs, the collection it reads
  is not part of the re-upload, and the wipe clears out every row it would
  have found. Do not run it.
- **still applies** - the thing it corrects does not depend on the reload one
  way or the other. Run it on its own schedule.
- **post-import check** - the query is a pattern match against document
  shape, not a check against when a document was written, and the collection
  it reads IS part of the re-upload. The importer that will do the re-upload
  is not in this repository, so there is no way to confirm from here whether
  it produces the shape each script is looking for. Run the dry run after the
  relevant data lands; apply only if it plans writes.

| Script | Added by | Status | What it fixes |
|---|---|---|---|
| `backfill:invoice-date` | commit `a3177cf`, task W2-1 | post-import check | `invoices.date`/`dueDate` held free text (`"August 11, 2025"`) instead of `YYYY-MM-DD`. Firestore sorts strings by byte, so a letter-leading date beats every ISO cutoff and breaks the admin's date windows. The write side (`invoiceDay.ts`) is fixed for anything created through `createInvoice`/`createQuote`, but the scan is by shape, over every invoice in the collection, with no cutoff for when it was written. |
| `backfill:household-vet` | 2026-08-01 operator ruling (punchlist A2) | post-import check | Vet info lived on `kinfolk` fields; the ruling moved it to `household_data` so the clinic's catalog link travels with the household. The scan reads every `kinfolk` document and asks whether household_data already has the link, by field presence - not by a created-date cutoff. |
| `backfill:booking-kin-roster` | operator ruling R1 | post-import check | A booking with an omitted `kinIds` used to store the literal `[]`. R1 says an empty roster on a KinCare booking means all of the household's kin, not none, and the fix materializes that roster onto every booking that still reads empty. |
| `backfill:notif-split` | operator ruling R5 (2026-08-03) | historical, do not run | Relocates delivery-tracking fields (`status`, `mode`, `channels`, and their timestamps) off `notifications/{id}` onto `notificationDispatch/{id}`, the work-order collection R5 introduced. Confirmed against the current source: `dispatcher.ts` already writes every new notification's work order straight to `notificationDispatch`, so nothing written after the wipe can carry the fields this script is relocating. `notifications` is generated by the app's own crons and triggers, not by the reload. |
| `backfill:broadcast-category` | #443 (#424, #396) | historical, do not run | Old in-app broadcasts carried `category: 'broadcast'`, a value no catalog row ever declared, so they were invisible to every category-filtered view. Confirmed against the current source: `broadcastMessage.ts` already writes `category: def.category` on every send. Same reasoning as the row above: `notifications` is wiped and regenerated by the app, not re-uploaded. |
| `backfill:stripe-payment-cents` | Task 29a, PR29 (2026-08-06) | post-import check | Historical root `payments/{id}` rows stored `amount` in dollars or in cents depending on which code path wrote them, with no reliable marker on older rows, so the ledger read some of them 100x too high. See the payment-data flag below; leave this one alone otherwise. |
| `repair:blocked-slots` | #346 | historical, do not run | `createBlockedTimeSlot.ts` used to write `syncState: 'LOCAL'` (not a value Android's enum accepts) and a Firestore `Timestamp` into a field both clients declare as a `String`, and Android's decoder throws on the whole snapshot over one bad document. The writer is fixed; `booking_time_slots` holds internal scheduling blocks, not re-uploaded customer data, and the wipe clears every row this would have found. |
| `repair:business-timezone` | 2026-08-11 operator ruling | still applies | Sets `business_settings/business_settings.timeZone` to `America/Chicago`, the zone the business actually runs on. This is a one-document settings record, not customer data, so it is not clearly inside or outside "all production data" - and its own header says the field falls back to `America/New_York` (`DEFAULT_BUSINESS_SETTINGS`) when the document does not exist. Run the dry run after the reload regardless of whether the document survived it; it plans nothing if the zone is already right. |
| `report:payment-applied-without-payments` | #884 | post-import check | Read-only. Lists every invoice a household was told "Payment applied" about that has no payment row behind it anywhere. Exactly the check a data migration needs: an import that marks an invoice paid without carrying its payment history over would show up here. Run once the invoice and payment re-upload is done. |
| `report:over-applied-invoices` | #982 | still applies | Read-only, no write mode. Lists every invoice whose settlement rows (`invoices/{id}/payments`) add up to more than its total, with those rows and the root `payments` rows linked to it. A ledger row with a tip whose amount equals a settlement row is marked `settlement=whole-transaction`: the shape admin Android left when it sent `markInvoicePaid` the amount plus tip instead of the applied part. That mark is a match on figures, not a link, and an overpayment can be genuine. Nothing is repaired: what a household is owed back needs an operator ruling. |
| `report:autoapply-double-credit` | #977 | still applies | Read-only, no write mode. Lists root `payments` rows with auto-apply ticked, linked to an invoice, that applied nothing themselves and credited the household account, with the household's current `accountBalanceCents` and the invoice's settlement rows. Rows labelled `pre-fix` were credited `amount - tip`, which includes the invoice money `markInvoicePaid` had already applied; `post-fix` rows are a real leftover. Nothing is repaired: what a household is owed back needs an operator ruling. |
| `report:duplicate-checkout-credits` | docket Q5 (2026-09-27) | still applies | Read-only, no write mode; `--allow-prod` only confirms which database is read. Lists root `payments` rows the Stripe webhook's old duplicate-checkout branch wrote (`appliedTo: 'accountCredit'`): a card charge on an invoice already settled, credited in full to the household account balance with nobody deciding it. Prints each row's credited cents, reason, the invoice's status now and the household's `accountBalanceCents` now. Nothing is repaired: what happens to credit already given needs an operator ruling. Run `npm --prefix mytribe/functions run report:duplicate-checkout-credits -- --project <id> --allow-prod`. |
| `report:multiple-emergency-contacts` | Q2, ruling 2026-09-27 | still applies | Read-only, no write mode. Counts households with none, one, and more than one Emergency Contact, and lists each household with more than one: the contacts as initials and the phone's last four digits, with the date the office first had each. One per household is the rule now; a household with two keeps both until an admin removes one. |
| `report:overdue-notices-non-bills` | #871, already on the operator docket | post-import check | Read-only. Lists every overdue or reminder notice sent about an invoice that was not actually a live bill at the time (cancelled, an unaccepted quote, archived). The household-send-gate section above already says the re-upload will hand the crons a batch of old invoices that look freshly overdue the moment the gate reopens. Run this after that happens, to check none of those notices went out about an invoice that was never really open. |
| `report:desktop-direct-payments` | #881 | still applies | Read-only, and it has no write mode: `--allow-prod` is refused. Lists root `payments` rows that name an invoice but carry no `recordedBy` and no `BILLING_PAYMENT_RECORDED` audit entry, whose invoice is still open. Those are the rows the desktop console's old Record Payment dialog wrote directly, which never moved the invoice or the balance. Pre-W2-1 Android rows and imported rows can match too; the printed columns are there to tell them apart. Run `npm --prefix mytribe/functions run report:desktop-direct-payments -- --project <id>`. |

**`backfill:booking-kin-roster`'s no-`createdAt` rule assumes legacy data.**
The script includes a kin with no `createdAt` on the theory that an
undated Kin record predates every booking in the corpus, which was true for
this app's own legacy imports. If the kin records the re-upload creates also
land without `createdAt`, that assumption stops being conservative: it would
mean every kin in a household lands on every booking, regardless of when
either was actually added. Read the dry run's roster sizes before applying,
not just its counts.

**`backfill:stripe-payment-cents` is payment-adjacent. Document it, do not
delete it or touch how it decides amounts.** Checked against
`mytribe/functions/src/lib/paymentMoney.ts`: a root `payments` row with no
`amountSource` marker resolves as dollars, which is exactly how the live
invoice ledger already reads that same row today. Running this script never
disputes what the ledger already shows an operator; it only makes that same
figure permanent. The one way this goes wrong is upstream of the script
entirely - if whatever writes re-uploaded payment rows ever stores an amount
that is already in cents without also setting `amountSource` or
`amountCents`, the ledger and this stamp will both read it as dollars and be
wrong by the same 100x this script exists to fix. That is a constraint on the
importer, not a gap in this script.
