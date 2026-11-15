package com.tribetails.auntieos.ui.admin

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import com.tribetails.auntieos.data.model.BookingMode
import com.tribetails.auntieos.data.model.EnhancedBooking
import com.tribetails.auntieos.data.model.Kinfolk
import com.tribetails.auntieos.domain.RosterKin
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
 * #1822, operator ruling 2026-11-12: every visit covers every Kin. The
 * Schedule's New Booking form names the household's Kin and has no picker,
 * unless the "Visits: choose Kin" flag is on, when each Kin is a chip and all
 * start chosen.
 */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [35], qualifiers = "w1080dp-h4000dp-xhdpi")
class AddEnhancedBookingDialogKinTest {

    @get:Rule
    val rule = createComposeRule()

    private val today = LocalDate.of(2026, 11, 6)
    private val household = Kinfolk(id = "fam1", firstName = "Wanda", lastName = "Thorne")
    private val home = listOf(RosterKin("k1", "Biscuit"), RosterKin("k2", "Gravy"))

    private var saved: EnhancedBooking? = null
    private var recorded: RecordCompletedVisit? = null
    private val asked = mutableListOf<String?>()

    private fun mount(
        chooseKin: Boolean,
        kin: List<RosterKin> = home,
        kinError: String? = null,
        kinLoading: Boolean = false,
        initialDate: LocalDate = today.plusDays(7),
    ) {
        rule.setContent {
            AuntieOSTheme {
                AddEnhancedBookingDialog(
                    serviceRates = mapOf("30Minute" to "25"),
                    allKinfolk = listOf(household),
                    bookingMode = BookingMode.SPECIFIC_TIME,
                    initialDate = initialDate,
                    onDismiss = {},
                    onSave = { booking, _, _ -> saved = booking },
                    onHouseholdPicked = { asked += it },
                    kin = kin,
                    kinLoading = kinLoading,
                    kinError = kinError,
                    chooseKin = chooseKin,
                    onRecordCompleted = { recorded = it },
                    now = { LocalDateTime.of(today, java.time.LocalTime.of(12, 0)) },
                )
            }
        }
    }

    private fun pickHousehold() {
        rule.onNodeWithText("Select…").performClick()
        rule.onNodeWithText("Wanda Thorne").performClick()
        rule.waitForIdle()
    }

    private fun shown(text: String): Boolean = rule.onAllNodes(hasText(text)).fetchSemanticsNodes().isNotEmpty()

    @Test
    fun `nothing about Kin is drawn before a household is picked`() {
        mount(chooseKin = true)
        assertTrue(!shown("Kin covered"))
    }

    @Test
    fun `picking a household asks for its Kin`() {
        mount(chooseKin = false)
        pickHousehold()
        assertEquals("fam1", asked.last())
    }

    @Test
    fun `choosing off - names every Kin, offers nothing to tap, and the visit names no Kin`() {
        mount(chooseKin = false)
        pickHousehold()
        rule.onNodeWithText("All Kin in this home").assertIsDisplayed()
        rule.onNodeWithText("Biscuit, Gravy").assertIsDisplayed()
        assertTrue("no chip per Kin while choosing is off", !shown("Biscuit"))
        rule.onNodeWithText("Save Draft").performClick()
        // Empty is every Kin: the server stores the whole roster for it.
        assertEquals(emptyList<String>(), saved?.kinIds)
    }

    @Test
    fun `choosing on - every Kin starts chosen, and left alone the visit names no Kin`() {
        mount(chooseKin = true)
        pickHousehold()
        rule.onNodeWithText("Biscuit").assertIsDisplayed()
        rule.onNodeWithText("Gravy").assertIsDisplayed()
        rule.onNodeWithText("Save Draft").performClick()
        assertEquals(emptyList<String>(), saved?.kinIds)
    }

    @Test
    fun `choosing on - a Kin tapped off is left off the visit`() {
        mount(chooseKin = true)
        pickHousehold()
        rule.onNodeWithText("Biscuit").performClick()
        rule.onNodeWithText("Save Draft").performClick()
        assertEquals(listOf("k2"), saved?.kinIds)
    }

    @Test
    fun `choosing on - with every Kin tapped off it says so and books nothing`() {
        mount(chooseKin = true)
        pickHousehold()
        rule.onNodeWithText("Biscuit").performClick()
        rule.onNodeWithText("Gravy").performClick()
        rule.waitForIdle()
        assertTrue(shown("Choose at least one Kin."))
        rule.onNodeWithText("Save Draft").performClick()
        assertNull(saved)
    }

    @Test
    fun `choosing on - a completed visit is recorded for the Kin left chosen`() {
        mount(chooseKin = true, initialDate = today.minusDays(2))
        pickHousehold()
        rule.onNodeWithText("Gravy").performClick()
        rule.onNodeWithText("Record completed visit").performClick()
        assertEquals(listOf("k1"), recorded?.kinIds)
    }

    @Test
    fun `when the Kin cannot be loaded it says so, and the visit can still be saved for the whole home`() {
        mount(
            chooseKin = false,
            kin = emptyList(),
            kinError = "The Kin of this household could not be loaded. The visit still covers every Kin in the home.",
        )
        pickHousehold()
        assertTrue(shown("The Kin of this household could not be loaded. The visit still covers every Kin in the home."))
        rule.onNodeWithText("Save Draft").performClick()
        assertEquals(emptyList<String>(), saved?.kinIds)
    }

    @Test
    fun `while the Kin are on their way it says so`() {
        mount(chooseKin = false, kin = emptyList(), kinLoading = true)
        pickHousehold()
        assertTrue(shown("Loading this household's Kin…"))
    }
}
