# Household notifications

How to open, schedule, check and close the household send gate. The ruling is D-HOUSEHOLD-SEND-GATE in `docs/DECISIONS.md`.

Moved out of `docs/RUNBOOK.md` on 2026-09-28 so the runbook holds only the release procedure. The text is the runbook's, with cross-references repointed at the new files.

## Opening household notifications

Until you switch this on, nothing the platform sends reaches a household. Your
own alerts keep coming the whole time.

The gate exists because of the data re-upload. Several jobs chase households on
a clock: `invoiceRemindersCron`, `invoiceOverdueCron`, `kincareReminderCron`,
`scheduleDigestCron`, and the three notification sweeps. Re-upload the old
invoices and the overdue run finds every unpaid bill that was already past due
in the old system, and writes to real people about bills they settled months
ago. There is no recall on an email.

It is one boolean, read by `enqueueNotificationDetailed` once per send. Copies
addressed to a household stop there. Copies addressed to you or to an Auntie go
out as they always have, which is why the failed-login and account-lockout
alerts from #876 keep working while the gate is shut.

**There is a second lock now, and it is also shut.** The three daily jobs used
to be pinned to 09:00, 09:30 and 07:00 in their own code. They now run at an
hour you choose, and until you choose one they do not run at all. So the two
invoice crons are held twice over: no send hour, and this gate. "Choosing when
the daily jobs run" below is the other half.

### Turning it on

**Settings, Notifications, the Notification schedule panel.** Switch on "Send
notices to households". It is the first control at the top of the panel, and it
is on all three admin clients: the web admin, the Android app and the desktop
console. This used to be a hand edit in the Firebase console and no longer needs
to be.

It takes effect on the next send, with no deploy and no restart, because the
value is read per send rather than cached at cold start.

**The console is still there as a fallback** if an admin client will not load.
Firestore, document `business_settings/business_settings`, add a field:

```
householdNotificationsLive   boolean   true
```

Three things to know about the value, which matter mostly if you set it by hand:

- It must be the boolean `true`. The string `"true"` reads as off, on purpose.
  Going live is a decision you make once, and a value we cannot read as the
  literal boolean is not evidence that you made it.
- The field absent reads as off, which is how production sits today.
- If Firestore cannot be read at all, the gate reads as off and writes a
  `critical` log line, `household.send.gate.read.failed`. See the note at the
  bottom.

Set it on `business_settings/business_settings`. The older
`business_settings/singleton` id is read only when that document does not exist
at all, so when both are present the modern one is the only one that counts.

All three admin clients save settings as a merge of only the fields they
touched, so editing business hours or anything else on any of them leaves this
field where you put it.

### Choosing when the daily jobs run

Same panel, under the toggle. Two pickers, both starting at "Not scheduled":

- **Invoice reminders and overdue notices.** One hour governs both
  `invoiceRemindersCron` and `invoiceOverdueCron`. They read different invoices,
  so sharing an hour cannot produce two notices about one bill.
- **Your daily schedule digest.** Its own hour, because it is your brief and no
  household ever sees it. It is not held by the gate above, so this picker is
  the only thing deciding whether it runs.

The hours are on the business's own clock, the `timeZone` on the Business
profile tab. The panel names the zone so you are not guessing which clock you
are setting.

Whole hours only. The overdue notice used to go at 09:30 and cannot any more,
because the jobs check the clock once an hour.

**Picking "Not scheduled" again stops a job.** It is a choice you can return to,
not a placeholder.

**Changing the hour never doubles up.** Each job records the day it last ran, so
moving the hour from 14:00 to 09:00 at 11am sends once, at 11am, and moving it
from 09:00 to 14:00 after the 09:00 run has already gone sends nothing more that
day. Move it freely.

**Why the jobs are invoked every hour.** A Cloud Scheduler time is fixed when
the function deploys and cannot be read out of Firestore, so the only way for
you to change it without a deploy is for the job to wake up hourly, look at your
setting, and go back to sleep when it is not the hour. A wake-up with no hour
set reads one document and stops. It is not doing work and it is not sending
anything.

**It only bites once the functions are deployed.** Merging deploys nothing to
the backend. Run the release, then confirm the deploy landed:

```bash
firebase functions:list --json | jq -r '.[] | select(.id=="invoiceOverdueCron") | "\(.id) \(.generation) \(.updateTime)"'
```

Re-upload the data after that, not before.

### Turning it back off

Set the same field to `false`, or delete it. The next send is held back. Nothing
that already went out can be pulled back, so this stops the bleeding rather than
undoing anything.

### Checking it took

Look for something happening, not for something stopping. The gate is meant to
hold for weeks, so quiet logs prove very little on their own.

Pick an overdue invoice in Firestore and watch it across one overdue run,
at whatever hour you set above. While the
gate is shut it carries `overdueSuppressedAtMs` and no `overdueNotifiedAtMs`.
The morning after you open the gate, the same invoice picks up
`overdueNotifiedAtMs` and a `scheduledNotifications` row appears for the
household. That is the confirmation, and it is the thing the whole design
protects: the suppressed stamp is a one-per-day backoff, the notified stamp is a
permanent skip, and nothing writes the second one for a notice that was never
delivered, so the backlog survives however long the gate stays shut.

The logs are the second read. Logs Explorer, the `mytribe` functions:

```
jsonPayload.event="notification.gated.household.summary"
```

One line per send that was held back, carrying the notification key, how many
household copies were suppressed and how many operator copies still went. These
accumulate while the gate is shut and stop once you open it.

For the per-recipient detail, `jsonPayload.event="notification.gated.household"`
carries the key, the recipient uid, the gate state and the channels that copy
would have used. That is the list of mail the business meant to send and did not.

### What the gate does not cover

Three paths reach a household without passing it, and all three need you to
press a button:

- **Broadcasts** (`broadcastMessage`). Sends email, SMS and push to the
  households you select, directly. It honours the notification gate settings and
  each household's own preferences, but not this switch.
- **A single message to one household** (`sendExternalMessage`).
- **Invite and account-recovery mail** (`sendFromTemplate`). Onboarding has to
  work while the gate is shut, so this one is deliberate.

Nothing in that list runs on a schedule, so none of it can go off while you are
asleep during the re-upload.

**Do not schedule a marketing blast while the gate is shut.** A blast is spent
rather than delayed: the fan-out records each household as suppressed and never
comes back to them, so opening the gate afterwards sends nothing. Schedule it
after.

### What the re-upload itself will do

Bulk writes fire the document triggers, so expect this while the gate is shut:

- **You will get mail.** The operator copies of `invoice.new`,
  `kincare.booking.confirm`, `pets.updated`, `profile.updated` and
  `pet.marked.inactive` are not household copies, so they go out as designed.
  On a few thousand records that is a few thousand emails to you. Consider
  turning those rows off in the notification gate for the duration, and back on
  after.
- **Invoices keep their backlog.** Nothing marks a re-uploaded invoice as
  reminded or notified, so the first runs after you open the gate chase them.
- **Old KinTales and bookings do not get announced at launch, and that is on
  purpose.** Publishing a tale and confirming a booking both claim their
  "announced" marker before the send rather than after, so an uploaded tale is
  marked announced during the upload and is never announced again. Nobody wants
  two hundred historical tales landing in a household's inbox on launch day. It
  is the opposite of the invoice behaviour above, so it is worth knowing which
  is which.

### The fail-closed choice, and when to revisit it

A settings read that throws is treated as off. That is the right way round today:
a suppressed notice goes out on the next run an hour or a day later, and a notice
sent to a household about a migrated bill cannot be taken back.

Once you are live the balance reverses. A Firestore blip would then hold back
notifications people are actually waiting on, and "off when unsure" stops being
the careful answer. Worth revisiting at that point. It is logged at `critical`
rather than swallowed so you find out either way.
