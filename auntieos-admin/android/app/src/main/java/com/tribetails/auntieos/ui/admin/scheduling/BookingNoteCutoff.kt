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
// APPLIES TO BOTH THREADS, ON BOTH SIDES. addBookingNote and
// addInternalBookingNote both enforce the window server-side (2026-07-25,
// functions/src/lib/bookingNoteCutoff.ts) and reject identically:
// failed-precondition with details.code == "booking_note_cutoff". This file is
// a MIRROR of that rule, so the composer is already closed rather than the
// operator typing a note and being refused. It is not the guard.
// ─────────────────────────────────────────────────────────────────────────────

internal const val NOTE_CUTOFF_MS: Long = 3L * 60L * 60L * 1000L

internal fun isNoteEditLocked(nowMs: Long, startMs: Long?): Boolean {
    if (startMs == null) return false
    return nowMs >= (startMs - NOTE_CUTOFF_MS)
}

internal fun noteCutoffWarning(locked: Boolean): String? =
    if (locked) "Notes are locked: this visit starts in under 3 hours." else null
