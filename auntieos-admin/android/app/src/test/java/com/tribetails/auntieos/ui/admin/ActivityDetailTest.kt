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
    fun detailLeadsWithOneReadableTimeInTheBusinessZone() {
        // #1818: never the raw UTC stamp, and no second "Business time" row.
        val rows = activityDetailRows(entry(), java.time.ZoneId.of("America/Chicago"))
        assertEquals("When" to "Aug 3, 2026, 9:02a", rows.first())
        assertTrue(rows.none { it.first == "Business time" || it.second.contains("2026-08-03T") })
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
    fun detailShowsNoStoredKeyNoTargetPathAndNoHouseholdId() {
        // #1818: the walk read "ACTION CANCEL_BOOKING_SERIES", the household as an id and a path.
        val rows = activityDetailRows(
            entry(targetCollection = "kin_care_sessions", targetId = "vis_ABCDEFGHIJ0123456789").apply { familyId = "fam1" },
        )
        val labels = rows.map { it.first }
        for (l in listOf("Action", "Actor id", "Target", "Request", "Client request", "Business time", "Household")) {
            assertTrue("$l is shown", l !in labels)
        }
        assertTrue(rows.none { it.second.contains("NOTIFICATION_RECEIVED") || it.second.contains("fam1") || it.second.contains("vis_") })
    }

    @Test
    fun detailNamesTheHouseholdFromTheDirectory() {
        val rows = activityDetailRows(
            entry().apply { familyId = "fam1" },
            households = mapOf("fam1" to "The Whitfields"),
        )
        assertTrue(rows.contains("Household" to "The Whitfields"))
    }

    @Test
    fun detailSaysTheStatusAndSeverityInWords() {
        assertTrue(activityDetailRows(entry(severity = "warn")).contains("Severity" to "Warning"))
        assertTrue(activityDetailRows(entry()).contains("Status" to "Done"))
    }

    @Test
    fun detailOmitsFieldsTheWriterDidNotRecord() {
        val labels = activityDetailRows(entry()).map { it.first }
        assertTrue(!labels.contains("IP"))
        assertTrue(!labels.contains("Target"))
    }

    /**
     * #1818: what happened, in words. The ids, the stored key and the provider's
     * message id stay on the sealed entry, and search still finds them.
     */
    @Test
    fun payloadListsWhatHappenedInWordsWithNoIdOrKey() {
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
        assertEquals(listOf("Channel" to "email"), rows)
        assertTrue(matchesQuery(entry(payload = mapOf("providerMessageId" to "sg-88")), "sg-88"))
    }

    @Test
    fun payloadReadsTheWalksCancelSeriesRowInWords() {
        val rows = activityPayloadRows(
            entry(
                payload = mapOf(
                    "affectedVisits" to 2,
                    "batchId" to "req_ABCDEFGHIJ0123456789",
                    "failedVisits" to 0,
                    "kinfolkId" to "Xy7Kq2Lm9Pz4Rt6Vb1Nc",
                    "sessionsCreated" to 0,
                ),
            ),
        )
        assertEquals(listOf("Affected visits" to "2", "Failed visits" to "0", "Sessions created" to "0"), rows)
    }

    @Test
    fun payloadHidesIdValuesAndReadsTimesStatusesAndKeysAsWords() {
        val rows = activityPayloadRows(
            entry(
                payload = mapOf(
                    "visit" to "vis_ABCDEFGHIJ0123456789",
                    "where" to "kin_care_sessions/abc",
                    "status" to "ON_MY_WAY",
                    "startTime" to "2026-11-11T17:33:35.411Z",
                    "notice" to "kincare.booking.confirm",
                    "recordedAfterTheFact" to false,
                ),
            ),
            java.time.ZoneId.of("America/Chicago"),
        )
        assertEquals(
            listOf(
                "Notice" to "KinCare booking confirm",
                "Recorded after the fact" to "no",
                "Start time" to "Nov 11, 2026, 11:33a",
                "Status" to "On my way",
            ),
            rows,
        )
    }

    @Test
    fun payloadFlattensNestedMaps() {
        assertEquals(
            listOf("Result scanned" to "40", "Result split" to "3"),
            activityPayloadRows(entry(payload = mapOf("result" to mapOf("split" to 3, "scanned" to 40)))),
        )
    }

    @Test
    fun payloadKeepsAnArrayOnOneLineBecauseItIsOneField() {
        assertEquals(
            listOf("Channels" to "email, sms"),
            activityPayloadRows(entry(payload = mapOf("channels" to listOf("email", "sms")))),
        )
    }

    /**
     * #1592: AUNTIE is written for every staff caller, the owner included, so an
     * admin sign-in read "AUNTIE". The row says the role in words.
     */
    @Test
    fun detailNamesTheActorRoleInWords() {
        fun role(r: String) = activityDetailRows(entry(actorRole = r)).first { it.first == "Actor role" }.second
        assertEquals("Staff", role("AUNTIE"))
        assertEquals("Primary kinfolk", role("PRIMARY"))
        assertEquals("Secondary kinfolk", role("SECONDARY"))
    }

    /**
     * #1820: the opened row reads the role from the roster, so the owner's tap
     * lines that were stored as a household role no longer read "Primary kinfolk".
     */
    @Test
    fun detailNamesTheOwnerAndAnAuntieFromTheRoster() {
        val roster = mapOf("owner-uid" to "owner", "auntie-uid" to "auntie")
        fun role(stored: String, actor: String, payload: Map<String, Any?> = emptyMap()) =
            activityDetailRows(entry(actorRole = stored, payload = payload).apply { actorId = actor }, roles = roster)
                .first { it.first == "Actor role" }.second
        assertEquals("Operator", role("PRIMARY", "owner-uid"))
        assertEquals("Operator", role("AUNTIE", "owner-uid"))
        assertEquals("Auntie", role("PRIMARY", "auntie-uid"))
        assertEquals("Primary kinfolk", role("PRIMARY", "kf-uid"))
        assertEquals("Operator", role("AUNTIE", "gone", mapOf("admin" to true, "staffRole" to null)))
    }

    /**
     * A recorded null is a decision the writer made; blanking it hides that, so it
     * stays on the list, as the word "none" rather than the literal "null" (#1592).
     */
    @Test
    fun payloadPrintsARecordedNullAndLeavesOutAnEmptyMap() {
        assertEquals(
            listOf("Reason" to "none"),
            activityPayloadRows(entry(payload = mapOf("reason" to null))),
        )
        assertTrue(activityPayloadRows(entry(payload = mapOf("extra" to emptyMap<String, Any?>()))).isEmpty())
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

    // #1049: saveEmergencyContacts audits every refused save. There is no
    // per-event formatter; this pins that the generic one reads the new event well.
    @Test
    fun aRefusedEmergencyContactSaveReadsAsASentenceAndShowsTheReason() {
        assertEquals("Emergency contact save refused", humanizeAction("EMERGENCY_CONTACT_SAVE_REFUSED"))
        val refused = entry(
            payload = mapOf(
                "kinfolkId" to "fam1",
                "code" to "failed-precondition",
                "reason" to "An Emergency Contact has to be someone outside the household.",
            ),
        )
        assertEquals(
            listOf("Reason" to "An Emergency Contact has to be someone outside the household."),
            activityPayloadRows(refused),
        )
    }
}
