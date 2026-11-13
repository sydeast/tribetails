package com.tribetails.auntieos.ui.admin

import com.tribetails.auntieos.data.repository.EmailFrameRepository
import com.tribetails.auntieos.data.repository.StaffMember
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Test

/**
 * #1962: a "saved by" stamp is a uid, or a sign-in email on older records.
 * Neither is ever printed: the line shows the person's name or "an Admin".
 * #1989: the Email frame line reads "Using the default frame" whenever nothing
 * is stored. The web twin is `auntieos-admin/src/lib/actorLabel.test.ts`.
 */
class ActorLabelTest {
    private val uid = "nppJNdMNYJfUigibGKUQj3n4obt2"
    private val staff = listOf(
        StaffMember(uid = uid, displayName = "Syd East", email = "e2e-admin@tribetails.com"),
        StaffMember(uid = "u-nameless", displayName = null, email = null),
        // What `listStaff` answers for a record with no name: the sign-in email.
        StaffMember(uid = "u-email-only", displayName = "catch@hanasamku.com", email = null),
        StaffMember(uid = "u-uid-name", displayName = "u-uid-name", email = null),
    )

    @Test
    fun aUidStampIsShownAsTheStaffMembersName() {
        assertEquals("Syd East", actorLabel(uid, staff))
    }

    @Test
    fun anOlderSignInEmailStampIsShownAsTheName() {
        assertEquals("Syd East", actorLabel("e2e-admin@tribetails.com", staff))
        assertEquals("Syd East", actorLabel(" E2E-Admin@TribeTails.com ", staff))
    }

    @Test
    fun aUidNobodyAnswersToReadsAsAnAdmin() {
        assertEquals("an Admin", actorLabel("gone-uid-0000000000000000000", staff))
        assertEquals("an Admin", actorLabel("pawsome@hanasamku.com", staff))
        assertEquals("an Admin", ADMIN_ACTOR_FALLBACK)
    }

    @Test
    fun anEmailOrAUidTheRosterHoldsAsTheNameIsNotShown() {
        assertEquals("an Admin", actorLabel("u-nameless", staff))
        assertEquals("an Admin", actorLabel("u-email-only", staff))
        assertEquals("an Admin", actorLabel("catch@hanasamku.com", staff))
        assertEquals("an Admin", actorLabel("u-uid-name", staff))
    }

    @Test
    fun theStampItselfIsNeverReturned() {
        val stamps = listOf(uid, "e2e-admin@tribetails.com", "gone-uid", "pawsome@hanasamku.com", "admin", "u-email-only")
        for (stamp in stamps) {
            for (roster in listOf(staff, emptyList())) {
                assertNotEquals(stamp, actorLabel(stamp, roster))
                assertFalse('@' in actorLabel(stamp, roster))
            }
        }
    }

    @Test
    fun aBlankStampHasNothingToPrint() {
        assertEquals("", actorLabel("", staff))
        assertEquals("", actorLabel("   ", staff))
        assertEquals("", actorLabel(null, staff))
    }

    @Test
    fun nothingIsPrintedUntilTheRosterIsReadThenTheFallback() {
        assertEquals("", actorLabel(uid, null))
        assertEquals("an Admin", actorLabel(uid, emptyList()))
    }

    @Test
    fun aScreenCanAskForAnotherFallback() {
        assertEquals("an Auntie", actorLabel("gone-uid", staff, fallback = "an Auntie"))
    }

    // ── The Email frame line ────────────────────────────────────────────────

    private val defaults = mapOf("accentColor" to "#df8431", "footerText" to "")

    private fun frame(stored: Map<String, String>, updatedAt: String?, updatedBy: String?) =
        EmailFrameRepository.EmailFrameState(stored, defaults, updatedAt, updatedBy)

    @Test
    fun aFrameThatDiffersFromTheDefaultNamesWhoSavedIt() {
        val saved = frame(mapOf("footerText" to "Thanks"), "2026-11-11T19:45:00.000Z", uid)
        assertEquals("Last saved 2026-11-11 by Syd East", emailFrameDetail(saved, staff))
    }

    @Test
    fun anUnknownSaverReadsAsAnAdminNeverTheUid() {
        val saved = frame(mapOf("footerText" to "Thanks"), "2026-11-11T19:45:00.000Z", uid)
        assertEquals("Last saved 2026-11-11 by an Admin", emailFrameDetail(saved, emptyList()))
    }

    @Test
    fun theUidIsNotPrintedWhileTheRosterIsStillBeingRead() {
        val saved = frame(mapOf("footerText" to "Thanks"), "2026-11-11T19:45:00.000Z", uid)
        assertEquals("Last saved 2026-11-11", emailFrameDetail(saved, null))
    }

    @Test
    fun nothingStoredIsTheDefaultFrameBeforeAnySave() {
        assertEquals("Using the default frame", emailFrameDetail(frame(emptyMap(), null, null), staff))
    }

    @Test
    fun nothingStoredIsTheDefaultFrameEvenWhenAStampCameWithIt() {
        // #1989: what an older server answered after the last field was cleared.
        val cleared = frame(emptyMap(), "2026-11-11T19:45:00.000Z", uid)
        assertEquals("Using the default frame", emailFrameDetail(cleared, staff))
    }
}
