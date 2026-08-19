package com.tribetails.auntieos.data.model

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The Android half of issue #450. Every other audience on the notification gate
 * resolves to a description of a person; `businessAdmins` resolved to a count
 * and a Firestore path, so the answer to "who does this reach" was still "go
 * and look it up yourself".
 */
class BusinessAdminRosterTest {

    private fun rosterPayload(
        members: List<Map<String, Any?>>,
        source: String = "roster",
        reason: String? = null,
    ): Map<String, Any?> = buildMap {
        put("members", members)
        put("source", source)
        put("rosterPath", "businessSettings/admins.uids")
        reason?.let { put("reason", it) }
    }

    @Test
    fun parsesTheRosterWithNamesAndTheDefaultAssignee() {
        val roster = businessAdminRosterFromMap(
            rosterPayload(
                listOf(
                    mapOf(
                        "uid" to "op1",
                        "displayName" to "Auntie Nora",
                        "email" to "nora@tribetails.com",
                        "hasStaffRecord" to true,
                        "defaultAssignee" to true,
                    ),
                ),
            ),
        )
        assertEquals(BusinessAdminRosterSource.Roster, roster.source)
        assertEquals("businessSettings/admins.uids", roster.rosterPath)
        assertNull(roster.reason)
        assertEquals(
            BusinessAdminMember(
                uid = "op1",
                displayName = "Auntie Nora",
                email = "nora@tribetails.com",
                hasStaffRecord = true,
                defaultAssignee = true,
            ),
            roster.members.single(),
        )
    }

    /**
     * An operator seeded from the `AUNTIE_OPERATOR_UIDS` allowlist can have no
     * `staff/{uid}` document and therefore no name. They receive every business
     * notification regardless, so they parse into a member rather than being
     * dropped, and the absent flags read as "no record" rather than as true.
     */
    @Test
    fun aMemberWithNothingButAUidStillParses() {
        val member = businessAdminMemberFromMap(mapOf("uid" to "op8"))
        assertEquals("op8", member.uid)
        assertNull(member.displayName)
        assertNull(member.email)
        assertFalse(member.hasStaffRecord)
        assertFalse(member.defaultAssignee)
    }

    @Test
    fun aBlankNameParsesAsNoNameRatherThanAnEmptyLabel() {
        val member = businessAdminMemberFromMap(
            mapOf("uid" to "op1", "displayName" to "   ", "email" to ""),
        )
        assertNull(member.displayName)
        assertNull(member.email)
    }

    @Test
    fun anUnknownSourceReadsAsNoneRatherThanAsAStoredRoster() {
        assertEquals(
            BusinessAdminRosterSource.None,
            businessAdminRosterFromMap(mapOf("source" to "something-new")).source,
        )
        assertEquals(BusinessAdminRosterSource.None, businessAdminRosterFromMap(emptyMap<String, Any?>()).source)
    }

    @Test
    fun theOutageReasonSurvivesTheParse() {
        val roster = businessAdminRosterFromMap(
            rosterPayload(emptyList(), source = "none", reason = "Call provisionBusinessAdmins."),
        )
        assertTrue(roster.members.isEmpty())
        assertEquals("Call provisionBusinessAdmins.", roster.reason)
    }

    // ── Which rows offer the roster at all ──────────────────────────────────

    @Test
    fun aBusinessAdminsRowOffersTheRoster() {
        assertTrue(
            notifReachesBusinessAdmins(
                NotificationCatalogEntry(key = "kincare.requested", recipientResolver = "businessAdmins"),
            ),
        )
    }

    @Test
    fun aSecondaryBusinessAdminsResolverOffersItToo() {
        assertTrue(
            notifReachesBusinessAdmins(
                NotificationCatalogEntry(
                    key = "invoice.new",
                    recipientResolver = "kinfolkAcct",
                    secondaryResolver = "businessAdmins",
                ),
            ),
        )
    }

    @Test
    fun aHouseholdOnlyRowDoesNotOfferIt() {
        assertFalse(
            notifReachesBusinessAdmins(
                NotificationCatalogEntry(key = "invoice.new", recipientResolver = "kinfolkAcct"),
            ),
        )
    }

    // ── The lines the gate renders ──────────────────────────────────────────

    @Test
    fun eachLineNamesThePersonAndHowTheMailReachesThem() {
        val line = businessAdminLines(
            BusinessAdminRoster(
                members = listOf(
                    BusinessAdminMember(
                        uid = "op1",
                        displayName = "Auntie Nora",
                        email = "nora@tribetails.com",
                        hasStaffRecord = true,
                        defaultAssignee = true,
                    ),
                ),
                source = BusinessAdminRosterSource.Roster,
            ),
        ).single()
        assertTrue(line.contains("Auntie Nora"))
        assertTrue(line.contains("nora@tribetails.com"))
        assertTrue(line.contains("unassigned visits default to them"))
    }

    @Test
    fun aMemberWithNoStaffRecordIsShownByUidAndSaysWhy() {
        val line = businessAdminLines(
            BusinessAdminRoster(members = listOf(BusinessAdminMember(uid = "op8"))),
        ).single()
        assertTrue(line.contains("op8"))
        assertTrue(line.contains("no staff record"))
        assertTrue(line.contains("no email on file"))
    }

    @Test
    fun theAllowlistFallbackIsCalledOutAndTheStoredRosterIsNot() {
        val members = listOf(BusinessAdminMember(uid = "op1", displayName = "Auntie Nora"))
        val note = businessAdminSourceNote(
            BusinessAdminRoster(members = members, source = BusinessAdminRosterSource.OperatorAllowlist),
        )
        assertTrue(note!!.contains("businessSettings/admins.uids"))
        assertTrue(note.contains("provisionBusinessAdmins"))
        assertNull(
            businessAdminSourceNote(
                BusinessAdminRoster(members = members, source = BusinessAdminRosterSource.Roster),
            ),
        )
    }
}
