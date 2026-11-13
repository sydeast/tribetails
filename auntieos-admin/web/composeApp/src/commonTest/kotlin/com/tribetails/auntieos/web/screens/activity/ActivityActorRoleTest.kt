package com.tribetails.auntieos.web.screens.activity

import com.tribetails.auntieos.web.data.ActivityLogEntry
import com.tribetails.auntieos.web.data.StaffMember
import com.tribetails.auntieos.web.data.decodeStaffList
import com.tribetails.auntieos.web.data.logActivityBody
import com.tribetails.auntieos.web.data.staffRolesFrom
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * #1820. The owner's own clock taps opened on the Activity Log as ACTOR ROLE
 * "Primary kinfolk". The role is the server's answer, so this client sends
 * none; it reads the role back from what the server stamped on the line or
 * from the staff roster.
 */
class ActivityActorRoleTest {
    private val roster = mapOf("owner-uid" to "owner", "auntie-uid" to "auntie")

    private fun stamp(admin: Boolean, staffRole: String?): JsonObject = buildJsonObject {
        put("admin", admin)
        put("staffRole", staffRole)
    }

    // ── what is read back ───────────────────────────────────────────────────

    @Test
    fun aTapLineAlreadyStoredAsAHouseholdRoleReadsOperatorForTheOwner() {
        assertEquals("Operator", actorRoleFor("PRIMARY", "owner-uid", null, roster))
        assertEquals("Auntie", actorRoleFor("PRIMARY", "auntie-uid", null, roster))
        assertEquals("Auntie", actorRoleFor("SECONDARY", "auntie-uid", null, roster))
    }

    @Test
    fun aStaffLineTellsTheOwnerFromAnAuntie() {
        assertEquals("Operator", actorRoleFor("AUNTIE", "owner-uid", null, roster))
        assertEquals("Auntie", actorRoleFor("AUNTIE", "auntie-uid", null, roster))
    }

    @Test
    fun theRoleTheServerStampedOnTheLineWinsOverTheRoster() {
        assertEquals("Auntie", actorRoleFor("AUNTIE", "owner-uid", stamp(false, "auntie"), roster))
        assertEquals("Operator", actorRoleFor("AUNTIE", "gone", stamp(true, null), roster))
        // Both stamps on one line is the Auntie, as every gate treats that account.
        assertEquals("Auntie", actorRoleFor("AUNTIE", "x", stamp(true, "auntie"), roster))
    }

    @Test
    fun aStampIsNeverReadOffAHouseholdLine() {
        assertEquals("Primary kinfolk", actorRoleFor("PRIMARY", "kf-uid", stamp(true, null), roster))
    }

    @Test
    fun aKinfolkStaysAKinfolkAndSystemStaysSystem() {
        assertEquals("Primary kinfolk", actorRoleFor("PRIMARY", "kf-uid", null, roster))
        assertEquals("Secondary kinfolk", actorRoleFor("SECONDARY", "sk-uid", null, roster))
        assertEquals("System", actorRoleFor("SYSTEM", "owner-uid", null, roster))
    }

    @Test
    fun nothingIsGuessedWhenTheRosterHasNotAnsweredOrDoesNotHoldTheActor() {
        assertEquals("Staff", actorRoleFor("AUNTIE", "owner-uid"))
        assertEquals("Staff", actorRoleFor("AUNTIE", "gone", null, roster))
        assertEquals("Primary kinfolk", actorRoleFor("PRIMARY", "owner-uid"))
        assertEquals("", actorRoleFor("", "owner-uid"))
        // A payload that is not an object, or carries odd values, relabels nothing.
        assertEquals("Staff", actorRoleFor("AUNTIE", "gone", JsonPrimitive("x"), roster))
        assertEquals("Staff", actorRoleFor("AUNTIE", "gone", buildJsonObject { put("admin", "true") }, roster))
    }

    @Test
    fun anEntryIsReadWithItsOwnRoleActorAndPayload() {
        val entry = ActivityLogEntry(actionType = "VISIT_ARRIVED", actorId = "owner-uid", actorRole = "PRIMARY")
        assertEquals("Operator", actorRoleFor(entry, roster))
        assertEquals("Primary kinfolk", actorRoleFor(entry))
    }

    @Test
    fun aStoredRoleReadsAsWords() {
        assertEquals("Staff", actorRoleLabel("AUNTIE"))
        assertEquals("Secondary kinfolk", actorRoleLabel("secondary"))
        assertEquals("Some new role", actorRoleLabel("SOME_NEW_ROLE"))
        assertEquals("", actorRoleLabel(" "))
    }

    // ── a stored entry decodes with its role and its facts ──────────────────

    @Test
    fun aStoredEntryDecodesItsRoleAndPayload() {
        val json = Json { ignoreUnknownKeys = true }
        val entry = json.decodeFromString(
            ActivityLogEntry.serializer(),
            """{"actionType":"VISIT_ARRIVED","actorId":"u1","actorRole":"AUNTIE","severity":"info",
               "payload":{"admin":true,"staffRole":null,"visitId":"s1","changedFields":["a","b"]}}""",
        )
        assertEquals("AUNTIE", entry.actorRole)
        assertEquals("Operator", actorRoleFor(entry))
        // An older entry has neither field, and one with an odd payload still decodes.
        assertNull(json.decodeFromString(ActivityLogEntry.serializer(), """{"actionType":"LOGIN"}""").payload)
        assertEquals(
            "Staff",
            actorRoleFor(json.decodeFromString(ActivityLogEntry.serializer(), """{"actorRole":"AUNTIE","payload":"none"}""")),
        )
    }

    // ── what is sent ────────────────────────────────────────────────────────

    private fun body(entry: ActivityLogEntry): JsonObject = Json.parseToJsonElement(logActivityBody(entry)).jsonObject

    @Test
    fun theRequestNamesNoRoleWhateverTheEntryCarries() {
        val sent = body(
            ActivityLogEntry(
                _id = "e1", timestamp = "2026-11-12T10:00:00Z", actionType = "CREATE_BOOKING", description = "Booked a visit",
                status = "SUCCESS", actorId = "u1", targetId = "s1", targetCollection = "kin_care_sessions",
                seq = 12, prevHash = "p", entryHash = "h", actorRole = "SYSTEM",
            ),
        )
        assertEquals(
            setOf("actionType", "description", "status", "actorId", "targetId", "targetCollection", "payload"),
            sent.keys,
        )
        assertFalse(sent.keys.any { it.contains("role", ignoreCase = true) })
    }

    @Test
    fun theRequestCarriesTheFactsAndNamesThisClient() {
        val sent = body(
            ActivityLogEntry(
                actionType = "UPDATE_KIN",
                familyId = "kf-42",
                payload = buildJsonObject {
                    put("kinName", "Biscuit")
                    put("admin", true)
                    put("staffRole", "auntie")
                    put("kinId", JsonNull)
                },
            ),
        )
        assertEquals("kf-42", (sent["familyId"] as JsonPrimitive).content)
        assertEquals(
            buildJsonObject {
                put("kinName", "Biscuit")
                put("source", "desktop")
            },
            sent["payload"],
        )
        // Blank fields are left out, so the server's own defaults apply.
        assertFalse(sent.containsKey("status"))
        assertFalse(sent.containsKey("actorId"))
    }

    @Test
    fun aLineWithNoFactsStillSaysWhichClientWroteIt() {
        assertEquals(buildJsonObject { put("source", "desktop") }, body(ActivityLogEntry(actionType = "LOGIN"))["payload"])
    }

    // ── the roster ──────────────────────────────────────────────────────────

    @Test
    fun theRosterDecodesARoleAndDropsAnyOtherValue() {
        val staff = decodeStaffList(
            """{"staff":[{"uid":"o","displayName":"Olive","role":"owner"},{"uid":"a","displayName":"Ada","role":"auntie"},
               {"uid":"n","displayName":"Nell","role":null},{"uid":"x","displayName":"Xan","role":"SYSTEM"},{"uid":"z"}]}""",
        )
        assertEquals(mapOf("o" to "owner", "a" to "auntie"), staffRolesFrom(staff))
        assertNull(staff.first { it.uid == "x" }.role)
        assertTrue(staffRolesFrom(listOf(StaffMember(uid = "u", displayName = "No role"))).isEmpty())
    }
}
