package com.kinfolk.portal.portal
import com.kinfolk.portal.firebase.FakeFunctionsClient
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.add
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
/** #1328: the comment read carries who wrote each comment. */
class KinTaleCommentsPortalApiTest {
    @Test
    fun getMyKinTaleComments_decodesAuthorDisplayName_andToleratesItsAbsence() = runTest {
        val fake = FakeFunctionsClient()
        fake.stub("getKinTaleComments", buildJsonObject {
            put("comments", buildJsonArray {
                add(buildJsonObject {
                    put("id", "c1"); put("authorRole", "admin"); put("authorDisplayName", "Maya"); put("body", "hi")
                })
                add(buildJsonObject {
                    put("id", "c2"); put("authorRole", "kinfolk"); put("authorDisplayName", " "); put("body", "yo")
                })
                add(buildJsonObject {
                    put("id", "c3"); put("authorRole", "kinfolk"); put("body", "older server")
                })
            })
        })
        val comments = PortalApi(fake).getMyKinTaleComments(kinfolkId = "kf1", taleId = "t1")
        assertEquals("Maya", comments[0].authorDisplayName)
        assertNull(comments[1].authorDisplayName)
        assertNull(comments[2].authorDisplayName)
    }

    @Test
    fun getMyKinTaleComments_decodesAuthorUidAndWhetherTheNameIsThePerson() = runTest {
        // #2378: the app needs both to mark the reader's own comment.
        val fake = FakeFunctionsClient()
        fake.stub("getKinTaleComments", buildJsonObject {
            put("comments", buildJsonArray {
                add(buildJsonObject {
                    put("id", "c1"); put("authorRole", "kinfolk"); put("authorUid", "u1")
                    put("authorDisplayName", "The Ortega household"); put("authorNameIsPerson", false); put("body", "hi")
                })
                add(buildJsonObject {
                    put("id", "c2"); put("authorRole", "kinfolk"); put("authorUid", "u2")
                    put("authorDisplayName", "Casey"); put("authorNameIsPerson", true); put("body", "yo")
                })
                add(buildJsonObject {
                    put("id", "c3"); put("authorRole", "guest"); put("authorUid", JsonNull); put("guestName", "Pat"); put("body", "older server")
                })
            })
        })
        val comments = PortalApi(fake).getMyKinTaleComments(kinfolkId = "kf1", taleId = "t1")
        assertEquals(listOf("u1", "u2", null), comments.map { it.authorUid })
        assertEquals(listOf(false, true, null), comments.map { it.authorNameIsPerson })
    }
}
