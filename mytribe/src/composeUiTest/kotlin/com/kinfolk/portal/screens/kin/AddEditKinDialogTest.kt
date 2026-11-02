@file:OptIn(androidx.compose.ui.test.ExperimentalTestApi::class)

package com.kinfolk.portal.screens.kin

import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.test.runComposeUiTest
import com.kinfolk.portal.portal.Kin
import com.kinfolk.portal.portal.KinRemovalOptions
import com.kinfolk.portal.portal.KinRemovalRequest
import com.kinfolk.portal.portal.KinStatus
import com.kinfolk.portal.portal.removalDateLabel
import com.kinfolk.portal.screens.setThemedContent
import kotlinx.coroutines.CompletableDeferred
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * #1311: the memorial action lives at the foot of the edit dialog, behind a
 * confirm step, and nowhere on the Add dialog. Restore sits in the same slot
 * for a memorial Kin.
 *
 * #1314: "Delete this Kin" sits under it, only when the server says there is
 * nothing on file, behind its own confirm step, and nowhere on Add.
 *
 * #1408: a Kin WITH history gets "Request removal" in that slot instead, with
 * a confirm step and an optional reason; then its pending or declined state.
 */
class AddEditKinDialogTest {

    private fun kin(status: KinStatus) = Kin(
        id = "k1",
        name = "Biscuit",
        species = "Dog",
        breed = "Corgi",
        ageYears = 4.0,
        photoUrl = null,
        status = status,
        feedingInstructions = null,
        walkingInstructions = null,
        medications = null,
        allergies = null,
        emergencyNotes = null,
        sitterNotes = null,
    )

    @Test
    fun edit_activeKin_marksAfterConfirm_thenCloses() = runComposeUiTest {
        var received: Boolean? = null
        var closed = false
        setThemedContent {
            AddEditKinDialog(
                initial = kin(KinStatus.Active),
                onClose = { closed = true },
                onSubmit = { _, _ -> null },
                onArchive = { restore -> received = restore; null },
            )
        }
        waitForIdle()
        onNodeWithText("Restore as Active").assertDoesNotExist()
        onNodeWithText("Yes, mark No Longer With Us").assertDoesNotExist()

        onNodeWithText("Mark No Longer With Us").performScrollTo().performClick()
        waitForIdle()
        // Confirm step: nothing has been sent yet.
        onNodeWithText("Yes, mark No Longer With Us").assertExists()
        onNodeWithText("Never mind").assertExists()
        assertNull(received)
        assertFalse(closed)

        onNodeWithText("Yes, mark No Longer With Us").performScrollTo().performClick()
        waitForIdle()
        assertEquals(false, received)
        assertTrue(closed)
    }

    @Test
    fun edit_activeKin_neverMind_sendsNothing() = runComposeUiTest {
        var called = false
        setThemedContent {
            AddEditKinDialog(
                initial = kin(KinStatus.Active),
                onClose = {},
                onSubmit = { _, _ -> null },
                onArchive = { called = true; null },
            )
        }
        waitForIdle()
        onNodeWithText("Mark No Longer With Us").performScrollTo().performClick()
        waitForIdle()
        onNodeWithText("Never mind").performScrollTo().performClick()
        waitForIdle()
        onNodeWithText("Yes, mark No Longer With Us").assertDoesNotExist()
        onNodeWithText("Mark No Longer With Us").assertExists()
        assertFalse(called)
    }

    @Test
    fun edit_memorialKin_restoresFromTheSameSlot() = runComposeUiTest {
        var received: Boolean? = null
        var closed = false
        setThemedContent {
            AddEditKinDialog(
                initial = kin(KinStatus.NoLongerWithUs),
                onClose = { closed = true },
                onSubmit = { _, _ -> null },
                onArchive = { restore -> received = restore; null },
            )
        }
        waitForIdle()
        onNodeWithText("Mark No Longer With Us").assertDoesNotExist()
        onNodeWithText("Restore as Active").performScrollTo().performClick()
        waitForIdle()
        assertEquals(true, received)
        assertTrue(closed)
    }

    @Test
    fun edit_failedArchive_staysOpenAndSaysSo() = runComposeUiTest {
        var closed = false
        setThemedContent {
            AddEditKinDialog(
                initial = kin(KinStatus.Active),
                onClose = { closed = true },
                onSubmit = { _, _ -> null },
                onArchive = { "Missing or insufficient permissions." },
            )
        }
        waitForIdle()
        onNodeWithText("Mark No Longer With Us").performScrollTo().performClick()
        waitForIdle()
        onNodeWithText("Yes, mark No Longer With Us").performScrollTo().performClick()
        waitForIdle()
        onNodeWithText("Missing or insufficient permissions.").assertExists()
        assertFalse(closed)
    }

    @Test
    fun add_hasNoMemorialAction() = runComposeUiTest {
        setThemedContent {
            AddEditKinDialog(
                initial = null,
                onClose = {},
                onSubmit = { _, _ -> null },
                onArchive = { null },
            )
        }
        waitForIdle()
        // "Add Kin" is both the title and the button, so anchor on a field.
        onNodeWithText("Name").assertExists()
        onNodeWithText("Mark No Longer With Us").assertDoesNotExist()
        onNodeWithText("Restore as Active").assertDoesNotExist()
    }

    // ---- #1314 delete row ----

    @Test
    fun add_hasNoDeleteRow_evenWhenTheCheckWouldAllowIt() = runComposeUiTest {
        var asked = false
        setThemedContent {
            AddEditKinDialog(
                initial = null,
                onClose = {},
                onSubmit = { _, _ -> null },
                removalOptions = { asked = true; KinRemovalOptions(canDelete = true) },
                onDelete = { null },
            )
        }
        waitForIdle()
        onNodeWithText("Name").assertExists()
        onNodeWithText("Delete this Kin").assertDoesNotExist()
        assertFalse(asked)
    }

    @Test
    fun edit_withHistory_hasNoDeleteRow() = runComposeUiTest {
        setThemedContent {
            AddEditKinDialog(
                initial = kin(KinStatus.Active),
                onClose = {},
                onSubmit = { _, _ -> null },
                onArchive = { null },
                removalOptions = { KinRemovalOptions(canDelete = false) },
                onDelete = { null },
            )
        }
        waitForIdle()
        onNodeWithText("Mark No Longer With Us").assertExists()
        onNodeWithText("Delete this Kin").assertDoesNotExist()
    }

    @Test
    fun edit_failedCheck_hidesTheRowAndSaysNothing() = runComposeUiTest {
        setThemedContent {
            AddEditKinDialog(
                initial = kin(KinStatus.Active),
                onClose = {},
                onSubmit = { _, _ -> null },
                onArchive = { null },
                removalOptions = { throw IllegalStateException("network") },
                onDelete = { null },
            )
        }
        waitForIdle()
        onNodeWithText("Mark No Longer With Us").assertExists()
        onNodeWithText("Delete this Kin").assertDoesNotExist()
        onNodeWithText("network").assertDoesNotExist()
        // #1408: the failure is said plainly, with a retry, not hidden.
        onNodeWithText("Couldn't check how this Kin can be removed.").assertExists()
        onNodeWithText("Try again").assertExists()
    }

    @Test
    fun edit_noHistory_deletesAfterConfirm_thenCloses() = runComposeUiTest {
        var deleted = false
        var closed = false
        setThemedContent {
            AddEditKinDialog(
                initial = kin(KinStatus.Active),
                onClose = { closed = true },
                onSubmit = { _, _ -> null },
                onArchive = { null },
                removalOptions = { KinRemovalOptions(canDelete = true) },
                onDelete = { deleted = true; null },
            )
        }
        waitForIdle()
        onNodeWithText("Yes, delete this Kin").assertDoesNotExist()

        onNodeWithText("Delete this Kin").performScrollTo().performClick()
        waitForIdle()
        // Confirm step: nothing has been sent yet, and the memorial row is still there.
        onNodeWithText("Yes, delete this Kin").assertExists()
        onNodeWithText("Never mind").assertExists()
        onNodeWithText("Mark No Longer With Us").assertExists()
        assertFalse(deleted)
        assertFalse(closed)

        onNodeWithText("Yes, delete this Kin").performScrollTo().performClick()
        waitForIdle()
        assertTrue(deleted)
        assertTrue(closed)
    }

    @Test
    fun edit_noHistory_neverMind_sendsNothing() = runComposeUiTest {
        var called = false
        setThemedContent {
            AddEditKinDialog(
                initial = kin(KinStatus.Active),
                onClose = {},
                onSubmit = { _, _ -> null },
                onArchive = { null },
                removalOptions = { KinRemovalOptions(canDelete = true) },
                onDelete = { called = true; null },
            )
        }
        waitForIdle()
        onNodeWithText("Delete this Kin").performScrollTo().performClick()
        waitForIdle()
        onNodeWithText("Never mind").performScrollTo().performClick()
        waitForIdle()
        onNodeWithText("Yes, delete this Kin").assertDoesNotExist()
        onNodeWithText("Delete this Kin").assertExists()
        assertFalse(called)
    }

    @Test
    fun edit_refusedDelete_staysOpenAndShowsTheServerSentence() = runComposeUiTest {
        var closed = false
        val refusal = "Biscuit has visits on file, so this profile cannot be deleted from here."
        setThemedContent {
            AddEditKinDialog(
                initial = kin(KinStatus.Active),
                onClose = { closed = true },
                onSubmit = { _, _ -> null },
                onArchive = { null },
                removalOptions = { KinRemovalOptions(canDelete = true) },
                onDelete = { refusal },
            )
        }
        waitForIdle()
        onNodeWithText("Delete this Kin").performScrollTo().performClick()
        waitForIdle()
        onNodeWithText("Yes, delete this Kin").performScrollTo().performClick()
        waitForIdle()
        onNodeWithText(refusal).assertExists()
        assertFalse(closed)
    }

    // ---- #1408 request removal ----

    private val nov2 = 1_793_620_800_000L // 2026-11-02T12:00Z
    private val nov3 = nov2 + 86_400_000L

    private fun request(
        status: String = "pending",
        reason: String? = null,
        resolvedAtMs: Long? = null,
        note: String? = null,
    ) = KinRemovalRequest(
        id = "fam1_k1",
        status = status,
        reason = reason,
        requestedAtMs = nov2,
        resolvedAtMs = resolvedAtMs,
        resolutionNote = note,
    )

    @Test
    fun edit_withHistory_showsRequestRemoval_notDelete() = runComposeUiTest {
        setThemedContent {
            AddEditKinDialog(
                initial = kin(KinStatus.Active),
                onClose = {},
                onSubmit = { _, _ -> null },
                onArchive = { null },
                removalOptions = { KinRemovalOptions(canDelete = false) },
                onDelete = { null },
                onRequestRemoval = { Result.success(request()) },
            )
        }
        waitForIdle()
        onNodeWithText("Request removal").assertExists()
        onNodeWithText("Delete this Kin").assertDoesNotExist()
    }

    @Test
    fun edit_noHistory_neverShowsRequestRemoval() = runComposeUiTest {
        setThemedContent {
            AddEditKinDialog(
                initial = kin(KinStatus.Active),
                onClose = {},
                onSubmit = { _, _ -> null },
                onArchive = { null },
                removalOptions = { KinRemovalOptions(canDelete = true) },
                onDelete = { null },
                onRequestRemoval = { Result.success(request()) },
            )
        }
        waitForIdle()
        onNodeWithText("Delete this Kin").assertExists()
        onNodeWithText("Request removal").assertDoesNotExist()
    }

    @Test
    fun edit_showsALoadingCueWhileTheCheckRuns() = runComposeUiTest {
        val answer = CompletableDeferred<KinRemovalOptions>()
        setThemedContent {
            AddEditKinDialog(
                initial = kin(KinStatus.Active),
                onClose = {},
                onSubmit = { _, _ -> null },
                onArchive = { null },
                removalOptions = { answer.await() },
                onDelete = { null },
                onRequestRemoval = { Result.success(request()) },
            )
        }
        waitForIdle()
        onNodeWithText("Checking removal options…").assertExists()
        onNodeWithText("Request removal").assertDoesNotExist()
        answer.complete(KinRemovalOptions(canDelete = false))
        waitForIdle()
        onNodeWithText("Checking removal options…").assertDoesNotExist()
        onNodeWithText("Request removal").assertExists()
    }

    @Test
    fun edit_failedCheck_retries() = runComposeUiTest {
        var attempts = 0
        setThemedContent {
            AddEditKinDialog(
                initial = kin(KinStatus.Active),
                onClose = {},
                onSubmit = { _, _ -> null },
                onArchive = { null },
                removalOptions = {
                    attempts += 1
                    if (attempts == 1) throw IllegalStateException("network")
                    KinRemovalOptions(canDelete = false)
                },
                onDelete = { null },
                onRequestRemoval = { Result.success(request()) },
            )
        }
        waitForIdle()
        onNodeWithText("Try again").performScrollTo().performClick()
        waitForIdle()
        assertEquals(2, attempts)
        onNodeWithText("Couldn't check how this Kin can be removed.").assertDoesNotExist()
        onNodeWithText("Request removal").assertExists()
    }

    @Test
    fun edit_requestRemoval_asksFirst_neverMindSendsNothing() = runComposeUiTest {
        var sent = false
        setThemedContent {
            AddEditKinDialog(
                initial = kin(KinStatus.Active),
                onClose = {},
                onSubmit = { _, _ -> null },
                onArchive = { null },
                removalOptions = { KinRemovalOptions(canDelete = false) },
                onDelete = { null },
                onRequestRemoval = { sent = true; Result.success(request()) },
            )
        }
        waitForIdle()
        onNodeWithText("Request removal").performScrollTo().performClick()
        waitForIdle()
        onNodeWithText("Ask to have Biscuit removed? Visits, invoices and KinTales on file are kept.").assertExists()
        onNodeWithText("Reason (optional)").assertExists()
        onNodeWithText("Never mind").performScrollTo().performClick()
        waitForIdle()
        onNodeWithText("Send request").assertDoesNotExist()
        onNodeWithText("Request removal").assertExists()
        assertFalse(sent)
    }

    @Test
    fun edit_requestRemoval_waitsOnTheServer_thenShowsPending() = runComposeUiTest {
        val answer = CompletableDeferred<Result<KinRemovalRequest>>()
        var sentReason: String? = null
        var closed = false
        setThemedContent {
            AddEditKinDialog(
                initial = kin(KinStatus.Active),
                onClose = { closed = true },
                onSubmit = { _, _ -> null },
                onArchive = { null },
                removalOptions = { KinRemovalOptions(canDelete = false) },
                onDelete = { null },
                onRequestRemoval = { reason -> sentReason = reason; answer.await() },
            )
        }
        waitForIdle()
        onNodeWithText("Request removal").performScrollTo().performClick()
        waitForIdle()
        onNodeWithTag("kin-removal-reason").performScrollTo().performTextInput("Rehomed with my sister")
        onNodeWithText("Send request").performScrollTo().performClick()
        waitForIdle()
        assertEquals("Rehomed with my sister", sentReason)
        // Pessimistic: a busy label, and no pending state until the server answers.
        onNodeWithText("Sending…").assertExists()
        onNodeWithText("Removal requested", substring = true).assertDoesNotExist()
        answer.complete(Result.success(request(reason = "Rehomed with my sister")))
        waitForIdle()
        onNodeWithText("Removal requested on ${removalDateLabel(nov2)}.").assertExists()
        onNodeWithText("Your reason: Rehomed with my sister").assertExists()
        onNodeWithText("Request removal").assertDoesNotExist()
        onNodeWithText("Send request").assertDoesNotExist()
        assertFalse(closed)
    }

    @Test
    fun edit_pendingRequest_showsItsDate_andNothingToTap() = runComposeUiTest {
        setThemedContent {
            AddEditKinDialog(
                initial = kin(KinStatus.Active),
                onClose = {},
                onSubmit = { _, _ -> null },
                onArchive = { null },
                removalOptions = { KinRemovalOptions(canDelete = false, request = request()) },
                onDelete = { null },
                onRequestRemoval = { Result.success(request()) },
            )
        }
        waitForIdle()
        onNodeWithText("Removal requested on ${removalDateLabel(nov2)}.").assertExists()
        onNodeWithText("Request removal").assertDoesNotExist()
    }

    @Test
    fun edit_declinedRequest_showsTheNote_andAsksAgain() = runComposeUiTest {
        setThemedContent {
            AddEditKinDialog(
                initial = kin(KinStatus.Active),
                onClose = {},
                onSubmit = { _, _ -> null },
                onArchive = { null },
                removalOptions = {
                    KinRemovalOptions(
                        canDelete = false,
                        request = request(status = "declined", resolvedAtMs = nov3, note = "Biscuit has a visit booked next week."),
                    )
                },
                onDelete = { null },
                onRequestRemoval = { Result.success(request()) },
            )
        }
        waitForIdle()
        onNodeWithText("Removal declined on ${removalDateLabel(nov3)}. Biscuit has a visit booked next week.").assertExists()
        onNodeWithText("Request removal").assertExists()
    }

    @Test
    fun edit_refusedRequest_showsTheServerSentence() = runComposeUiTest {
        setThemedContent {
            AddEditKinDialog(
                initial = kin(KinStatus.Active),
                onClose = {},
                onSubmit = { _, _ -> null },
                onArchive = { null },
                removalOptions = { KinRemovalOptions(canDelete = false) },
                onDelete = { null },
                onRequestRemoval = { Result.failure(IllegalStateException("Removal of Biscuit has already been requested.")) },
            )
        }
        waitForIdle()
        onNodeWithText("Request removal").performScrollTo().performClick()
        waitForIdle()
        onNodeWithText("Send request").performScrollTo().performClick()
        waitForIdle()
        onNodeWithText("Removal of Biscuit has already been requested.").assertExists()
        onNodeWithText("Send request").assertExists()
    }
}
