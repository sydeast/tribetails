package com.tribetails.auntieos.web.screens.schedule

import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.runDesktopComposeUiTest
import com.tribetails.auntieos.web.FakeAuntieDataSource
import com.tribetails.auntieos.web.data.BusinessSettings
import com.tribetails.auntieos.web.data.FirestoreClient
import com.tribetails.auntieos.web.data.JvmFirestoreFixtures
import com.tribetails.auntieos.web.data.Kinfolk
import com.tribetails.auntieos.web.screens.booking.BookingCreateScreen
import com.tribetails.auntieos.web.screens.booking.BookingViewModel
import com.tribetails.auntieos.web.theme.AuntieAppTheme
import com.tribetails.auntieos.web.theme.ThemeMode
import kotlinx.datetime.TimeZone
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * #1703: the desktop console names a visit only by a rate-card KinCare type (a
 * `business_settings.serviceRates` key), so it can be priced at invoice time.
 * Both screens that write a visit's `serviceType` used to offer hardcoded names
 * ("Pet Sitting", "Drop-In") when Settings had no rates, and BookingCreateScreen
 * started on "Pet Sitting" even after the rates arrived.
 */
@OptIn(ExperimentalTestApi::class)
class RateCardServicesRenderTest {

    @AfterTest
    fun tearDown() = JvmFirestoreFixtures.clear()

    private val fallbackNames = listOf("Pet Sitting", "Dog Walking", "Overnight", "Daycare", "Drop-In")

    @Test
    fun `the catalog is the rate-card keys, trimmed and shortest first, with nothing invented`() {
        assertEquals(listOf("30Minute", "1Hr", "Consultation"), rateCardServiceTypes(mapOf("Consultation" to "", " 1Hr " to "40", "30Minute" to "25", " " to "9")))
        assertEquals(emptyList(), rateCardServiceTypes(emptyMap()))
        assertEquals(emptyList(), rateCardServiceTypes(null))
    }

    @Test
    fun `New visit says there are no KinCare types instead of offering invented ones`() = runDesktopComposeUiTest {
        JvmFirestoreFixtures.kinfolk = listOf(Kinfolk(_id = "kf1", firstName = "Ada", lastName = "Wren"))
        JvmFirestoreFixtures.businessSettings = BusinessSettings(serviceRates = emptyMap())
        setContent {
            AuntieAppTheme(themeMode = ThemeMode.DARK) {
                NewVisitDialog(client = FirestoreClient(), localZone = TimeZone.UTC, onDismiss = {}, onCreated = {})
            }
        }
        waitUntil(timeoutMillis = 10_000) {
            onAllNodesWithText(NO_KINCARE_TYPES_MESSAGE, useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty()
        }
        assertTrue(onAllNodesWithText("Service *", useUnmergedTree = true).fetchSemanticsNodes().isEmpty())
    }

    @Test
    fun `New booking offers the rate-card keys and no invented names`() = runDesktopComposeUiTest {
        JvmFirestoreFixtures.kinfolk = listOf(Kinfolk(_id = "kf1", firstName = "Ada", lastName = "Wren"))
        JvmFirestoreFixtures.businessSettings = BusinessSettings(serviceRates = mapOf("1Hr" to "40", "30Minute" to "25"))
        setContent {
            AuntieAppTheme(themeMode = ThemeMode.DARK) {
                BookingCreateScreen(vm = BookingViewModel(FakeAuntieDataSource()), onBack = {})
            }
        }
        waitUntil(timeoutMillis = 10_000) {
            onAllNodesWithText("30Minute", substring = true, useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty()
        }
        assertTrue(onAllNodesWithText("1Hr", substring = true, useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty())
        for (name in fallbackNames) {
            assertTrue(
                onAllNodesWithText(name, useUnmergedTree = true).fetchSemanticsNodes().isEmpty(),
                "\"$name\" is not a rate-card key and must not be offered",
            )
        }
    }

    @Test
    fun `New booking says there are no KinCare types instead of offering invented ones`() = runDesktopComposeUiTest {
        JvmFirestoreFixtures.kinfolk = listOf(Kinfolk(_id = "kf1", firstName = "Ada", lastName = "Wren"))
        JvmFirestoreFixtures.businessSettings = BusinessSettings(serviceRates = emptyMap())
        setContent {
            AuntieAppTheme(themeMode = ThemeMode.DARK) {
                BookingCreateScreen(vm = BookingViewModel(FakeAuntieDataSource()), onBack = {})
            }
        }
        waitUntil(timeoutMillis = 10_000) {
            onAllNodesWithText(NO_KINCARE_TYPES_MESSAGE, useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty()
        }
        for (name in fallbackNames) {
            assertTrue(onAllNodesWithText(name, useUnmergedTree = true).fetchSemanticsNodes().isEmpty(), "\"$name\" offered")
        }
    }
}
