package com.tribetails.auntieos.ui.admin.scheduling

// ─────────────────────────────────────────────────────────────────────────────
// Pure-helper layer for booking note edit cutoff. Mirrors web BookingDetailModal
// NOTE_CUTOFF_MS = 3hr - notes lock 3 hours before visit startTime so the auntie
// reading them at arrival can trust their final state.
// ─────────────────────────────────────────────────────────────────────────────

internal const val NOTE_CUTOFF_MS: Long = 3L * 60L * 60L * 1000L

internal fun isNoteEditLocked(nowMs: Long, startMs: Long?): Boolean {
    if (startMs == null) return false
    return nowMs >= (startMs - NOTE_CUTOFF_MS)
}

internal fun noteCutoffWarning(locked: Boolean): String? =
    if (locked) "Notes locked - visit is within 3 hours" else null
