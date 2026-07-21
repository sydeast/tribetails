package com.tribetails.auntieos.web

import com.tribetails.auntieos.web.data.BUSINESS_SETTINGS_DOC_ID
import com.tribetails.auntieos.web.data.BusinessSettings
import com.tribetails.auntieos.web.data.Invoice
import com.tribetails.auntieos.web.data.Kin
import com.tribetails.auntieos.web.data.KinCareSession
import com.tribetails.auntieos.web.data.Kinfolk
import com.tribetails.auntieos.web.data.TagColor
import com.tribetails.auntieos.web.data.TagDef
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

    // ---- Tags (ported from the React admin, 2026-07-19) ----
    //
    // Two codecs below mirror the real platform ones byte-for-byte so these tests
    // fail for the same reason production would:
    //   readCodec  = JvmFirestoreRest.codec / FirestoreInterop.wasmJs json (desktop
    //                deliberately has NO coerceInputValues, so a null on a
    //                non-nullable list would throw and drop the whole document)
    //   writeCodec = jsonOut on both platforms (encodeDefaults = true)

    private val readCodec = Json { ignoreUnknownKeys = true; isLenient = true }
    private val writeCodec = Json { encodeDefaults = true; ignoreUnknownKeys = true; isLenient = true }

    @Test
    fun kin_tags_defaultsToEmpty() {
        assertTrue(Kin().tags.isEmpty())
    }

    @Test
    fun kinfolk_tags_defaultsToEmpty() {
        assertTrue(Kinfolk().tags.isEmpty())
    }

    @Test
    fun kin_reactAuthoredTags_surviveKotlinLoadThenWholeObjectSave() {
        // DATA-LOSS GUARD (drift risk 7). React patches only the fields it changed;
        // this tree re-writes the WHOLE kin document (platformUpdateKin -> jsSetDoc /
        // setDoc). Before `tags` landed on [Kin], any Kotlin save of a React-tagged
        // pet silently wiped the tag list. Load-then-save must round-trip it.
        val reactDoc =
            """{"_id":"kin-1","kinfolkId":"kf-1","name":"Biscuit","species":"Dog","tags":["Reactive","On meds"]}"""
        val loaded = readCodec.decodeFromString(Kin.serializer(), reactDoc)
        assertEquals(listOf("Reactive", "On meds"), loaded.tags)

        val saved = writeCodec.encodeToString(Kin.serializer(), loaded)
        assertTrue(
            saved.contains("""tags":["Reactive","On meds"]"""),
            "a kotlin save must re-write tags, got: $saved",
        )
        assertEquals(loaded, readCodec.decodeFromString(Kin.serializer(), saved))
    }

    @Test
    fun kinfolk_reactAuthoredTags_surviveKotlinLoadThenWholeObjectSave() {
        val reactDoc =
            """{"_id":"kf-1","firstName":"Rosa","lastName":"Parks","tags":["VIP","Gate code"]}"""
        val loaded = readCodec.decodeFromString(Kinfolk.serializer(), reactDoc)
        assertEquals(listOf("VIP", "Gate code"), loaded.tags)

        val saved = writeCodec.encodeToString(Kinfolk.serializer(), loaded)
        assertTrue(
            saved.contains("""tags":["VIP","Gate code"]"""),
            "a kotlin save must re-write tags, got: $saved",
        )
        assertEquals(loaded, readCodec.decodeFromString(Kinfolk.serializer(), saved))
    }

    @Test
    fun kin_tags_storageCasing_isNotLowercased() {
        // Only COMPARISON lowercases (React model.ts:65-67); storage keeps the
        // casing as typed, so "VIP" stays "VIP" through a Kotlin round-trip.
        val loaded = readCodec.decodeFromString(Kin.serializer(), """{"_id":"kin-1","tags":["VIP"]}""")
        assertEquals(listOf("VIP"), loaded.tags)
    }

    @Test
    fun kin_tags_explicitNull_decodesToEmpty_neverThrows() {
        val loaded = readCodec.decodeFromString(Kin.serializer(), """{"_id":"kin-1","tags":null}""")
        assertTrue(loaded.tags.isEmpty())
    }

    @Test
    fun kinfolk_tags_explicitNull_decodesToEmpty_neverThrows() {
        val loaded = readCodec.decodeFromString(Kinfolk.serializer(), """{"_id":"kf-1","tags":null}""")
        assertTrue(loaded.tags.isEmpty())
    }

    @Test
    fun kin_tags_nonArray_decodesToEmpty_neverThrows() {
        // A hand-edited doc with a Boolean where the array belongs must not kill the
        // whole query (the android crash cluster, reproduced defensively here).
        val loaded = readCodec.decodeFromString(Kin.serializer(), """{"_id":"kin-1","tags":true}""")
        assertTrue(loaded.tags.isEmpty())
    }

    @Test
    fun kin_tags_dropsNonStringEntries() {
        // Mirrors React's arr() guard (api/kinView.ts:67-72, api/kinfolkProfile.ts:65-66):
        // keep only string entries, drop the rest, never throw.
        val loaded = readCodec.decodeFromString(
            Kin.serializer(),
            """{"_id":"kin-1","tags":["VIP",true,42,null,{"name":"x"},["nested"],"Reactive"]}""",
        )
        assertEquals(listOf("VIP", "Reactive"), loaded.tags)
    }

    @Test
    fun businessSettings_tagVocabularies_defaultToEmpty() {
        val s = BusinessSettings()
        assertTrue(s.householdTags.isEmpty())
        assertTrue(s.petTags.isEmpty())
    }

    @Test
    fun businessSettings_tagVocabularies_absentOrNull_decodeToEmpty() {
        val absent = readCodec.decodeFromString(
            BusinessSettings.serializer(),
            """{"_id":"business_settings"}""",
        )
        assertTrue(absent.householdTags.isEmpty() && absent.petTags.isEmpty())

        val nulled = readCodec.decodeFromString(
            BusinessSettings.serializer(),
            """{"_id":"business_settings","householdTags":null,"petTags":null}""",
        )
        assertTrue(nulled.householdTags.isEmpty() && nulled.petTags.isEmpty())
    }

    @Test
    fun businessSettings_tagDefs_roundTripCssVarUnchanged() {
        // CONTRACT: React paints a chip from color.css, a literal CSS custom-property
        // reference (TagChip.tsx:25). Kotlin has no CSS variables and paints from
        // color.token instead, so it MUST write css back byte-identical or React
        // renders an unpainted chip.
        val raw = """{
            "_id":"business_settings",
            "householdTags":[{"name":"VIP","icon":"⭐","color":{"token":"teal","css":"var(--color-accent)"}}],
            "petTags":[{"name":"Reactive","icon":"","color":{"token":"coral","css":"var(--color-coral)"}}]
        }"""
        val s = readCodec.decodeFromString(BusinessSettings.serializer(), raw)

        assertEquals(1, s.householdTags.size)
        assertEquals("VIP", s.householdTags[0].name)
        assertEquals("teal", s.householdTags[0].color.token)
        assertEquals("var(--color-accent)", s.householdTags[0].color.css)
        assertEquals("⭐", s.householdTags[0].icon)
        // '' means "no icon", never null (React drops a row whose icon is not a string).
        assertEquals("", s.petTags[0].icon)
        assertEquals("var(--color-coral)", s.petTags[0].color.css)

        val saved = writeCodec.encodeToString(BusinessSettings.serializer(), s)
        assertTrue(saved.contains("""css":"var(--color-accent)"""), "css var must survive a kotlin save: $saved")
        assertTrue(saved.contains("""css":"var(--color-coral)"""), "css var must survive a kotlin save: $saved")
        assertEquals(s, readCodec.decodeFromString(BusinessSettings.serializer(), saved))
    }

    @Test
    fun businessSettings_malformedTagRows_areDropped_neverThrow() {
        // Reproduces decodeTagDefs (React api/settings.ts:241-255) drop-for-drop:
        // a bad vocabulary must never take down the whole settings read.
        val raw = """{"householdTags":[
            null,
            "VIP",
            {"name":"   ","icon":"","color":{"token":"teal","css":"var(--color-accent)"}},
            {"name":"MissingIcon","color":{"token":"teal","css":"var(--color-accent)"}},
            {"name":"IconNotString","icon":7,"color":{"token":"teal","css":"var(--color-accent)"}},
            {"name":"MissingColor","icon":""},
            {"name":"ColorNull","icon":"","color":null},
            {"name":"MissingCss","icon":"","color":{"token":"teal"}},
            {"name":"TokenNotString","icon":"","color":{"token":3,"css":"var(--color-accent)"}},
            {"name":"Good","icon":"🔥","color":{"token":"gold","css":"var(--color-warning)"}}
        ],"petTags":"not-an-array"}"""
        val s = readCodec.decodeFromString(BusinessSettings.serializer(), raw)
        assertEquals(listOf("Good"), s.householdTags.map { it.name })
        assertTrue(s.petTags.isEmpty(), "a non-array vocabulary decodes to empty, never throws")
    }

    @Test
    fun businessSettings_tagDef_nameIsStoredUntrimmed() {
        // React trims only to decide "is this row blank"; the stored name goes in
        // as-is (api/settings.ts:247 vs :252). Kotlin must not quietly re-shape it.
        val raw = """{"householdTags":[{"name":" VIP ","icon":"","color":{"token":"teal","css":"var(--color-accent)"}}]}"""
        val s = readCodec.decodeFromString(BusinessSettings.serializer(), raw)
        assertEquals(" VIP ", s.householdTags[0].name)
    }

    @Test
    fun businessSettings_tagVocabularies_survive_wholeDocSave() {
        // saveBusinessSettings merges the whole model, so an operator saving any
        // unrelated setting must not drop a vocabulary React authored.
        val original = BusinessSettings(
            _id = BUSINESS_SETTINGS_DOC_ID,
            businessName = "TribeTails Pet Care",
            householdTags = listOf(
                TagDef(name = "VIP", color = TagColor(token = "teal", css = "var(--color-accent)"), icon = ""),
            ),
            petTags = listOf(
                TagDef(name = "Reactive", color = TagColor(token = "coral", css = "var(--color-coral)"), icon = "⭐"),
            ),
        )
        val saved = writeCodec.encodeToString(BusinessSettings.serializer(), original)
        assertEquals(original, readCodec.decodeFromString(BusinessSettings.serializer(), saved))
    }
}
