package com.tribetails.auntieos.data.admin

import com.tribetails.auntieos.data.repository.AuntieRepository
import com.tribetails.auntieos.data.repository.StaffMember
import com.tribetails.auntieos.data.repository.decodeListStaff
import com.tribetails.auntieos.data.repository.logActivityRequest
import com.tribetails.auntieos.data.repository.staffRolesByUid
import com.tribetails.auntieos.ui.admin.actorRoleFor
import com.tribetails.auntieos.ui.home.visitTapFacts
import io.mockk.coEvery
import io.mockk.coVerify
import io.mockk.mockk
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * #1820. The owner's own clock taps opened on the Activity Log as ACTOR ROLE
 * "Primary kinfolk", with "This entry was written with no payload".
 *
 * The role is the server's answer, so this client sends none. It sends the
 * facts behind the sentence, and reads the role back from what the server
 * stamped on the line or from the staff roster.
 */
class LogActivityRequestTest {

    private fun tap(payload: Map<String, Any?> = emptyMap()) = ActivityLogEntry(
        actionType = "VISIT_ARRIVED",
        description = "Arrived at the Okafor household",
        status = "SUCCESS",
        targetId = "s1",
        targetCollection = "kin_care_sessions",
        payload = payload,
    )

    // ── what is sent ────────────────────────────────────────────────────────

    @Test
    fun `the request names no role, whatever the entry carries`() {
        // ActivityLogEntry is also the model the screen reads, so it can hold a role.
        val entry = tap().apply {
            actorRole = "SYSTEM"
            severity = "critical"
        }
        val request = logActivityRequest(entry, signedInUid = "u1")
        assertEquals(
            setOf("actionType", "description", "status", "actorId", "targetId", "targetCollection", "payload"),
            request.keys,
        )
        assertFalse(request.keys.any { it.contains("role", ignoreCase = true) })
        assertFalse(request.containsKey("severity"))
    }

    @Test
    fun `the request carries the facts and names this client`() {
        val request = logActivityRequest(tap(visitTapFacts("s1", "ARRIVED", "ON_MY_WAY")), signedInUid = "u1")
        assertEquals(
            mapOf("visitId" to "s1", "action" to "ARRIVED", "from" to "ON_MY_WAY", "to" to "ARRIVED", "source" to "android"),
            request["payload"],
        )
    }

    @Test
    fun `a line with no facts still says which client wrote it`() {
        assertEquals(mapOf("source" to "android"), logActivityRequest(tap(), signedInUid = "u1")["payload"])
    }

    @Test
    fun `the server's own stamp and empty values are never sent`() {
        val request = logActivityRequest(
            tap(mapOf("admin" to true, "staffRole" to "auntie", "kinName" to null, "visitId" to "s1")),
            signedInUid = "u1",
        )
        assertEquals(mapOf("visitId" to "s1", "source" to "android"), request["payload"])
    }

    @Test
    fun `the household rides in its own field, and blanks are left out`() {
        val request = logActivityRequest(
            ActivityLogEntry(actionType = "DRAFT_APPROVED", familyId = "kf-42"),
            signedInUid = "",
        )
        assertEquals("kf-42", request["familyId"])
        assertFalse(request.containsKey("actorId"))
        assertFalse(request.containsKey("description"))
        assertFalse(request.containsKey("targetId"))
    }

    @Test
    fun `fire and fireSync hand the facts to the repository`() = runTest {
        val repository = mockk<AuntieRepository>(relaxed = true)
        coEvery { repository.logActivity(any()) } returns Result.success(Unit)
        AuditLog.fireSync(
            repository = repository,
            actionType = "VISIT_DEPARTED",
            description = "Departed the Okafor household",
            payload = visitTapFacts("s1", "DEPARTED", "ARRIVED"),
        )
        coVerify(exactly = 1) {
            repository.logActivity(match<ActivityLogEntry> {
                it.payload == mapOf("visitId" to "s1", "action" to "DEPARTED", "from" to "ARRIVED", "to" to "DEPARTED") &&
                    it.actorRole == ""
            })
        }
    }

    // ── what is read back ───────────────────────────────────────────────────

    private val roster = mapOf("owner-uid" to "owner", "auntie-uid" to "auntie")

    @Test
    fun `a tap line already stored as a household role reads Operator for the owner`() {
        assertEquals("Operator", actorRoleFor("PRIMARY", "owner-uid", emptyMap(), roster))
        assertEquals("Auntie", actorRoleFor("PRIMARY", "auntie-uid", emptyMap(), roster))
        assertEquals("Auntie", actorRoleFor("SECONDARY", "auntie-uid", emptyMap(), roster))
    }

    @Test
    fun `a staff line tells the owner from an Auntie`() {
        assertEquals("Operator", actorRoleFor("AUNTIE", "owner-uid", emptyMap(), roster))
        assertEquals("Auntie", actorRoleFor("AUNTIE", "auntie-uid", emptyMap(), roster))
    }

    @Test
    fun `the role the server stamped on the line wins over the roster`() {
        assertEquals("Auntie", actorRoleFor("AUNTIE", "owner-uid", mapOf("admin" to false, "staffRole" to "auntie"), roster))
        assertEquals("Operator", actorRoleFor("AUNTIE", "gone", mapOf("admin" to true, "staffRole" to null), roster))
        // Both stamps on one line is the Auntie, as every gate treats that account.
        assertEquals("Auntie", actorRoleFor("AUNTIE", "x", mapOf("admin" to true, "staffRole" to "auntie"), roster))
    }

    @Test
    fun `a stamp is never read off a household line`() {
        assertEquals("Primary kinfolk", actorRoleFor("PRIMARY", "kf-uid", mapOf("admin" to true), roster))
    }

    @Test
    fun `a Kinfolk stays a Kinfolk and System stays System`() {
        assertEquals("Primary kinfolk", actorRoleFor("PRIMARY", "kf-uid", emptyMap(), roster))
        assertEquals("Secondary kinfolk", actorRoleFor("SECONDARY", "sk-uid", emptyMap(), roster))
        assertEquals("System", actorRoleFor("SYSTEM", "owner-uid", emptyMap(), roster))
    }

    @Test
    fun `nothing is guessed when the roster has not answered or does not hold the actor`() {
        assertEquals("Staff", actorRoleFor("AUNTIE", "owner-uid"))
        assertEquals("Staff", actorRoleFor("AUNTIE", "gone", emptyMap(), roster))
        assertEquals("Primary kinfolk", actorRoleFor("PRIMARY", "owner-uid"))
        assertEquals("", actorRoleFor("", "owner-uid"))
    }

    // ── the roster ──────────────────────────────────────────────────────────

    @Test
    fun `the roster decodes a role and drops any other value`() {
        val staff = decodeListStaff(
            mapOf(
                "staff" to listOf(
                    mapOf("uid" to "o", "displayName" to "Olive", "role" to "owner"),
                    mapOf("uid" to "a", "displayName" to "Ada", "role" to "auntie"),
                    mapOf("uid" to "n", "displayName" to "Nell", "role" to null),
                    mapOf("uid" to "x", "displayName" to "Xan", "role" to "SYSTEM"),
                    mapOf("uid" to "z", "displayName" to "Zed"),
                ),
            ),
        )
        assertEquals(mapOf("o" to "owner", "a" to "auntie"), staffRolesByUid(staff))
        assertNull(staff.first { it.uid == "x" }.role)
        assertTrue(staffRolesByUid(listOf(StaffMember("u", "No role", null))).isEmpty())
    }
}
