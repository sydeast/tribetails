import type { Firestore } from 'firebase-admin/firestore';

/**
 * Issue #519: the operator's "Send a reminder 24 hours before a visit" switch,
 * which is `business_settings.enableAutoReminder24h` on every admin model.
 *
 * Until now the field was declared, defaulted and round-tripped by all three
 * admin clients and read by nothing. `kincareReminderCron` enqueued
 * `kincare.upcoming.reminder` for every confirmed booking in its 24-48h window
 * UNCONDITIONALLY, so the switch an operator would have flipped -- had any
 * surface offered one -- could not have changed a thing. This is the read that
 * makes it real, and it is the same shape #517 gave `enableConflictDetection`
 * in `bookingBusyConflict.ts`.
 *
 * ABSENT MEANS ON, and here that is load-bearing rather than a convention
 * copied over: the reminder ships today, on every install, for every settings
 * document -- none of which carries this key, because nothing has ever written
 * it. Reading a missing key as its old model default (`false`) would switch
 * reminders OFF for every existing operator on the deploy that introduced the
 * gate. Only an explicit `false` -- an operator who went and turned it off on
 * one of the new editors -- stops the enqueue.
 *
 * The four client models were changed in the same commit to default `true`, so
 * what they state and what the server does now agree. That is a correction of
 * the models rather than a change of behavior: `false` was never what the
 * product did.
 *
 * A read failure is NOT a reason to skip a reminder. The cron already runs
 * without any settings document at all, and a transient Firestore error must
 * not silently cancel every kinfolk's visit reminder for that hour, so the
 * throw is swallowed and the answer is the shipped behavior.
 */

/** The unified settings doc every client writes (`business_settings/business_settings`). */
const BUSINESS_SETTINGS_DOC = 'business_settings/business_settings';

export async function isAutoReminder24hEnabled(firestore: Firestore): Promise<boolean> {
  try {
    const snap = await firestore.doc(BUSINESS_SETTINGS_DOC).get();
    return snap.data()?.enableAutoReminder24h !== false;
  } catch {
    return true;
  }
}
