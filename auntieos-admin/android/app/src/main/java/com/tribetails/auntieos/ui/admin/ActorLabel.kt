package com.tribetails.auntieos.ui.admin

import com.tribetails.auntieos.data.repository.EmailFrameRepository
import com.tribetails.auntieos.data.repository.StaffMember

/**
 * #1962: the name a screen prints for whoever did something, from the stamp a
 * record holds for them. The web twin is `auntieos-admin/src/lib/actorLabel.ts`.
 *
 * A stamp is a staff uid (what the server writes), or on older records the
 * sign-in email, or some other string. None of those is a name, so THE STAMP IS
 * NEVER RETURNED: the answer is the staff member's display name, or [fallback]
 * when nobody on the roster answers to it, or when the only label the roster
 * has for them is itself an email or the uid (`listStaff` fills a nameless
 * record from the sign-in account, down to its email).
 *
 * `""` means there is nothing to print yet: the stamp is blank, or the roster
 * has not been read ([staff] is null). A caller drops its "by ..." clause then,
 * so the line never shows a guess that changes a moment later.
 */
internal const val ADMIN_ACTOR_FALLBACK = "an Admin"

internal fun actorLabel(
    stamp: String?,
    staff: List<StaffMember>?,
    fallback: String = ADMIN_ACTOR_FALLBACK,
): String {
    val who = stamp.orEmpty().trim()
    if (who.isEmpty() || staff == null) return ""
    val member = staff.firstOrNull { it.uid == who }
        // An email stamp: the staff record's own email, or the sign-in email
        // the server put in the name's place.
        ?: if ('@' in who) {
            staff.firstOrNull { sameText(it.email, who) || sameText(it.displayName, who) }
        } else {
            null
        }
    val name = member?.displayName.orEmpty().trim()
    if (member == null || name.isEmpty() || '@' in name || name == member.uid || name == who) return fallback
    return name
}

private fun sameText(a: String?, b: String): Boolean = a.orEmpty().trim().equals(b, ignoreCase = true)

/**
 * The line under the "Email frame" title.
 *
 * #1989: nothing stored is the default frame, whatever stamp came with it. The
 * server decides what counts as stored (a value equal to its default does not)
 * and sends no stamp for the default frame. #1962: the saver is named, never
 * shown as the uid the stamp holds.
 */
internal fun emailFrameDetail(frame: EmailFrameRepository.EmailFrameState, staff: List<StaffMember>?): String {
    val savedAt = frame.updatedAt?.takeIf { it.isNotBlank() }
    if (frame.stored.isEmpty() || savedAt == null) return "Using the default frame"
    val by = actorLabel(frame.updatedBy, staff)
    return "Last saved ${savedAt.take(10)}" + if (by.isEmpty()) "" else " by $by"
}
