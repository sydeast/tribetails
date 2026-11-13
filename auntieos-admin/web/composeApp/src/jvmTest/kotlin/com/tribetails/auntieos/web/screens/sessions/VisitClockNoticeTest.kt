package com.tribetails.auntieos.web.screens.sessions

import com.tribetails.auntieos.web.data.FirestoreClient
import com.tribetails.auntieos.web.data.JvmFirestoreFixtures
import com.tribetails.auntieos.web.data.KinCareSession
import com.tribetails.auntieos.web.data.WriteResult
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * #1840 on the desktop console: a clock step tells the household through the
 * server, and the toast says what the server answered.
 *
 * Before this the desktop OMW, Arrived and Departed buttons patched the visit
 * and called nothing, so the console could not say whether anyone was told.
 * The jvm actual answers callables from [JvmFirestoreFixtures.callableResponses]
 * and records the last name and payload.
 */
class VisitClockNoticeTest {

    private val session = KinCareSession(
        _id = "dre1",
        kinfolkId = "kfDre",
        kinfolkName = "Dre East",
        kinCareBatchId = "b1",
        kinCareVisitId = "v1",
    )
    private val at = "2026-11-10T23:40:00Z"
    private val atMs = 1_794_354_000_000L

    @AfterTest
    fun tearDown() {
        JvmFirestoreFixtures.clear()
    }

    private fun answer(json: String) {
        JvmFirestoreFixtures.callableResponses = mapOf("dispatchVisitNotification" to json)
    }

    /** One clock step end to end, as the screen runs it. */
    private fun tap(action: AuntieTimeAction, s: KinCareSession = session): String = runBlocking {
        val notice = visitNoticeEventOf(kinCarePatch(s, action, at)) ?: return@runBlocking ""
        val outcome = clockNoticeOutcome(s, notice) { event, ms -> FirestoreClient().dispatchVisitClockNotice(s, event, ms) }
        visitNoticeOutcomeSentence(outcome, visitNoticeHousehold(s))
    }

    private fun lastPayload() = Json.parseToJsonElement(JvmFirestoreFixtures.lastCallablePayloadJson!!).jsonObject

    // ── the three cases the result line must tell the truth about ────────────

    @Test
    fun aHouseholdThatWasToldReadsNotified() {
        answer("""{"ok":true,"dispatchIds":["n1"],"suppressed":false,"reason":null}""")
        assertEquals("Dre East was notified.", tap(AuntieTimeAction.OnMyWay))
    }

    @Test
    fun aHouseholdWithNoPortalSignInReadsNotNotifiedAndWhy() {
        // The Nov 10 walk: nobody has claimed the household, whatever login its record carries.
        answer("""{"ok":true,"dispatchIds":[],"suppressed":true,"reason":"household_has_no_portal_account"}""")
        assertEquals(
            "Dre East was not notified, because they have no portal account.",
            tap(AuntieTimeAction.OnMyWay),
        )
    }

    @Test
    fun householdNoticesSwitchedOffReadsNotNotifiedAndWhy() {
        answer("""{"ok":true,"dispatchIds":[],"suppressed":true,"reason":"household_notices_off"}""")
        assertEquals(
            "Dre East was not notified, because notices to households are off in Settings.",
            tap(AuntieTimeAction.Arrived),
        )
    }

    // ── what is sent ─────────────────────────────────────────────────────────

    @Test
    fun eachStepSendsItsOwnEventWithTheStampThePatchWrote() {
        answer("""{"ok":true,"dispatchIds":["n1"],"suppressed":false,"reason":null}""")
        for ((action, wire) in listOf(
            AuntieTimeAction.OnMyWay to "on_my_way",
            AuntieTimeAction.Arrived to "arrived",
            AuntieTimeAction.Departed to "departed",
        )) {
            tap(action)
            assertEquals("dispatchVisitNotification", JvmFirestoreFixtures.lastCallableName)
            val payload = lastPayload()
            assertEquals("kfDre", payload["familyId"]?.jsonPrimitive?.content)
            assertEquals("b1", payload["batchId"]?.jsonPrimitive?.content)
            assertEquals("v1", payload["visitId"]?.jsonPrimitive?.content)
            assertEquals(wire, payload["event"]?.jsonPrimitive?.content)
            assertEquals(atMs, payload["eventAtMs"]?.jsonPrimitive?.long)
            assertFalse(payload.containsKey("bookingId"))
        }
    }

    @Test
    fun aLegacyVisitRoutesByItsBookingId() {
        answer("""{"ok":true,"dispatchIds":["n1"],"suppressed":false,"reason":null}""")
        tap(AuntieTimeAction.OnMyWay, KinCareSession(_id = "s", kinfolkId = "kf1", kinfolkName = "Dre East", sourceBookingId = "legacy7"))
        val payload = lastPayload()
        assertEquals("legacy7", payload["bookingId"]?.jsonPrimitive?.content)
        assertFalse(payload.containsKey("batchId"))
    }

    // ── steps and rows that tell nobody ──────────────────────────────────────

    @Test
    fun undoArrivedTellsNobodyAndCallsNothing() {
        assertNull(visitNoticeEventOf(kinCarePatch(session.copy(onMyWayAt = at), AuntieTimeAction.UndoArrived, at)))
        assertNull(visitNoticeEventOf(kinCarePatch(session, AuntieTimeAction.UndoArrived, at)))
        assertEquals("", tap(AuntieTimeAction.UndoArrived, session.copy(onMyWayAt = at)))
        assertNull(JvmFirestoreFixtures.lastCallableName)
    }

    @Test
    fun aVisitWithNoHouseholdOrNoBookingIsNamedWithoutACall() {
        assertEquals(
            "No household was notified, because this visit is not linked to one.",
            tap(AuntieTimeAction.OnMyWay, KinCareSession(_id = "s")),
        )
        assertEquals(
            "Dre East was not notified, because this visit is not linked to a booking.",
            tap(AuntieTimeAction.OnMyWay, KinCareSession(_id = "s", kinfolkId = "kf1", kinfolkName = "Dre East")),
        )
        assertNull(JvmFirestoreFixtures.lastCallableName)
    }

    @Test
    fun theClientRefusesToDialForAVisitItCannotRoute() = runBlocking {
        assertTrue(FirestoreClient().dispatchVisitClockNotice(KinCareSession(_id = "s"), "arrived", atMs) is WriteResult.Err)
        assertTrue(
            FirestoreClient().dispatchVisitClockNotice(KinCareSession(_id = "s", kinfolkId = "kf1"), "arrived", atMs)
                is WriteResult.Err,
        )
        assertNull(JvmFirestoreFixtures.lastCallableName)
    }

    // ── errors and older servers ─────────────────────────────────────────────

    @Test
    fun aFailedCallSaysTheNoticeCouldNotBeSent() {
        JvmFirestoreFixtures.callableErrors = mapOf("dispatchVisitNotification" to "INTERNAL")
        assertEquals("The notice to Dre East could not be sent.", tap(AuntieTimeAction.Departed))
    }

    @Test
    fun anAnswerThatIsNotAnObjectIsAFailedSendNotAPromise() {
        assertEquals(
            VisitNotifyOutcome(notified = false, notifySkipped = "dispatch_failed"),
            visitNotifyOutcomeOf(WriteResult.Ok("not json")),
        )
    }

    @Test
    fun aSuppressedAnswerWithNoReasonNamesNoCause() {
        assertEquals(
            VisitNotifyOutcome(notified = false, notifySkipped = "not_sent"),
            visitNotifyOutcomeOf(WriteResult.Ok("""{"ok":true,"dispatchIds":[],"suppressed":true}""")),
        )
        assertEquals(
            VisitNotifyOutcome(notified = false, notifySkipped = "not_sent"),
            visitNotifyOutcomeOf(WriteResult.Ok("""{"ok":true,"dispatchIds":[],"suppressed":true,"reason":null}""")),
        )
        assertEquals("Dre East was not notified.", visitNoticeOutcomeSentence(VisitNotifyOutcome(false, "not_sent"), "Dre East"))
    }

    @Test
    fun theOtherReasonsReadInPlainWords() {
        fun said(reason: String) = visitNoticeOutcomeSentence(VisitNotifyOutcome(false, reason), "the Wrens")
        assertEquals("The Wrens was not notified, because this notice is turned off for them.", said("household_prefs_suppressed"))
        assertEquals("The Wrens was already told about this step, so it was not sent again.", said("already_notified"))
        assertEquals("The Wrens was not notified.", said("a_reason_from_a_newer_server"))
        for (reason in listOf("household_has_no_portal_account", "household_notices_off", "dispatch_failed")) {
            assertFalse(said(reason).contains('—'))
        }
    }

    @Test
    fun aVisitWithNoHouseholdNameSaysTheHousehold() {
        assertEquals("the household", visitNoticeHousehold(KinCareSession(_id = "s", kinfolkName = "  ")))
    }
}
