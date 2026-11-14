package com.tribetails.auntieos.web.data

/**
 * ISSUE #2123 (operator ruling 2026-11-12): a visit is Completed as soon as the
 * Auntie has departed, and a KinTale never decides that. The server completes a
 * visit the moment its status becomes DEPARTED (`onKinCareSessionDeparted`).
 *
 * "KinTale required" (`business_settings.kinTaleRequired`, absent reads OFF) is
 * a task, never a gate. While it is on, the server stamps `kinTaleDue: true` on
 * a visit it completes with no KinTale sent yet, and every client's send batch
 * writes it back to false (this console's `JvmFirestoreRest.markReportSentAtomic`).
 * Until then the visit sits under "KinTales to send" on Auntie Time.
 *
 * THE STAMP IS THE AUTHORITY, AND NOTHING HERE READS THE SETTING. The task is
 * the Auntie's, and an Auntie cannot read `business_settings` (owner-only in
 * the rules). So the board lists the task from the stamp alone, for any
 * sign-in, and the server clears every stamp still standing when the owner
 * turns the setting off (`functions/src/triggers/onBusinessSettingsWrite.ts`).
 *
 * This replaces #1799's `VisitCompletionAfterKinTale.kt`, which completed a
 * DEPARTED visit after its KinTale was sent. Same rule on admin web
 * (`lib/sessionLifecycle.ts`) and admin Android.
 */

/**
 * A KinTale for this visit has gone home: every send batch bumps
 * `sentReportCount`. `reportIds` alone is NOT proof of a send: Android's
 * `createKinCareReport` appends a DRAFT's id to it.
 */
fun kinTaleSent(session: KinCareSession): Boolean = session.sentReportCount > 0

/**
 * The Auntie still owes this visit its KinTale: the visit is COMPLETED, the
 * server stamped it due when it completed it, and nothing has been sent. A visit
 * completed before the setting, or while it was off, carries no stamp, and
 * switching the setting off clears the stamps, so either way it owes nothing.
 */
fun kinTaleOwed(session: KinCareSession): Boolean =
    session.status.trim().uppercase() == "COMPLETED" &&
        session.kinTaleDue &&
        !kinTaleSent(session)

/**
 * What the console says once a KinTale has been sent, before the server's line
 * about the household (#1816). It used to add "Kinfolk will hear from you soon",
 * a promise made whether or not anyone could be told.
 */
const val KINTALE_SENT_MESSAGE = "KinTale sent."
