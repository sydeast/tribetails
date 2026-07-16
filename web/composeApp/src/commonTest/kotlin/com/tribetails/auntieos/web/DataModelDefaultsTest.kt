package com.tribetails.auntieos.web

import com.tribetails.auntieos.web.data.BUSINESS_SETTINGS_DOC_ID
import com.tribetails.auntieos.web.data.BusinessSettings
import com.tribetails.auntieos.web.data.Invoice
import com.tribetails.auntieos.web.data.KinCareSession
import com.tribetails.auntieos.web.data.Kinfolk
import com.tribetails.auntieos.web.data.TimeBlockDefinition
import kotlinx.serialization.json.Json
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * Tests for data model defaults and computed properties.
 * These guard against accidental field regressions in the production models.
 */
class DataModelDefaultsTest {

    // ---- Invoice ----

    @Test
    fun invoice_defaultAmountDue_isZero() {
        val invoice = Invoice()
        assertEquals(0.0, invoice.amountDue)
    }

    @Test
    fun invoice_defaultTotal_isZero() {
        val invoice = Invoice()
        assertEquals(0.0, invoice.total)
    }

    @Test
    fun invoice_defaultId_isBlank() {
        val invoice = Invoice()
        assertEquals("", invoice._id)
    }

    @Test
    fun invoice_fields_roundtripCorrectly() {
        val inv = TestData.invoice1
        assertEquals("inv-1", inv._id)
        assertEquals("kf-1", inv.kinfolkId)
        assertEquals("Rosa Parks", inv.kinfolkName)
        assertEquals("INV-001", inv.invoiceNumber)
        assertEquals(120.0, inv.total)
        assertEquals(120.0, inv.amountDue)
        assertEquals("outstanding", inv.status)
        assertEquals("2026-06-01", inv.dueDate)
    }

    @Test
    fun invoice_paidInvoice_hasZeroAmountDue() {
        assertEquals(0.0, TestData.invoice2.amountDue)
        assertEquals(80.0, TestData.invoice2.total)
    }

    // ---- Kinfolk ----

    @Test
    fun kinfolk_defaultStatus_isActive() {
        val k = Kinfolk()
        assertEquals("active", k.status)
    }

    @Test
    fun kinfolk_defaultOutstandingBalance_isZero() {
        val k = Kinfolk()
        assertEquals("0.00", k.outstandingBalance)
    }

    @Test
    fun kinfolk_displayName_firstAndLast() {
        val k = Kinfolk(firstName = "Ada", lastName = "Lovelace")
        assertEquals("Ada Lovelace", k.displayName)
    }

    @Test
    fun kinfolk_displayName_onlyFirstName() {
        val k = Kinfolk(firstName = "Ada", lastName = "")
        assertEquals("Ada", k.displayName)
    }

    @Test
    fun kinfolk_displayName_onlyLastName() {
        val k = Kinfolk(firstName = "", lastName = "Lovelace")
        assertEquals("Lovelace", k.displayName)
    }

    @Test
    fun kinfolk_displayName_bothBlank_fallback() {
        val k = Kinfolk(firstName = "", lastName = "")
        assertEquals("Unnamed Kinfolk", k.displayName)
    }

    @Test
    fun kinfolk_fields_roundtripCorrectly() {
        val kf = TestData.kinfolk1
        assertEquals("kf-1", kf._id)
        assertEquals("Rosa", kf.firstName)
        assertEquals("Parks", kf.lastName)
        assertEquals("555-0101", kf.phoneNumber)
        assertEquals("rosa@parks.example", kf.email)
        assertEquals("active", kf.status)
    }

    // ---- KinCareSession ----

    @Test
    fun kinCareSession_defaultStatus_isScheduled() {
        val s = KinCareSession()
        assertEquals("SCHEDULED", s.status)
    }

    @Test
    fun kinCareSession_defaultId_isBlank() {
        val s = KinCareSession()
        assertEquals("", s._id)
    }

    @Test
    fun kinCareSession_fields_roundtripCorrectly() {
        val s = TestData.sessionDraft1
        assertEquals("sess-1", s._id)
        assertEquals("kf-1", s.kinfolkId)
        assertEquals("Rosa Parks", s.kinfolkName)
        assertEquals("Dog Walking", s.serviceType)
        assertEquals("DRAFT", s.status)
    }

    @Test
    fun kinCareSession_completedSession_hasCompletedAt() {
        val s = TestData.sessionCompleted1
        assertEquals("COMPLETED", s.status)
        assertTrue(s.completedAt.isNotBlank(), "completedAt must be set on COMPLETED session")
        assertTrue(s.arrivedAt.isNotBlank(), "arrivedAt must be set on COMPLETED session")
        assertTrue(s.departedAt.isNotBlank(), "departedAt must be set on COMPLETED session")
    }

    // ---- BusinessSettings ----

    @Test
    fun businessSettings_defaultId_isBlank() {
        val s = BusinessSettings()
        assertEquals("", s._id)
    }

    @Test
    fun businessSettings_defaultServiceRates_isEmpty() {
        val s = BusinessSettings()
        assertTrue(s.serviceRates.isEmpty())
    }

    @Test
    fun businessSettings_fields_roundtripCorrectly() {
        val s = TestData.businessSettings
        assertEquals("settings-1", s._id)
        assertEquals("TribeTails Pet Care", s.businessName)
        assertEquals("hello@tribetails.example", s.businessEmail)
        assertEquals("555-9000", s.businessPhone)
        assertEquals("25.00", s.serviceRates["Dog Walking"])
        assertEquals("50.00", s.serviceRates["Pet Sitting"])
    }

    @Test
    fun businessSettings_defaultCalendarSyncId_isBlank() {
        assertEquals("", BusinessSettings().calendarSyncId)
    }

    // ---- Canonical unified schema (2026-06-05 settings unification) ----

    @Test
    fun businessSettings_canonicalDocId_isBusinessSettings() {
        assertEquals("business_settings", BUSINESS_SETTINGS_DOC_ID)
    }

    @Test
    fun businessSettings_unionDefaults_matchDesignDoc() {
        val s = BusinessSettings()
        // profile
        assertEquals("America/New_York", s.timeZone)
        // notifications
        assertTrue(s.notificationEmail && s.notificationSms && s.notificationPush)
        // holidays
        assertFalse(s.observeUsHolidays)
        // booking config (migrated from admin_settings)
        assertEquals("SPECIFIC_TIME", s.defaultBookingMode)
        assertEquals("MONTH", s.defaultCalendarView)
        assertTrue(s.allowTimeBlockBooking)
        assertTrue(s.allowSpecificTimeBooking)
        assertTrue(s.enableConflictDetection)
        assertFalse(s.enableAutoReminder24h)
        assertEquals(4, s.defaultTimeBlockDurationHours)
        assertEquals(30, s.travelBufferMinutes)
        // default timeBlock = midday 11:00-15:00 active
        assertEquals(1, s.timeBlocks.size)
        assertEquals("midday", s.timeBlocks[0].id)
        assertEquals("11:00", s.timeBlocks[0].startTime)
        assertEquals("15:00", s.timeBlocks[0].endTime)
        assertTrue(s.timeBlocks[0].isActive)
        // GPS / tracking
        assertTrue(s.enableGPSTrackingForAllVisits)
        assertTrue(s.enablePhotoLocationTagging)
        assertTrue(s.requireArrivalDepartureVerification)
        assertTrue(s.autoStartTrackingOnVisitStart)
        assertEquals("HIGH", s.trackingAccuracy)
        assertEquals(90, s.saveRoutesForDays)
        assertTrue(s.allowClientLocationSharing)
        // eta / drafts
        assertEquals(15, s.defaultEtaMinutes)
        assertEquals(listOf(5, 10, 15, 20, 30, 45, 60), s.etaMinuteOptions)
        assertEquals(30, s.draftRetentionDays)
        assertEquals(listOf(30, 60, 90), s.draftRetentionOptions)
        // meta
        assertEquals("", s.updatedBy)
    }

    @Test
    fun businessSettings_fullUnion_jsonRoundTrips() {
        // Every new union field must survive serialize -> deserialize.
        val original = BusinessSettings(
            _id = BUSINESS_SETTINGS_DOC_ID,
            businessName = "TribeTails Pet Care",
            businessEmail = "hello@tribetails.example",
            businessPhone = "555-9000",
            businessAddress = "1 Bark Ln",
            timeZone = "America/Chicago",
            serviceRates = mapOf("Dog Walking" to "25.00"),
            businessHours = mapOf("monday" to "09:00-17:00"),
            notificationEmail = false,
            notificationSms = false,
            notificationPush = false,
            observedUsHolidays = listOf("thanksgiving"),
            companyHolidays = listOf("2026-12-24|Eve"),
            specialHours = listOf("2026-07-04|closed"),
            observeUsHolidays = true,
            defaultBookingMode = "TIME_BLOCK",
            defaultCalendarView = "WEEK",
            allowTimeBlockBooking = false,
            allowSpecificTimeBooking = false,
            enableConflictDetection = false,
            enableAutoReminder24h = true,
            defaultTimeBlockDurationHours = 6,
            travelBufferMinutes = 45,
            timeBlocks = listOf(
                TimeBlockDefinition(id = "evening", label = "Evening", startTime = "17:00", endTime = "21:00", isActive = false),
            ),
            enableGPSTrackingForAllVisits = false,
            enablePhotoLocationTagging = false,
            requireArrivalDepartureVerification = false,
            autoStartTrackingOnVisitStart = false,
            trackingAccuracy = "LOW",
            saveRoutesForDays = 14,
            allowClientLocationSharing = false,
            defaultEtaMinutes = 20,
            etaMinuteOptions = listOf(10, 20),
            draftRetentionDays = 60,
            draftRetentionOptions = listOf(60, 120),
            calendarSyncId = "auntie@group.calendar.google.com",
            updatedAt = "2026-06-05T00:00:00Z",
            updatedBy = "nppJN",
        )
        val json = Json { ignoreUnknownKeys = true }
        val text = json.encodeToString(BusinessSettings.serializer(), original)
        val parsed = json.decodeFromString(BusinessSettings.serializer(), text)
        assertEquals(original, parsed)
    }

    @Test
    fun timeBlockDefinition_serializesActiveWireKey() {
        // Prod + android store the key `active`; web kotlinx must match via @SerialName.
        val block = TimeBlockDefinition(id = "midday", label = "Midday", startTime = "11:00", endTime = "15:00", isActive = false)
        val json = Json { ignoreUnknownKeys = true }
        val text = json.encodeToString(TimeBlockDefinition.serializer(), block)
        assertTrue(text.contains("\"active\":false"), "wire key must be `active`, got: $text")
        assertFalse(text.contains("isActive"), "must not serialize the kotlin name `isActive`")
        // and it reads back from the `active` wire key
        val parsed = json.decodeFromString(TimeBlockDefinition.serializer(), """{"id":"midday","active":true}""")
        assertTrue(parsed.isActive)
    }

    @Test
    fun businessSettings_calendarSyncId_jsonRoundTrips() {
        // The sync callable reads business_settings.calendarSyncId, so it MUST
        // survive the same JSON serialization the save path uses (jsonOut on both
        // wasm jsSetDoc and jvm setDoc).
        val original = BusinessSettings(
            _id = "singleton",
            businessName = "TribeTails Pet Care",
            calendarSyncId = "auntie@group.calendar.google.com",
        )
        val json = Json { ignoreUnknownKeys = true }
        val text = json.encodeToString(BusinessSettings.serializer(), original)
        val parsed = json.decodeFromString(BusinessSettings.serializer(), text)
        assertEquals(original, parsed)
        assertEquals("auntie@group.calendar.google.com", parsed.calendarSyncId)
        assertTrue(text.contains("\"calendarSyncId\":\"auntie@group.calendar.google.com\""))
    }
}
