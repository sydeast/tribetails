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
 * The Auntie still owes this visit its KinTale: the setting is on, the visit is
 * COMPLETED, the server marked it due when it completed it, and nothing has
 * been sent. A visit completed before the setting, or while it was off, carries
 * no stamp and owes nothing.
 */
fun kinTaleOwed(session: KinCareSession, kinTaleRequired: Boolean): Boolean =
    kinTaleRequired &&
        session.status.trim().uppercase() == "COMPLETED" &&
        session.kinTaleDue &&
        !kinTaleSent(session)

/** What the console says once a KinTale has been sent. Same words as admin web. */
const val KINTALE_SENT_MESSAGE = "KinTale sent. Kinfolk will hear from you soon."
