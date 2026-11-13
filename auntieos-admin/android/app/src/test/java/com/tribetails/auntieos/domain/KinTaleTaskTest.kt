package com.tribetails.auntieos.domain

import com.tribetails.auntieos.data.model.BusinessSettings
import com.tribetails.auntieos.data.model.KinCareSession
import com.tribetails.auntieos.data.model.VisitStatus
import com.tribetails.auntieos.data.model.businessSettingsFieldChanges
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * #2123: a visit is Completed at departure, and "KinTale required" is a task
 * the Auntie carries until the KinTale is sent. It never blocks completion.
 */
class KinTaleTaskTest {

    private fun owedVisit(id: String = "s1", start: String = "2026-11-10T15:00:00Z") = KinCareSession(
        id = id,
        status = VisitStatus.COMPLETED.name,
        startTime = start,
        kinTaleDue = true,
    )

    // ── the setting ────────────────────────────────────────────────────────

    @Test
    fun `an absent setting reads as off, on the model and on the raw value`() {
        // Operator ruling 2026-11-13: "Start it off".
        assertFalse(BusinessSettings().kinTaleRequired)
        assertFalse(kinTaleRequiredSetting(null))
    }

    @Test
    fun `an absent setting gives no KinTales to send group, whatever the visits say`() {
        val split = splitKinTalesToSend(listOf(owedVisit()), BusinessSettings().kinTaleRequired)
        assertTrue(split.toSend.isEmpty())
        assertEquals(listOf("s1"), split.rest.map { it.id })
    }

    @Test
    fun `an explicit on stays on, and only a real true turns it on`() {
        assertTrue(kinTaleRequiredSetting(true))
        assertFalse(kinTaleRequiredSetting(false))
        assertFalse(kinTaleRequiredSetting("true"))
    }

    @Test
    fun `a save that never touched the switch writes nothing for it`() {
        val loaded = BusinessSettings()
        val edited = loaded.copy(venmoHandle = "@tribe")
        assertFalse(businessSettingsFieldChanges(loaded, edited).containsKey("kinTaleRequired"))
    }

    @Test
    fun `turning it off is a real write of false, and back on a write of true`() {
        val on = BusinessSettings(kinTaleRequired = true)
        assertEquals(
            mapOf<String, Any?>("kinTaleRequired" to false),
            businessSettingsFieldChanges(on, on.copy(kinTaleRequired = false)),
        )
        val off = BusinessSettings()
        assertEquals(
            mapOf<String, Any?>("kinTaleRequired" to true),
            businessSettingsFieldChanges(off, off.copy(kinTaleRequired = true)),
        )
    }

    // ── the rule ────────────────────────────────────────────────────────────

    @Test
    fun `a completed visit the server marked due is owed while the setting is on`() {
        assertTrue(kinTaleOwed(owedVisit(), required = true))
    }

    @Test
    fun `the setting off owes nothing, whatever the visit says`() {
        assertFalse(kinTaleOwed(owedVisit(), required = false))
    }

    @Test
    fun `a sent KinTale clears the task`() {
        assertFalse(kinTaleOwed(owedVisit().copy(sentReportCount = 1), required = true))
    }
    @Test
    fun `an unsent draft does not clear the task, though this app lists its id on the visit`() {
        assertTrue(kinTaleOwed(owedVisit().copy(reportIds = listOf("draft-1")), required = true))
        assertTrue(offersSendKinTale(KinCareSession(status = "COMPLETED", reportIds = listOf("draft-1"))))
    }

    @Test
    fun `a visit the server did not mark due is not owed`() {
        assertFalse(kinTaleOwed(owedVisit().copy(kinTaleDue = false), required = true))
    }

    @Test
    fun `only a completed visit is owed`() {
        for (status in listOf("SCHEDULED", "ON_MY_WAY", "ARRIVED", "DEPARTED", "CANCELLED", "")) {
            assertFalse(status, kinTaleOwed(owedVisit().copy(status = status), required = true))
        }
        assertTrue(kinTaleOwed(owedVisit().copy(status = "completed"), required = true))
    }

    // ── the card offer ──────────────────────────────────────────────────────

    @Test
    fun `Send the KinTale is offered on a finished visit with no sent KinTale, required or not`() {
        assertTrue(offersSendKinTale(KinCareSession(status = "COMPLETED")))
        assertTrue(offersSendKinTale(KinCareSession(status = "DEPARTED")))
        assertFalse(offersSendKinTale(KinCareSession(status = "COMPLETED", sentReportCount = 1)))
        assertFalse(offersSendKinTale(KinCareSession(status = "ARRIVED")))
        assertFalse(offersSendKinTale(KinCareSession(status = "CANCELLED")))
    }

    // ── the board split ─────────────────────────────────────────────────────

    @Test
    fun `owed visits move to their own group, oldest first, and leave the rest`() {
        val newer = owedVisit("new", "2026-11-11T15:00:00Z")
        val older = owedVisit("old", "2026-11-01T15:00:00Z")
        val sent = owedVisit("sent").copy(sentReportCount = 1)
        val plain = KinCareSession(id = "plain", status = "SCHEDULED")
        val split = splitKinTalesToSend(listOf(newer, plain, sent, older), required = true)
        assertEquals(listOf("old", "new"), split.toSend.map { it.id })
        assertEquals(listOf("plain", "sent"), split.rest.map { it.id })
    }

    @Test
    fun `with the setting off or unknown the board is left as it was`() {
        val all = listOf(owedVisit("a"), KinCareSession(id = "b"))
        for (required in listOf(false, null)) {
            val split = splitKinTalesToSend(all, required)
            assertTrue(split.toSend.isEmpty())
            assertEquals(listOf("a", "b"), split.rest.map { it.id })
        }
    }
}
