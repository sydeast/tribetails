package com.kinfolk.portal.portal

import com.kinfolk.portal.config.FeatureFlags
import com.kinfolk.portal.firebase.FakeFunctionsClient
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonObject
import kotlin.test.Test
import kotlin.test.assertEquals

class PortalApiFeatureFlagsTest {

    // All `mytribe.*` flags were removed; getFeatureFlags() always returns an
    // empty FeatureFlags() and any remote payload is ignored. The callable
    // plumbing is kept so the App provider still compiles.

    @Test
    fun `getFeatureFlags calls the callable and returns empty flags`() = runTest {
        val fake = FakeFunctionsClient()
        fake.stub("getFeatureFlags", buildJsonObject {
            putJsonObject("flags") {
                put("mytribe.invoice.downloadPdf", true)
                put("mytribe.auth.showPasswordToggle", false)
            }
        })
        val flags = PortalApi(fake).getFeatureFlags()
        assertEquals(FeatureFlags(), flags)
        assertEquals("getFeatureFlags", fake.calls.single().first)
    }

    @Test
    fun `getFeatureFlags returns empty flags when flags map is absent`() = runTest {
        val fake = FakeFunctionsClient()
        fake.stub("getFeatureFlags", buildJsonObject { })
        val flags = PortalApi(fake).getFeatureFlags()
        assertEquals(FeatureFlags(), flags)
    }

    @Test
    fun `getFeatureFlags ignores unknown remote keys`() = runTest {
        val fake = FakeFunctionsClient()
        fake.stub("getFeatureFlags", buildJsonObject {
            putJsonObject("flags") { put("mytribe.bogus.key", true) }
        })
        val flags = PortalApi(fake).getFeatureFlags()
        assertEquals(FeatureFlags(), flags)
    }
}
