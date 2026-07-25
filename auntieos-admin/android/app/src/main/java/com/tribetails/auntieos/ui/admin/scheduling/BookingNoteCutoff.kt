package com.tribetails.auntieos.ui.admin.scheduling

// ─────────────────────────────────────────────────────────────────────────────
// Pure-helper layer for booking note edit cutoff. Mirrors web
// lib/bookingDetailFormat.ts NOTE_CUTOFF_MS = 3hr, which in turn mirrors the
// server's own CUTOFF_MS in functions/src/portal/addBookingNote.ts. Notes lock
// 3 hours before visit startTime so the auntie reading them at arrival can
// trust their final state.
//
// THE ONE COPY. KinCareDetailScreen used to carry its own private
// NOTE_CUTOFF_MS with the comparison re-implemented inline, and its own wording
// for the warning, so the same rule was stated twice and explained two
// different ways. Both surfaces now come through here.
//
// APPLIES TO BOTH THREADS. The server only enforces the cutoff on the
// kinfolk-facing note (addInternalBookingNote has no check), but the operator
// ruling is that both freeze before a visit, so the internal composer is locked
// as a client policy on web and here alike. Flagged rather than left looking
// server-backed when it is not.
// ─────────────────────────────────────────────────────────────────────────────

internal const val NOTE_CUTOFF_MS: Long = 3L * 60L * 60L * 1000L

internal fun isNoteEditLocked(nowMs: Long, startMs: Long?): Boolean {
    if (startMs == null) return false
    return nowMs >= (startMs - NOTE_CUTOFF_MS)
}

internal fun noteCutoffWarning(locked: Boolean): String? =
    if (locked) "Notes are locked: this visit starts in under 3 hours." else null
