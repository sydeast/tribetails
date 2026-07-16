package com.kinfolk.portal.portal

import com.kinfolk.portal.firebase.FakeFunctionsClient
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import kotlin.test.Test
import kotlin.test.assertEquals

/** KinTale reactions (single love/heart toggle) — PortalApi callable wiring tests. */
class KinTaleReactionPortalApiTest {

    @Test
    fun getKinTaleReaction_sendsTaleIdAndDecodesResult() = runTest {
        val fake = FakeFunctionsClient()
        fake.stub("getKinTaleReaction", buildJsonObject { put("loved", true); put("loveCount", 3) })
        val api = PortalApi(fake)

        val result = api.getKinTaleReaction(kinfolkId = "kf1", taleId = "t1")

        assertEquals(true, result.loved)
        assertEquals(3, result.loveCount)
        assertEquals("getKinTaleReaction", fake.calls[0].first)
        val payload = fake.calls[0].second!!
        assertEquals("t1", payload["taleId"]?.jsonPrimitive?.contentOrNull)
        assertEquals("kf1", payload["kinfolkId"]?.jsonPrimitive?.contentOrNull)
    }

    @Test
    fun getKinTaleReaction_omitsKinfolkId_whenNull() = runTest {
        val fake = FakeFunctionsClient()
        fake.stub("getKinTaleReaction", buildJsonObject { put("loved", false); put("loveCount", 0) })
        val api = PortalApi(fake)
        api.getKinTaleReaction(taleId = "t1")
        val payload = fake.calls[0].second!!
        assertEquals(null, payload["kinfolkId"])
    }

    @Test
    fun getKinTaleReaction_defaultsMissingFields_toFalseAndZero() = runTest {
        val fake = FakeFunctionsClient()
        fake.stub("getKinTaleReaction", buildJsonObject { })
        val api = PortalApi(fake)
        val result = api.getKinTaleReaction(taleId = "t1")
        assertEquals(false, result.loved)
        assertEquals(0, result.loveCount)
    }

    @Test
    fun toggleKinTaleLove_sendsTaleIdAndDecodesNewState() = runTest {
        val fake = FakeFunctionsClient()
        fake.stub("toggleKinTaleLove", buildJsonObject { put("loved", true); put("loveCount", 1) })
        val api = PortalApi(fake)

        val result = api.toggleKinTaleLove(kinfolkId = "kf1", taleId = "t1")

        assertEquals(true, result.loved)
        assertEquals(1, result.loveCount)
        assertEquals("toggleKinTaleLove", fake.calls[0].first)
        val payload = fake.calls[0].second!!
        assertEquals("t1", payload["taleId"]?.jsonPrimitive?.contentOrNull)
    }
}
