package com.tribetails.auntieos.ui.admin.scheduling

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.LocalDate
import java.time.ZoneId

/**
 * D1: the five-step wizard's state machine. Every step's gate, the happy path,
 * and the sad/negative cases, exercised on the pure model rather than through
 * Compose, so a broken gate fails here rather than in a screenshot.
 */
class BookingWizardTest {

    private val monday = LocalDate.of(2027, 8, 2)
    private val tuesday = LocalDate.of(2027, 8, 3)

    /** Well before any date under test, so nothing trips the in-the-future gate. */
    private val now = LocalDate.of(2027, 1, 1)
        .atStartOfDay(ZoneId.systemDefault()).toInstant().toEpochMilli()

    private fun readyState(): BookingWizardState =
        BookingWizardState(kinfolkId = "kf1")
            .withServiceName("Dog Walking")
            .toggleDate(monday)

    // -----------------------------------------------------------------------
    // Step 1: kinfolk + kin
    // -----------------------------------------------------------------------

    @Test
    fun `step 1 blocks with no household and clears once one is picked`() {
        val empty = BookingWizardState()
        assertEquals(
            "Pick a household first.",
            stepBlocker(empty, BookingWizardStep.CLIENT, now),
        )
        assertNull(stepBlocker(empty.withKinfolk("kf1"), BookingWizardStep.CLIENT, now))
    }

    @Test
    fun `changing household drops the previous household's kin`() {
        val state = BookingWizardState()
            .withKinfolk("kf1")
            .toggleKin("kin-a")
            .toggleKin("kin-b")
        assertEquals(listOf("kin-a", "kin-b"), state.kinIds)

        val moved = state.withKinfolk("kf2")
        assertEquals(emptyList<String>(), moved.kinIds)
    }

    @Test
    fun `re-picking the same household keeps the kin already chosen`() {
        val state = BookingWizardState().withKinfolk("kf1").toggleKin("kin-a")
        assertEquals(listOf("kin-a"), state.withKinfolk("kf1").kinIds)
    }

    @Test
    fun `toggling a kin twice removes it`() {
        val state = BookingWizardState().toggleKin("kin-a").toggleKin("kin-a")
        assertEquals(emptyList<String>(), state.kinIds)
    }

    // -----------------------------------------------------------------------
    // Step 2: service
    // -----------------------------------------------------------------------

    @Test
    fun `step 2 blocks with no service and seeds every template row once picked`() {
        val state = BookingWizardState(kinfolkId = "kf1").addTemplateSlot()
        assertEquals(
            "Pick a service first.",
            stepBlocker(state, BookingWizardStep.SERVICE, now),
        )

        val picked = state.withServiceName("Dog Walking")
        assertNull(stepBlocker(picked, BookingWizardStep.SERVICE, now))
        assertEquals(2, picked.template.size)
        assertTrue(picked.template.all { it.serviceName == "Dog Walking" })
        // A serviceRates KEY is a name, not a base_services id: sending it would
        // make the server's resolveService log a miss on every visit.
        assertTrue(picked.template.all { it.serviceId == null })
    }

    @Test
    fun `a day already snapshotted keeps its service when the header service changes`() {
        val state = readyState().withServiceName("Overnight")
        // The template moved on; the picked day did not, which is the documented
        // "changes apply only to dates you pick after this" behavior.
        assertEquals("Overnight", state.template.single().serviceName)
        assertEquals("Dog Walking", buildVisits(state).single().serviceName)
    }

    // -----------------------------------------------------------------------
    // Step 3: dates
    // -----------------------------------------------------------------------

    @Test
    fun `step 3 blocks with no dates and says so differently per mode`() {
        val base = BookingWizardState(kinfolkId = "kf1").withServiceName("Dog Walking")
        assertEquals(
            "Pick at least one date.",
            stepBlocker(base, BookingWizardStep.DATES, now),
        )
        assertEquals(
            "Pick a start date and at least one weekday.",
            stepBlocker(base.copy(mode = BookingWizardMode.WEEKLY), BookingWizardStep.DATES, now),
        )
    }

    @Test
    fun `step 3 blocks a visit with a blank service`() {
        val state = BookingWizardState(kinfolkId = "kf1").toggleDate(monday)
        assertEquals(
            "Every visit needs a service.",
            stepBlocker(state, BookingWizardStep.DATES, now),
        )
    }

    @Test
    fun `step 3 blocks a visit in the past`() {
        val state = readyState()
        val afterEveryVisit = buildVisits(state).maxOf { it.startTimeMs } + 120_000L
        assertEquals(
            "Every visit has to be in the future.",
            stepBlocker(state, BookingWizardStep.DATES, afterEveryVisit),
        )
    }

    @Test
    fun `step 3 blocks past the 60-visit ceiling and names the count`() {
        // 7 weekdays x 12 weeks = 84 concrete visits, well past the callable's cap.
        val state = BookingWizardState(kinfolkId = "kf1")
            .withServiceName("Dog Walking")
            .copy(mode = BookingWizardMode.WEEKLY, startDate = monday, weeks = 12, weeklyDays = (0..6).toSet())
        val blocker = stepBlocker(state, BookingWizardStep.DATES, now)
        assertEquals(
            "That is 84 visits. The most a single request can carry is 60, so shorten the " +
                "recurrence or split the booking.",
            blocker,
        )
    }

    @Test
    fun `step 3 refuses a company holiday, because the server refuses it with no override`() {
        val state = readyState()
        val closed: (LocalDate) -> String? = { if (it == monday) "Founders Day" else null }
        assertEquals(
            "Aug 2 is closed for Founders Day. The business will refuse that date, so pick another.",
            stepBlocker(state, BookingWizardStep.DATES, now, closed),
        )
        // The same state with nothing closed advances.
        assertNull(stepBlocker(state, BookingWizardStep.DATES, now))
    }

    @Test
    fun `a closure in week three of a recurrence is caught, not left to the server`() {
        // Web's plannedDayIsos returns only the start date in weekly mode, so this
        // exact booking passes its gates and dies at submit, losing the batch.
        val thirdMonday = monday.plusWeeks(2)
        val state = BookingWizardState(kinfolkId = "kf1")
            .withServiceName("Dog Walking")
            .copy(mode = BookingWizardMode.WEEKLY, startDate = monday, weeks = 4, weeklyDays = setOf(1))

        assertEquals(4, plannedDates(state).size)
        assertTrue(thirdMonday in plannedDates(state))

        val closed: (LocalDate) -> String? = { if (it == thirdMonday) "Founders Day" else null }
        assertNotNull(stepBlocker(state, BookingWizardStep.DATES, now, closed))
    }

    @Test
    fun `an unnamed closure still closes the day`() {
        val state = readyState()
        val closed: (LocalDate) -> String? = { if (it == monday) "a company holiday" else null }
        assertEquals(
            "Aug 2 is closed for a company holiday. The business will refuse that date, so pick another.",
            stepBlocker(state, BookingWizardStep.DATES, now, closed),
        )
    }

    @Test
    fun `toggling a date adds it then removes it`() {
        val one = readyState()
        assertEquals(listOf(monday), one.plans.map { it.date })
        assertEquals(emptyList<LocalDate>(), one.toggleDate(monday).plans)
    }

    @Test
    fun `picked dates stay sorted whatever order they were tapped in`() {
        val state = readyState().toggleDate(monday.minusDays(3)).toggleDate(tuesday)
        assertEquals(
            listOf(monday.minusDays(3), monday, tuesday),
            state.plans.map { it.date },
        )
    }

    @Test
    fun `several visits on one day all reach the payload with their own time and place`() {
        var state = readyState()
        state = state.addDayVisit(monday)
        val second = state.plans.single().visits[1]
        state = state.updateDayVisit(monday, second.id) {
            it.copy(hour = 17, minute = 30, location = "  Back gate  ")
        }

        val visits = buildVisits(state)
        assertEquals(2, visits.size)
        assertTrue("visits must be ascending", visits[0].startTimeMs < visits[1].startTimeMs)
        assertNull("no place given means null, never an empty string", visits[0].location)
        assertEquals("Back gate", visits[1].location)
    }

    @Test
    fun `the last visit on a day cannot be removed, and neither can the last template row`() {
        val state = readyState()
        assertEquals(1, state.removeDayVisit(monday, state.plans.single().visits.single().id)
            .plans.single().visits.size)
        assertEquals(1, state.removeTemplateSlot(state.template.single().id).template.size)
    }

    @Test
    fun `a template row added after a date was picked does not touch that date`() {
        val state = readyState().addTemplateSlot()
        assertEquals(2, state.template.size)
        assertEquals(1, buildVisits(state).size)
    }

    @Test
    fun `every template row repeats on every weekly occurrence`() {
        val state = BookingWizardState(kinfolkId = "kf1")
            .withServiceName("Dog Walking")
            .copy(mode = BookingWizardMode.WEEKLY, startDate = monday, weeks = 4, weeklyDays = setOf(1, 3))
            .addTemplateSlot()
        // 2 template rows x 2 weekdays x 4 weeks.
        assertEquals(16, buildVisits(state).size)
    }

    @Test
    fun `weekly with no weekday picked plans nothing`() {
        val state = BookingWizardState(kinfolkId = "kf1")
            .withServiceName("Dog Walking")
            .copy(mode = BookingWizardMode.WEEKLY, startDate = monday, weeks = 4)
        assertEquals(emptyList<LocalDate>(), plannedDates(state))
        assertEquals(emptyList<Any>(), buildVisits(state))
    }

    @Test
    fun `toggling a weekday twice clears it`() {
        val state = BookingWizardState().toggleWeekday(1).toggleWeekday(1)
        assertEquals(emptySet<Int>(), state.weeklyDays)
    }

    // -----------------------------------------------------------------------
    // Steps 4 and 5, and the whole path
    // -----------------------------------------------------------------------

    @Test
    fun `steps 4 and 5 never block`() {
        val state = readyState()
        assertNull(stepBlocker(state, BookingWizardStep.INVOICE, now))
        assertNull(stepBlocker(state, BookingWizardStep.REVIEW, now))
    }

    @Test
    fun `firstBlockedStep names the earliest hole, in step order`() {
        assertEquals(
            BookingWizardStep.CLIENT,
            firstBlockedStep(BookingWizardState(), now),
        )
        assertEquals(
            BookingWizardStep.SERVICE,
            firstBlockedStep(BookingWizardState(kinfolkId = "kf1"), now),
        )
        assertEquals(
            BookingWizardStep.DATES,
            firstBlockedStep(BookingWizardState(kinfolkId = "kf1").withServiceName("Dog Walking"), now),
        )
        assertNull(firstBlockedStep(readyState(), now))
    }

    @Test
    fun `the happy path builds every payload field the callable takes`() {
        val state = readyState()
            .toggleKin("kin-a")
            .toggleDate(tuesday)
            .copy(emailConfirmation = true, timeVisibility = true, notes = "  Gate code 1234  ")

        val submission = bookingSubmission(state)

        assertEquals("kf1", submission.kinfolkId)
        assertEquals(listOf("kin-a"), submission.kinIds)
        assertEquals("individual", submission.pattern)
        assertNull("weeklyDays is omitted outside weekly mode", submission.weeklyDays)
        assertEquals(2, submission.visits.size)
        assertTrue(submission.visits.all { it.serviceName == "Dog Walking" })
        assertTrue(submission.visits.all { it.endTimeMs == null })
        assertEquals("new-invoice", submission.billing.mode)
        assertTrue(submission.communication.emailConfirmation)
        assertTrue(submission.communication.timeVisibility)
        assertEquals("Gate code 1234", submission.notes)
        assertEquals(false, submission.overrideBusyConflict)
    }

    @Test
    fun `a weekly submission carries pattern and ascending weeklyDays`() {
        val state = BookingWizardState(kinfolkId = "kf1")
            .withServiceName("Dog Walking")
            .copy(mode = BookingWizardMode.WEEKLY, startDate = monday, weeks = 2)
            .toggleWeekday(5)
            .toggleWeekday(1)

        val submission = bookingSubmission(state)
        assertEquals("weekly", submission.pattern)
        assertEquals(listOf(1, 5), submission.weeklyDays)
        assertEquals(4, submission.visits.size)
    }

    @Test
    fun `blank notes travel as null, not as an empty string`() {
        assertNull(bookingSubmission(readyState().copy(notes = "   ")).notes)
    }

    @Test
    fun `the override flag is only ever set by an explicit Create anyway`() {
        assertEquals(false, bookingSubmission(readyState()).overrideBusyConflict)
        assertEquals(true, bookingSubmission(readyState(), overrideBusyConflict = true).overrideBusyConflict)
    }

    @Test
    fun `the five steps are in web's order`() {
        assertEquals(
            listOf(
                "Select Kinfolk & Kin",
                "Choose Service",
                "Schedule Dates",
                "Invoice Options",
                "Review & Confirm",
            ),
            BookingWizardStep.entries.map { it.label },
        )
        assertEquals(listOf(1, 2, 3, 4, 5), BookingWizardStep.entries.map { it.number })
        assertNull(BookingWizardStep.CLIENT.previous)
        assertNull(BookingWizardStep.REVIEW.next)
    }
}
