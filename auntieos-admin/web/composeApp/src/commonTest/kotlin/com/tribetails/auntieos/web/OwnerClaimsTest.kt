package com.tribetails.auntieos.web

import com.tribetails.auntieos.web.data.TestMode
import com.tribetails.auntieos.web.data.allowIntoApp
import com.tribetails.auntieos.web.data.ownerFromClaims
import com.tribetails.auntieos.web.data.sandboxTribeIdFromClaims
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * The desktop console's admit check. The owner gate matches the web role rule
 * (`lib/access.ts`): the `admin` claim and not the Auntie role, and an Auntie
 * gets no sandbox.
 */
class OwnerClaimsTest {

    private fun claims(raw: String): JsonObject = Json.parseToJsonElement(raw).jsonObject

    /** What the console's gate decides for one decoded token. */
    private fun admitted(raw: String): Boolean {
        val c = claims(raw)
        return allowIntoApp(ownerFromClaims(c), TestMode.fromClaim(sandboxTribeIdFromClaims(c)))
    }

    @Test
    fun theOwnerClaimAloneIsAdmitted() {
        assertTrue(ownerFromClaims(claims("""{"admin":true}""")))
        assertTrue(admitted("""{"admin":true}"""))
    }

    @Test
    fun anAccountHoldingBothClaimsIsNotTheOwnerAndIsNotAdmitted() {
        assertFalse(ownerFromClaims(claims("""{"admin":true,"staffRole":"auntie"}""")))
        assertFalse(admitted("""{"admin":true,"staffRole":"auntie"}"""))
    }

    @Test
    fun anAuntieGetsNoSandboxEvenWithTheTestClaim() {
        assertNull(sandboxTribeIdFromClaims(claims("""{"staffRole":"auntie","testTribeId":"test-kinfolk-001"}""")))
        assertFalse(admitted("""{"staffRole":"auntie","testTribeId":"test-kinfolk-001"}"""))
        assertFalse(admitted("""{"admin":true,"staffRole":"auntie","testTribeId":"test-kinfolk-001"}"""))
    }

    @Test
    fun theSandboxTestAdminIsStillAdmitted() {
        assertEquals("test-kinfolk-001", sandboxTribeIdFromClaims(claims("""{"testTribeId":" test-kinfolk-001 "}"""))?.trim())
        assertTrue(admitted("""{"testTribeId":"test-kinfolk-001"}"""))
        assertNull(sandboxTribeIdFromClaims(claims("""{"testTribeId":"  "}""")))
    }

    @Test
    fun aStringAdminValueOrNoClaimIsNotTheOwner() {
        assertFalse(ownerFromClaims(claims("""{"admin":"true"}""")))
        assertFalse(ownerFromClaims(claims("""{}""")))
        assertFalse(admitted("""{}"""))
    }
}
