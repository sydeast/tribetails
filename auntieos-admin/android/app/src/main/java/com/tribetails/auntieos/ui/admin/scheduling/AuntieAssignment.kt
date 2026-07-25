package com.tribetails.auntieos.ui.admin.scheduling

// ─────────────────────────────────────────────────────────────────────────────
// Pure-helper layer for the Assigned Auntie gate. Mirrors web
// BookingDetailModal's isEnvelopeVisit + NO_ENVELOPE_ASSIGN.
//
// Assignment is written to the MyTribe kinCare visit doc at
// families/{kinfolkId}/bookings/{batchId}/kinCares/{visitId}, and is never
// mirrored onto the flat kin_care_sessions row. A session created ad hoc rather
// than by approving a booking request carries none of those ids, so there is no
// doc to assign against.
//
// The screen used to respond to that by rendering nothing at all. An operator
// then had no way to tell "nobody is assigned yet" from "this visit can never be
// assigned", which is the same class of silent-omission defect the web port
// exists to close. The control now renders disabled, with the reason.
// ─────────────────────────────────────────────────────────────────────────────

/** True when the session carries every id the assignAuntie callable needs. */
internal fun canAssignAuntie(kinfolkId: String?, batchId: String?, visitId: String?): Boolean =
    !kinfolkId.isNullOrBlank() && !batchId.isNullOrBlank() && !visitId.isNullOrBlank()

/** Shown beside the disabled control. Says why, not just that it is off. */
internal fun assignUnavailableReason(): String =
    "This visit is not part of a booking request, so there is no visit record to assign against. " +
        "Assignment lives on the request, and only visits approved from one carry it."
