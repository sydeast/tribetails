package com.kinfolk.portal.screens.tribe

import com.kinfolk.portal.firebase.FakeFunctionsClient
import com.kinfolk.portal.portal.PortalApi
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

/**
 * #1336: with an admin home-access schema driving the Tribe screen, emptying the
 * gate code fell back to the static field, which still held the loaded code, so
 * the save re-sent the old value and the clear never happened.
 */
class HomeAccessSchemaClearTest {

    @Test
    fun anEmptiedSchemaFieldIsAClearNotAFallBackToTheSeed() {
        assertNull(schemaTextOrNull(mapOf("gateCode" to "  "), "gateCode", "1234"))
    }

    @Test
    fun aKeyTheSchemaDoesNotCarryFallsBackToTheStaticField() {
        assertEquals("1234", schemaTextOrNull(emptyMap(), "gateCode", " 1234 "))
        assertNull(schemaTextOrNull(emptyMap(), "gateCode", ""))
    }

    @Test
    fun aSchemaValueIsTrimmed() {
        assertEquals("Under the mat", schemaTextOrNull(mapOf("keyLocation" to " Under the mat "), "keyLocation", "Lockbox"))
    }

    @Test
    fun theClearedGateCodeGoesAsJsonNullBesideTheUntouchedOnes() = runTest {
        val values = mapOf("gateCode" to "", "keyLocation" to "Lockbox", "wifiPassword" to "pw")
        val fake = FakeFunctionsClient()
        fake.stub("saveHomeAccess", buildJsonObject { put("ok", true) })
        PortalApi(fake).saveHomeAccess(
            gateCode = schemaTextOrNull(values, "gateCode", "1234"),
            keyLocation = schemaTextOrNull(values, "keyLocation", "Lockbox"),
            wifiPassword = schemaTextOrNull(values, "wifiPassword", "pw"),
        )
        val body = fake.calls.single().second!!
        assertEquals(JsonNull, body["gateCode"])
        assertEquals("Lockbox", body["keyLocation"]!!.jsonPrimitive.content)
    }
}
