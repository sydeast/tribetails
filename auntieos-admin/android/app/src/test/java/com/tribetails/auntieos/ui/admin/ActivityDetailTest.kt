package com.tribetails.auntieos.ui.admin

import com.tribetails.auntieos.data.admin.ActivityLogEntry
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The Activity Log's full sealed record, Android side.
 *
 * Operator ruling R5, 2026-08-03: "the Activity Log is seriously lacking, cant
 * see shit or what the fuck actually happened."
 *
 * Android was ahead of web here. Rows were already clickable and a detail
 * overlay already existed, and it STILL could not answer that, because the
 * overlay showed six fields and none of them was `payload`. Every field asserted
 * below has been sealed onto every entry by `writeAuditEntry` since 2026-05-19;
 * its own docstring calls them "retained for forensic value ... surfaced in
 * detail views", and they were surfaced in none.
 */
class ActivityDetailTest {

    private fun entry(
        payload: Map<String, Any?> = emptyMap(),
        seq: Long? = 1482L,
        entryHash: String = "",
        prevHash: String = "",
        severity: String = "",
        actorRole: String = "",
        targetCollection: String = "",
        targetId: String = "",
        ip: String = "",
    ) = ActivityLogEntry(
        id = "a1",
        timestamp = "2026-08-03T14:02:11.482Z",
        actionType = "NOTIFICATION_RECEIVED",
        description = "Notification kincare.booking.confirm delivered via email",
        status = "SUCCESS",
        seq = seq,
        entryHash = entryHash,
        prevHash = prevHash,
        payload = payload,
        severity = severity,
        actorRole = actorRole,
        targetCollection = targetCollection,
        targetId = targetId,
        ip = ip,
    )

    @Test
    fun detailLeadsWithTheFullTimestampThatTheRowTruncates() {
        // The row shows `HH:mm`. The point of opening an entry is to see what it
        // cut, and "which second" is routinely the question when reconciling
        // against a provider's logs.
        assertEquals("When" to "2026-08-03T14:02:11.482Z", activityDetailRows(entry()).first())
    }

    @Test
    fun detailSurfacesTheProvenanceFieldsTheOverlayNeverShowed() {
        val labels = activityDetailRows(
            entry(severity = "info", actorRole = "SYSTEM", ip = "203.0.113.7"),
        ).map { it.first }
        assertTrue(labels.contains("Severity"))
        assertTrue(labels.contains("Actor role"))
        assertTrue(labels.contains("IP"))
    }

    @Test
    fun detailRendersTheTargetAsAPathNeverAFabricatedLink() {
        val rows = activityDetailRows(entry(targetCollection = "notifications", targetId = "n1"))
        assertTrue(rows.contains("Target" to "notifications/n1"))
    }

    @Test
    fun detailFallsBackToAGenericSegmentRatherThanDroppingABareTargetId() {
        assertTrue(activityDetailRows(entry(targetId = "n1")).contains("Target" to "target/n1"))
    }

    @Test
    fun detailOmitsFieldsTheWriterDidNotRecord() {
        val labels = activityDetailRows(entry()).map { it.first }
        assertTrue(!labels.contains("IP"))
        assertTrue(!labels.contains("Target"))
    }

    /**
     * THE FIELD THAT ANSWERS THE COMPLAINT. The description says a notification
     * was delivered via email; the payload says to whom, for which notification,
     * and with which provider message id.
     */
    @Test
    fun payloadFlattensWhatActuallyHappened() {
        val rows = activityPayloadRows(
            entry(
                payload = mapOf(
                    "notificationId" to "n1",
                    "key" to "kincare.booking.confirm",
                    "channel" to "email",
                    "providerMessageId" to "sg-88",
                ),
            ),
        )
        assertEquals(
            listOf(
                "channel" to "email",
                "key" to "kincare.booking.confirm",
                "notificationId" to "n1",
                "providerMessageId" to "sg-88",
            ),
            rows,
        )
    }

    @Test
    fun payloadFlattensNestedMapsToDottedPaths() {
        assertEquals(
            listOf("result.scanned" to "40", "result.split" to "3"),
            activityPayloadRows(entry(payload = mapOf("result" to mapOf("split" to 3, "scanned" to 40)))),
        )
    }

    @Test
    fun payloadKeepsAnArrayOnOneLineBecauseItIsOneField() {
        assertEquals(
            listOf("channels" to "email, sms"),
            activityPayloadRows(entry(payload = mapOf("channels" to listOf("email", "sms")))),
        )
    }

    /**
     * A recorded null is a decision the writer made; blanking it hides that, and
     * in an audit trail "the writer recorded null here" is evidence.
     */
    @Test
    fun payloadPrintsARecordedNullAndAnEmptyMap() {
        assertEquals(
            listOf("providerMessageId" to "null"),
            activityPayloadRows(entry(payload = mapOf("providerMessageId" to null))),
        )
        assertEquals(
            listOf("extra" to "{}"),
            activityPayloadRows(entry(payload = mapOf("extra" to emptyMap<String, Any?>()))),
        )
    }

    @Test
    fun payloadIsEmptyForAnEntryWrittenWithoutOne() {
        assertTrue(activityPayloadRows(entry()).isEmpty())
    }

    /**
     * FULL hashes. The row abbreviates to eight characters because it has one
     * line; an opened entry is where someone verifies a hash by eye against
     * verifyActivityLogChain, and a truncated hash verifies nothing.
     */
    @Test
    fun chainShowsTheSequenceAndTheFullHashes() {
        val full = "a".repeat(64)
        val prev = "b".repeat(64)
        assertEquals(
            listOf("Sequence" to "#1482", "Entry hash" to full, "Previous hash" to prev),
            activityChainRows(entry(entryHash = full, prevHash = prev)),
        )
    }

    @Test
    fun chainIsEmptyForALegacyPreChainEntrySoTheScreenCanSaySo() {
        assertTrue(activityChainRows(entry(seq = null)).isEmpty())
    }

    @Test
    fun chainStillReportsTheSequenceForAnEntryWithNoHashes() {
        assertEquals(listOf("Sequence" to "#1482"), activityChainRows(entry()))
    }
}
