@file:OptIn(androidx.compose.ui.test.ExperimentalTestApi::class)

package com.kinfolk.portal.screens.kin

import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.runComposeUiTest
import com.kinfolk.portal.portal.Kin
import com.kinfolk.portal.portal.KinStatus
import com.kinfolk.portal.screens.setThemedContent
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * #1311: the memorial action lives at the foot of the edit dialog, behind a
 * confirm step, and nowhere on the Add dialog. Restore sits in the same slot
 * for a memorial Kin.
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
}
