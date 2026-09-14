package com.tribetails.auntieos.web.data

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

class AuthInteropTest {
    /**
     * Regression: kotlinx.serialization defaults to encodeDefaults=false, which dropped
     * returnSecureToken=true from the signInWithPassword body. The server then returns a
     * legacy gitkit token (no custom claims, no refreshToken) and the admin gate rejects a
     * real admin account. The flag MUST be on the wire.
     */
    @Test fun signInBody_includesReturnSecureToken() {
        val body = encodeSignInRequestBody("admin@example.com", "pw")
        assertTrue(
            body.contains("\"returnSecureToken\":true"),
            "returnSecureToken must be serialized; got: $body",
        )
    }

    @Test fun signInBody_trimsEmail() {
        val body = encodeSignInRequestBody("  admin@example.com  ", "pw")
        assertTrue(body.contains("\"email\":\"admin@example.com\""), "email must be trimmed; got: $body")
    }

    /**
     * #892: the reset link opens the portal's email action page (one callbackUri per
     * project), so the continue URL is what brings staff back to the admin sign-in.
     * It must be on the wire, which is the encodeDefaults trap signIn already hit.
     */
    @Test fun passwordResetBody_continuesToAdminSignIn() {
        val body = encodePasswordResetRequestBody("  admin@example.com ")
        assertTrue(body.contains("\"requestType\":\"PASSWORD_RESET\""), "requestType; got: $body")
        assertTrue(body.contains("\"email\":\"admin@example.com\""), "email trimmed; got: $body")
        assertTrue(
            body.contains("\"continueUrl\":\"https://auntie.tribetails.com/signin\""),
            "continueUrl must be serialized; got: $body",
        )
        assertTrue(body.contains("\"canHandleCodeInApp\":false"), "canHandleCodeInApp; got: $body")
    }

    @Test fun parseRefreshedToken_readsFields() {
        val body = """{"id_token":"ID123","refresh_token":"RT456","expires_in":"3600"}"""
        val t = parseRefreshedToken(body)
        assertEquals("ID123", t?.idToken)
        assertEquals("RT456", t?.refreshToken)
        assertEquals(3600L, t?.expiresInSecs)
    }

    /** A securetoken error body carries no id_token; parsing it must NOT yield a token to fall back on. */
    @Test fun parseRefreshedToken_nullWhenNoIdToken() {
        val errorBody = """{"error":{"code":400,"message":"INVALID_REFRESH_TOKEN"}}"""
        assertNull(parseRefreshedToken(errorBody))
    }
}
