package com.tribetails.auntieos.ui.admin

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import com.tribetails.auntieos.data.model.BookingMode
import com.tribetails.auntieos.data.model.EnhancedBooking
import com.tribetails.auntieos.data.model.Kinfolk
import com.tribetails.auntieos.ui.theme.AuntieOSTheme
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.time.LocalDate
import java.time.LocalDateTime

/**
 * #1703: the Schedule screen's New Booking dialog names the visit's service by
 * a rate-card KinCare type (a `business_settings.serviceRates` key), the catalog
 * web's New visit uses. Pricing is by exact name against that map
 * (`listUninvoicedSessions`), so a base service's title, which is not a key,
 * left the visit unpriceable at invoice time.
 */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [35], qualifiers = "w1080dp-h4000dp-xhdpi")
class AddEnhancedBookingDialogServiceTest {

    @get:Rule
    val rule = createComposeRule()

    private val rates = mapOf("1Hr" to "40", "30Minute" to "25")
    private val today = LocalDate.of(2026, 11, 6)
    private val household = Kinfolk(id = "fam1", firstName = "Wanda", lastName = "Thorne")

    private var saved: EnhancedBooking? = null
    private var recorded: RecordCompletedVisit? = null

    private fun mount(serviceRates: Map<String, String>, initialDate: LocalDate) {
        rule.setContent {
            AuntieOSTheme {
                AddEnhancedBookingDialog(
                    serviceRates = serviceRates,
                    allKinfolk = listOf(household),
                    bookingMode = BookingMode.SPECIFIC_TIME,
                    initialDate = initialDate,
                    onDismiss = {},
                    onSave = { booking, _ -> saved = booking },
                    onRecordCompleted = { recorded = it },
                    now = { LocalDateTime.of(today, java.time.LocalTime.of(12, 0)) },
                )
            }
        }
    }

    @Test
    fun `a new booking is named by the rate-card key, shortest first, with no base service behind it`() {
        mount(rates, today.plusDays(7))
        rule.onNodeWithText("30Minute").assertIsDisplayed()
        rule.onNodeWithText("Save Draft").performClick()
        val booking = saved ?: error("Save Draft wrote nothing")
        assertEquals("30Minute", booking.baseServiceTitle)
        assertEquals("30Minute", booking.title)
        assertEquals("", booking.baseServiceId)
    }

    @Test
    fun `the picker offers every rate-card key and writes the one picked`() {
        mount(rates, today.plusDays(7))
        rule.onNodeWithText("30Minute").performClick()
        rule.onNodeWithText("1Hr").performClick()
        rule.onNodeWithText("Save Draft").performClick()
        assertEquals("1Hr", saved?.baseServiceTitle)
    }

    @Test
    fun `a completed visit is recorded under the rate-card key`() {
        mount(rates, today.minusDays(2))
        rule.onNodeWithText("Select…").performClick()
        rule.onNodeWithText("Wanda Thorne").performClick()
        rule.onNodeWithText("Record completed visit").performClick()
        assertEquals("30Minute", recorded?.serviceType)
    }

    @Test
    fun `with no KinCare types in Settings it says so and books nothing`() {
        mount(emptyMap(), today.plusDays(7))
        rule.onNodeWithText("Save Draft").performClick()
        assertNull(saved)
        val said = rule.onAllNodes(hasText(NO_KINCARE_TYPES_MESSAGE)).fetchSemanticsNodes().size
        assertTrue("the dialog must say why nothing can be booked", said >= 1)
    }
}
