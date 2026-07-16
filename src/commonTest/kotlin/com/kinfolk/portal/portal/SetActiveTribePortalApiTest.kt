package com.kinfolk.portal.portal

import com.kinfolk.portal.firebase.FakeFunctionsClient
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonPrimitive
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith

/** O-5: setActiveTribe claim re-mint — PortalApi callable wiring test. */
class SetActiveTribePortalApiTest {

    @Test
    fun setActiveTribe_sendsThePickedKinfolkId() = runTest {
        val fake = FakeFunctionsClient()
        fake.stub("setActiveTribe", buildJsonObject { })
        val api = PortalApi(fake)

        api.setActiveTribe("kf2")

        assertEquals("setActiveTribe", fake.calls[0].first)
        val payload = fake.calls[0].second!!
        assertEquals("kf2", payload["kinfolkId"]?.jsonPrimitive?.contentOrNull)
    }

    @Test
    fun setActiveTribe_propagatesCallableErrors() = runTest {
        val fake = FakeFunctionsClient()
        fake.stubError("setActiveTribe", RuntimeException("permission-denied"))
        val api = PortalApi(fake)
        val failure = assertFailsWith<RuntimeException> { api.setActiveTribe("kf2") }
        assertEquals("permission-denied", failure.message)
    }
}
