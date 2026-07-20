package com.tribetails.auntieos.ui.admin.scheduling

// ─────────────────────────────────────────────────────────────────────────────
// Pure-helper layer for booking conflict + travel-buffer detection. Pulled out
// of BookingRepository.evaluateAvailability so the rules can be JVM-tested
// without Firestore. Repository wires these helpers to its query results.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Strict overlap only - adjacent intervals (`a.end == b.start`) are NOT a
 * conflict. Visits scheduled back-to-back are allowed; the travel buffer is
 * a separate gate (see [hasTravelBufferViolation]).
 */
internal fun intervalsOverlap(aStartMs: Long, aEndMs: Long, bStartMs: Long, bEndMs: Long): Boolean {
    return aStartMs < bEndMs && bStartMs < aEndMs
}

/**
 * Travel buffer is the minimum gap between consecutive (non-overlapping) visits
 * the admin requires so the auntie can drive between addresses. Only applies
 * to forward gaps - overlap is caught by [intervalsOverlap].
 */
internal fun hasTravelBufferViolation(prevEndMs: Long, nextStartMs: Long, bufferMinutes: Int): Boolean {
    if (bufferMinutes <= 0) return false
    if (nextStartMs < prevEndMs) return false   // Overlap, not a buffer issue
    val gapMs    = nextStartMs - prevEndMs
    val bufferMs = bufferMinutes * 60_000L
    return gapMs < bufferMs
}

internal fun minutesBetween(startMs: Long, endMs: Long): Long =
    (endMs - startMs) / 60_000L
