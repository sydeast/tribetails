package com.tribetails.auntieos.web.screens.settings
import com.tribetails.auntieos.web.data.BusinessSettings
import com.tribetails.auntieos.web.data.HomeSectionCfg
import com.tribetails.auntieos.web.data.MyTribePortalConfig
import com.tribetails.auntieos.web.data.PortalHome
import com.tribetails.auntieos.web.data.SettingsChecks
import com.tribetails.auntieos.web.data.businessSettingsSaveChanges
import kotlinx.serialization.json.Json
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue
/**
 * #1783: a value already stored that the checks would refuse shows its sentence
 * from the moment a panel opens, and holds Save back only when its field is part
 * of the save, the way `saveBusinessSettings` checks `changes`. Typed values are
 * still refused beside the field.
 */
class StoredBadValueTest {
    private val codec = Json { encodeDefaults = true; ignoreUnknownKeys = true; isLenient = true }
    private val days = listOf("Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday")
    // ── Business profile ────────────────────────────────────────────────────
    @Test
    fun `a stored bad email shows its sentence on open and does not block a different edit`() {
        val stored = "not an email"
        val problem = SettingsChecks.businessEmailProblem(stored)
        assertNotNull(problem) // visible beside the field as the panel opens
        // Untouched: not part of the save.
        assertFalse(SettingsChecks.blocksSave(problem, current = stored, stored = stored))
    }
    @Test
    fun `editing the stored bad email to another bad value is refused, to a good one saves`() {
        val stored = "not an email"
        val another = "still not"
        assertTrue(SettingsChecks.blocksSave(SettingsChecks.businessEmailProblem(another), another, stored))
        val good = "hello@tribetails.com"
        assertFalse(SettingsChecks.blocksSave(SettingsChecks.businessEmailProblem(good), good, stored))
    }
    @Test
    fun `a stored blank business name blocks every profile save, because the server checks the name each time`() {
        val problem = "Enter the business name."
        assertTrue(SettingsChecks.blocksSave(problem, current = "", stored = "", alwaysChecked = true))
    }
    @Test
    fun `the payload carries the edited field and leaves the stored bad email out`() {
        val loaded = BusinessSettings(businessName = "Tribe Tails", businessEmail = "not an email")
        val edited = loaded.copy(businessPhone = "(512) 555-0199")
        val changes = businessSettingsSaveChanges(loaded, edited, codec)
        assertEquals(setOf("businessPhone"), changes.keys)
    }
    // ── Business hours ──────────────────────────────────────────────────────
    private val storedHours = mapOf("Monday" to "17:00-09:00", "Tuesday" to "09:00-17:00")
    @Test
    fun `a stored bad day shows its sentence and does not block an edit to another day`() {
        assertNotNull(SettingsChecks.weekdayHoursProblem(storedHours.getValue("Monday")))
        val edited = storedHours + ("Wednesday" to "09:00-17:00")
        assertEquals(listOf("Wednesday"), SettingsChecks.changedDays(storedHours, edited, days))
        assertFalse(SettingsChecks.hoursBlockSave(storedHours, edited, days))
        // And only that day travels.
        val loaded = BusinessSettings(businessHours = storedHours)
        val changes = businessSettingsSaveChanges(loaded, loaded.copy(businessHours = edited), codec)
        assertEquals(setOf("businessHours"), changes.keys)
        assertEquals("""{"Wednesday":"09:00-17:00"}""", changes.getValue("businessHours").toString())
    }
    @Test
    fun `editing the stored bad day to another bad value is refused, to a good one saves`() {
        assertTrue(SettingsChecks.hoursBlockSave(storedHours, storedHours + ("Monday" to "18:00-09:00"), days))
        assertFalse(SettingsChecks.hoursBlockSave(storedHours, storedHours + ("Monday" to "08:00-09:00"), days))
    }
    // ── KinCare types ───────────────────────────────────────────────────────
    private val storedCard = BusinessSettings(serviceRates = mapOf("Walk" to "abc", "Overnight" to "80.00"))
    @Test
    fun `a stored bad price shows its sentence, and a length edit saves without sending the rates`() {
        val rows = kinCareRows(storedCard.serviceRates, storedCard.serviceDurations, storedCard.serviceStartTimeBooking)
        assertNotNull(kinCareRowProblems(rows)[0].rate)
        val edited = rows.toMutableList().also { it[1] = it[1].copy(duration = "720") }
        assertFalse(kinCareProblemsBlockSave(storedCard, edited))
        val changes = businessSettingsSaveChanges(storedCard, kinCareRowsApplied(storedCard, edited), codec)
        assertEquals(setOf("serviceDurations"), changes.keys)
    }
    @Test
    fun `editing the stored bad price to another bad value is refused, to a good one saves`() {
        val rows = kinCareRows(storedCard.serviceRates, storedCard.serviceDurations, storedCard.serviceStartTimeBooking)
        assertTrue(kinCareProblemsBlockSave(storedCard, rows.toMutableList().also { it[0] = it[0].copy(rate = "abcd") }))
        assertFalse(kinCareProblemsBlockSave(storedCard, rows.toMutableList().also { it[0] = it[0].copy(rate = "25") }))
    }
    // ── Booking rules ───────────────────────────────────────────────────────
    private val storedBuffer = BusinessSettings(
        travelBufferMinutes = 9999,
        allowTimeBlockBooking = false,
    )
    private fun bookingError(s: BusinessSettings, buffer: String, allowSpecific: Boolean = true): String? {
        val edits = bookingRulesEdits(
            s, s.defaultBookingMode, s.defaultCalendarView, allowSpecific, s.allowTimeBlockBooking,
            s.defaultTimeBlockDurationHours.toString(), buffer, emptyList(),
        )
        return bookingRulesError(
            s.defaultBookingMode, allowSpecific, s.allowTimeBlockBooking,
            s.defaultTimeBlockDurationHours.toString(), buffer, emptyList(), s.timeZone, zoneUsable = true, only = edits,
        )
    }
    @Test
    fun `a stored bad travel buffer shows its sentence and does not block saving the other fields`() {
        assertNotNull(SettingsChecks.wholeNumberProblem("9999", 0, 480, "minutes"))
        // The buffer text is as stored, so it is not part of the save.
        assertNull(bookingError(storedBuffer, buffer = "9999"))
        // The whole draft, as the banner reads it, still names it.
        assertNotNull(
            bookingRulesError("SPECIFIC_TIME", true, false, "4", "9999", emptyList(), "", zoneUsable = true),
        )
    }
    @Test
    fun `typing another bad buffer is refused and a good one saves`() {
        assertNotNull(bookingError(storedBuffer, buffer = "9000"))
        assertNull(bookingError(storedBuffer, buffer = "45"))
    }
    @Test
    fun `two stored booking modes both off do not block an unrelated edit, but changing a mode does`() {
        val bothOff = BusinessSettings(allowSpecificTimeBooking = false, allowTimeBlockBooking = false)
        assertNull(bookingError(bothOff, buffer = bothOff.travelBufferMinutes.toString(), allowSpecific = false))
    }
    // ── Visits and tracking ─────────────────────────────────────────────────
    @Test
    fun `a stored radius out of range shows, does not block another field, and is refused when retyped badly`() {
        val s = BusinessSettings(arrivalRadiusMeters = 3)
        val asStored = visitRecordsEdits(s, s.saveRoutesForDays.toString(), "5, 10", "30", "3")
        assertFalse(asStored.arrivalRadius)
        assertNull(visitRecordsError(s.saveRoutesForDays.toString(), "5, 10", "30", "3", asStored))
        assertNotNull(visitRecordsError(s.saveRoutesForDays.toString(), "5, 10", "30", "3")) // the banner still names it
        val retyped = visitRecordsEdits(s, s.saveRoutesForDays.toString(), "5, 10", "30", "9")
        assertNotNull(visitRecordsError(s.saveRoutesForDays.toString(), "5, 10", "30", "9", retyped))
        val fixed = visitRecordsEdits(s, s.saveRoutesForDays.toString(), "5, 10", "30", "300")
        assertNull(visitRecordsError(s.saveRoutesForDays.toString(), "5, 10", "30", "300", fixed))
    }
    // ── MyTribe portal ──────────────────────────────────────────────────────
    private fun portalWith(limit: Int) = MyTribePortalConfig(
        home = PortalHome(sections = listOf(HomeSectionCfg(id = "upNext", enabled = true, limit = limit))),
    )
    @Test
    fun `a stored negative limit does not block a banner edit but blocks a change to the layout`() {
        val loaded = portalWith(-2)
        assertTrue(portalLimitsAllowSave(loaded, loaded.copy(chat = loaded.chat.copy(enabled = !loaded.chat.enabled)), emptyMap()))
        val moved = loaded.copy(home = PortalHome(sections = listOf(HomeSectionCfg("upNext", false, -2))))
        assertFalse(portalLimitsAllowSave(loaded, moved, emptyMap()))
    }
    @Test
    fun `a typed limit that does not read blocks, and a good one saves`() {
        val loaded = portalWith(-2)
        assertFalse(portalLimitsAllowSave(loaded, loaded, mapOf("upNext" to "abc")))
        assertTrue(portalLimitsAllowSave(loaded, portalWith(5), mapOf("upNext" to "5")))
    }

    // ── KinTale template: the write leaves an untouched checklist out ───────
    @Test
    fun `a title-only edit of a template with a stored blank item writes only the title`() {
        val blank = com.tribetails.auntieos.web.data.ChecklistItem(key = "old", text = "  ", scope = "PER_PET", order = 1)
        val loaded = com.tribetails.auntieos.web.data.KinTaleTemplate(_id = "t1", name = "Walk", checklistItems = listOf(blank))
        val edited = loaded.copy(name = "Evening walk")
        val changes = com.tribetails.auntieos.web.data.modelChanges(
            com.tribetails.auntieos.web.data.KinTaleTemplate.serializer(), loaded, edited,
        )
        assertEquals(listOf(listOf("name")), changes.map { it.path })
    }
}
