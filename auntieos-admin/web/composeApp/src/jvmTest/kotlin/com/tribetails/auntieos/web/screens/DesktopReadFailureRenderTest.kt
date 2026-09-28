package com.tribetails.auntieos.web.screens

import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.runDesktopComposeUiTest
import com.tribetails.auntieos.web.FakeAuntieDataSource
import com.tribetails.auntieos.web.data.FirestoreClient
import com.tribetails.auntieos.web.data.JvmFirestoreFixtures
import com.tribetails.auntieos.web.data.Kin
import com.tribetails.auntieos.web.data.Kinfolk
import com.tribetails.auntieos.web.screens.booking.BookingCreateScreen
import com.tribetails.auntieos.web.screens.booking.BookingViewModel
import com.tribetails.auntieos.web.screens.directory.KinViewScreen
import com.tribetails.auntieos.web.screens.invoices.NewInvoiceDialog
import com.tribetails.auntieos.web.screens.media.GalleryScreen
import com.tribetails.auntieos.web.screens.schedule.NewVisitDialog
import com.tribetails.auntieos.web.theme.AuntieAppTheme
import com.tribetails.auntieos.web.theme.ThemeMode
import com.tribetails.auntieos.web.ui.components.LOAD_ERROR_RETRY_TAG
import com.tribetails.auntieos.web.ui.components.NOT_FOUND_TAG
import kotlinx.datetime.TimeZone
import kotlin.test.AfterTest
import kotlin.test.Test

/**
 * #898: screens whose failed read used to render as an empty state ("no kinfolk
 * on file", "no media uploaded yet") or a false "couldn't be found", with no way
 * to tell that apart from a genuinely empty or missing record. Each test opens
 * with no fixture, which fails at the token check (no signed-in user in a jvm
 * test), and asserts the screen shows a real error, not the empty-state copy.
 * Where the underlying stream honors a fixture ([JvmFirestoreFixtures.kinfolk]
 * and `.kinByKinfolk`), the test also supplies it, presses Retry, and checks the
 * screen recovers to its real (possibly still-empty) state.
 */
@OptIn(ExperimentalTestApi::class)
class DesktopReadFailureRenderTest {

    @AfterTest
    fun tearDown() = JvmFirestoreFixtures.clear()

    @Test
    fun newVisitDialogShowsAnErrorInsteadOfNoKinfolkOnFile() = runDesktopComposeUiTest {
        setContent {
            AuntieAppTheme(themeMode = ThemeMode.DARK) {
                NewVisitDialog(client = FirestoreClient(), localZone = TimeZone.currentSystemDefault(), onDismiss = {}, onCreated = {})
            }
        }
        waitUntil(timeoutMillis = 10_000) { onAllNodesWithText("Couldn't load kinfolk", useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty() }
        assert(onAllNodesWithText("No kinfolk on file to schedule for.", useUnmergedTree = true).fetchSemanticsNodes().isEmpty()) {
            "the empty-kinfolk copy must not show while the read is failed"
        }

        JvmFirestoreFixtures.kinfolk = emptyList()
        onNodeWithTag(LOAD_ERROR_RETRY_TAG, useUnmergedTree = true).performClick()
        waitUntil(timeoutMillis = 10_000) { onAllNodesWithText("No kinfolk on file to schedule for.", useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty() }
    }

    @Test
    fun newInvoiceDialogShowsAnErrorInsteadOfAnEmptyHouseholdPicker() = runDesktopComposeUiTest {
        setContent {
            AuntieAppTheme(themeMode = ThemeMode.DARK) {
                NewInvoiceDialog(visible = true, client = FirestoreClient(), onDismiss = {}, onConfirm = {})
            }
        }
        waitUntil(timeoutMillis = 10_000) { onAllNodesWithText("Couldn't load households", useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty() }

        JvmFirestoreFixtures.kinfolk = listOf(Kinfolk(_id = "kf1", firstName = "Ada", lastName = "Wren"))
        onNodeWithTag(LOAD_ERROR_RETRY_TAG, useUnmergedTree = true).performClick()
        waitUntil(timeoutMillis = 10_000) { onAllNodesWithText("Couldn't load households", useUnmergedTree = true).fetchSemanticsNodes().isEmpty() }
    }

    @Test
    fun bookingCreateScreenShowsAnErrorInsteadOfAnEmptyKinfolkPicker() = runDesktopComposeUiTest {
        setContent {
            AuntieAppTheme(themeMode = ThemeMode.DARK) {
                BookingCreateScreen(vm = BookingViewModel(FakeAuntieDataSource()), onBack = {})
            }
        }
        waitUntil(timeoutMillis = 10_000) { onAllNodesWithText("Couldn't load kinfolk", useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty() }

        JvmFirestoreFixtures.kinfolk = listOf(Kinfolk(_id = "kf1", firstName = "Ada", lastName = "Wren"))
        onNodeWithTag(LOAD_ERROR_RETRY_TAG, useUnmergedTree = true).performClick()
        waitUntil(timeoutMillis = 10_000) { onAllNodesWithText("Couldn't load kinfolk", useUnmergedTree = true).fetchSemanticsNodes().isEmpty() }
    }

    /**
     * platformAllMediaStream has no test fixture (only the failure path is
     * reachable without a real Firestore emulator), so this pins the "shows an
     * error" half of the fix only.
     */
    @Test
    fun galleryScreenShowsAnErrorInsteadOfNoMediaUploadedYet() = runDesktopComposeUiTest {
        setContent {
            AuntieAppTheme(themeMode = ThemeMode.DARK) {
                GalleryScreen()
            }
        }
        waitUntil(timeoutMillis = 10_000) { onAllNodesWithText("Couldn't load media", useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty() }
        assert(onAllNodesWithText("No media uploaded yet. Photos and videos from KinTales show up here.", useUnmergedTree = true).fetchSemanticsNodes().isEmpty()) {
            "the empty-gallery copy must not show while the read is failed"
        }
    }

    @Test
    fun kinViewScreenShowsAnErrorRatherThanCouldntBeFound() = runDesktopComposeUiTest {
        setContent {
            AuntieAppTheme(themeMode = ThemeMode.DARK) {
                KinViewScreen(kinfolkId = "kf1", kinId = "k1", onBack = {}, onEdit = {})
            }
        }
        waitUntil(timeoutMillis = 10_000) { onAllNodesWithText("Couldn't load this kin", useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty() }
        assert(onAllNodesWithText("This kin couldn't be found. It may have been removed.", useUnmergedTree = true).fetchSemanticsNodes().isEmpty()) {
            "a failed read must not read as a not-found kin"
        }
    }

    /** A read that answers but does not contain this kin id is a real not-found, distinct from the error case above. */
    @Test
    fun kinViewScreenShowsNotFoundWhenTheReadAnsweredWithoutThisKin() = runDesktopComposeUiTest {
        JvmFirestoreFixtures.kinByKinfolk = mapOf("kf1" to listOf(Kin(_id = "other-kin", kinfolkId = "kf1", name = "Biscuit")))
        setContent {
            AuntieAppTheme(themeMode = ThemeMode.DARK) {
                KinViewScreen(kinfolkId = "kf1", kinId = "missing-kin", onBack = {}, onEdit = {})
            }
        }
        waitUntil(timeoutMillis = 10_000) { onAllNodesWithTag(NOT_FOUND_TAG, useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty() }
        assert(onAllNodesWithText("Couldn't load this kin", useUnmergedTree = true).fetchSemanticsNodes().isEmpty()) {
            "a resolved not-found must not also show a load error"
        }
    }
}
