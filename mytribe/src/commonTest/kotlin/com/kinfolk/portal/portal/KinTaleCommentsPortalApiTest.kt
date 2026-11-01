package com.kinfolk.portal.portal
import com.kinfolk.portal.firebase.FakeFunctionsClient
import kotlinx.coroutines.test.runTest
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
}
