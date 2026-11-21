package com.tribetails.auntieos.web.screens.booking

import com.tribetails.auntieos.web.data.KinRemovalAnswer
import com.tribetails.auntieos.web.data.KinRemovalDecision
import com.tribetails.auntieos.web.data.KinRemovalRequest
import com.tribetails.auntieos.web.data.decodeKinRemovalAnswer
import com.tribetails.auntieos.web.data.decodeKinRemovalRequests
import com.tribetails.auntieos.web.data.resolveKinRemovalPayload
import kotlinx.datetime.TimeZone
import kotlinx.serialization.json.jsonPrimitive
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNull

/** #2121: the removal queue's shapes (the server's `KinRemovalRequestDto`) and admin web's words. */
class KinRemovalWordsTest {
    private val chicago = TimeZone.of("America/Chicago")
    // 2026-11-02T18:00:00Z, Nov 2 in Chicago.
    private val nov2 = 1_793_642_400_000L

    private val biscuit = KinRemovalRequest(
        id = "kf1_k1", kinfolkId = "kf1", kinId = "k1", flatKinId = "flat1",
        kinName = "Biscuit", reason = "Rehomed", requestedAtMs = nov2,
    )

    @Test
    fun decodesTheWaitingRequestsOnly() {
        val rows = decodeKinRemovalRequests(
            """{"requests":[
              {"id":"kf1_k1","kinfolkId":"kf1","kinId":"k1","flatKinId":"flat1","kinName":"Biscuit","reason":"Rehomed",
               "status":"pending","requestedAtMs":1793642400000,"resolvedAtMs":null,"resolutionNote":null},
              {"id":"kf1_k2","kinfolkId":"kf1","kinId":"k2","flatKinId":null,"kinName":null,"reason":null,
               "status":"archived","requestedAtMs":null,"resolvedAtMs":5,"resolutionNote":null},
              {"kinfolkId":"kf9"}
            ]}""",
        )
        assertEquals(listOf(biscuit), rows)
    }

    @Test
    fun aBodyWithNoListIsAFailedRead() {
        assertFailsWith<IllegalStateException> { decodeKinRemovalRequests("""{"ok":true}""") }
    }

    @Test
    fun theAnswerReadsWhatTheServerDid() {
        val body = """{"ok":true,"decision":"archive","request":{"id":"kf1_k1","kinName":"Biscuit"},
            "flatArchived":true,"familyArchived":true,"householdNotified":false}"""
        assertEquals(KinRemovalAnswer(KinRemovalDecision.ARCHIVE, "Biscuit", householdNotified = false),
            decodeKinRemovalAnswer(body, KinRemovalDecision.ARCHIVE))
    }

    @Test
    fun theNoteGoesOnlyWithWordsInIt() {
        val bare = resolveKinRemovalPayload("kf1_k1", KinRemovalDecision.DECLINE, "   ")
        assertEquals("kf1_k1", bare["requestId"]!!.jsonPrimitive.content)
        assertEquals("decline", bare["decision"]!!.jsonPrimitive.content)
        assertNull(bare["note"])
        val noted = resolveKinRemovalPayload("kf1_k1", KinRemovalDecision.ARCHIVE, "  We will miss him.  ")
        assertEquals("archive", noted["decision"]!!.jsonPrimitive.content)
        assertEquals("We will miss him.", noted["note"]!!.jsonPrimitive.content)
        assertEquals(500, resolveKinRemovalPayload("x", KinRemovalDecision.ARCHIVE, "y".repeat(700))["note"]!!.jsonPrimitive.content.length)
    }

    @Test
    fun theWordsAreAdminWebs() {
        assertEquals("The household asked on Nov 2, 2026 to remove Biscuit from their profile.", biscuit.requestedLine(chicago))
        assertEquals("The household asked to remove This Kin from their profile.",
            biscuit.copy(kinName = null, requestedAtMs = null).requestedLine(chicago))
        assertEquals("Archive Biscuit", biscuit.decisionTitle(KinRemovalDecision.ARCHIVE))
        assertEquals("Keep Biscuit", biscuit.decisionTitle(KinRemovalDecision.DECLINE))
        assertEquals(
            "Biscuit comes off the household's profile. Visits, invoices and KinTales are kept, and the household will be told.",
            biscuit.decisionLine(KinRemovalDecision.ARCHIVE),
        )
        assertEquals("Biscuit stays on the household's profile. The household will be told.", biscuit.decisionLine(KinRemovalDecision.DECLINE))
        assertEquals("Archive it", kinRemovalConfirmLabel(KinRemovalDecision.ARCHIVE))
        assertEquals("Send the decline", kinRemovalConfirmLabel(KinRemovalDecision.DECLINE))
        assertEquals("Biscuit is archived. The household has your answer.",
            kinRemovalResolvedMessage(KinRemovalAnswer(KinRemovalDecision.ARCHIVE, "Biscuit", true)))
        assertEquals("Declined. The Kin stays on the profile. The message to the household did not go out, so tell them another way.",
            kinRemovalResolvedMessage(KinRemovalAnswer(KinRemovalDecision.DECLINE, null, false)))
    }
}
