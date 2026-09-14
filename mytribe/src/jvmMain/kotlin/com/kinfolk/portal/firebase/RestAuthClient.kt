package com.kinfolk.portal.firebase

import io.ktor.client.call.body
import io.ktor.client.request.forms.FormDataContent
import io.ktor.client.request.post
import io.ktor.client.request.setBody
import io.ktor.client.statement.HttpResponse
import io.ktor.client.statement.bodyAsText
import io.ktor.http.ContentType
import io.ktor.http.Parameters
import io.ktor.http.contentType
import io.ktor.http.isSuccess
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/**
 * Firebase Auth REST.
 *  - signInWithPassword:  identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=
 *  - exchange refresh:    securetoken.googleapis.com/v1/token?key=
 *  - lookup user:         identitytoolkit.googleapis.com/v1/accounts:lookup?key=
 */
internal class RestAuthClient {

    @Serializable
    private data class SignInRequest(
        val email: String,
        val password: String,
        val returnSecureToken: Boolean = true,
    )

    @Serializable
    internal data class SignInResponse(
        val localId: String,
        val email: String? = null,
        val displayName: String? = null,
        val idToken: String,
        val refreshToken: String,
        val expiresIn: String,
    )

    @Serializable
    private data class RefreshResponse(
        @SerialName("id_token") val idToken: String,
        @SerialName("refresh_token") val refreshToken: String,
        @SerialName("user_id") val userId: String,
        @SerialName("expires_in") val expiresIn: String,
    )

    @Serializable
    internal data class LookupResponse(val users: List<LookupUser> = emptyList())

    @Serializable
    internal data class LookupUser(
        val localId: String,
        val email: String? = null,
        val displayName: String? = null,
    )

    suspend fun signInWithPassword(email: String, password: String): SignInResponse {
        val url = "${FirebaseRestConfig.identityToolkitBase()}/accounts:signInWithPassword?key=${FirebaseRestConfig.API_KEY}"
        val res: HttpResponse = RestHttp.client.post(url) {
            contentType(ContentType.Application.Json)
            setBody(SignInRequest(email, password))
        }
        if (!res.status.isSuccess()) throw FirebaseRestException("signIn", res.status.value, res.bodyAsText())
        return res.body()
    }

    @Serializable
    private data class CustomTokenRequest(val token: String, val returnSecureToken: Boolean = true)
    @Serializable
    internal data class CustomTokenResponse(val idToken: String, val refreshToken: String)
    /** accounts:signInWithCustomToken — claim flow (server-minted account). */
    suspend fun signInWithCustomToken(token: String): CustomTokenResponse {
        val url = "${FirebaseRestConfig.identityToolkitBase()}/accounts:signInWithCustomToken?key=${FirebaseRestConfig.API_KEY}"
        val res: HttpResponse = RestHttp.client.post(url) {
            contentType(ContentType.Application.Json)
            setBody(CustomTokenRequest(token))
        }
        if (!res.status.isSuccess()) throw FirebaseRestException("customToken", res.status.value, res.bodyAsText())
        return res.body()
    }

    /** Returns Pair(idToken, uid). Updates JvmTokenStore.refreshToken if rotated. */
    suspend fun refresh(refreshToken: String): Pair<String, String> {
        val url = "${FirebaseRestConfig.secureTokenBase()}/token?key=${FirebaseRestConfig.API_KEY}"
        val res: HttpResponse = RestHttp.client.post(url) {
            setBody(
                FormDataContent(
                    Parameters.build {
                        append("grant_type", "refresh_token")
                        append("refresh_token", refreshToken)
                    }
                )
            )
        }
        if (!res.status.isSuccess()) throw FirebaseRestException("refresh", res.status.value, res.bodyAsText())
        val body: RefreshResponse = res.body()
        if (body.refreshToken != refreshToken) JvmTokenStore.refreshToken = body.refreshToken
        return body.idToken to body.userId
    }

    /** Requests a password reset via the custom Cloud Function (bypasses Firebase email). */
    suspend fun sendPasswordReset(email: String) {
        val url = FirebaseRestConfig.functionUrl("requestPasswordReset")
        val body = """{"data":{"email":${kotlinx.serialization.json.JsonPrimitive(email)}}}"""
        val res: HttpResponse = RestHttp.client.post(url) {
            contentType(ContentType.Application.Json)
            setBody(body)
        }
        if (!res.status.isSuccess()) throw FirebaseRestException("sendPasswordReset", res.status.value, res.bodyAsText())
    }

    /**
     * #886: tells `recordFailedLogin` a sign-in failed on a credential error. No
     * Authorization header: the caller has just failed to sign in, and the
     * callable is unauthenticated. Same endpoint shape as [sendPasswordReset].
     */
    suspend fun reportFailedLogin(email: String) {
        val url = FirebaseRestConfig.functionUrl("recordFailedLogin")
        val body = """{"data":{"email":${kotlinx.serialization.json.JsonPrimitive(email)}}}"""
        val res: HttpResponse = RestHttp.client.post(url) {
            contentType(ContentType.Application.Json)
            setBody(body)
        }
        if (!res.status.isSuccess()) throw FirebaseRestException("recordFailedLogin", res.status.value, res.bodyAsText())
    }

    suspend fun lookup(idToken: String): LookupUser? {
        val url = "${FirebaseRestConfig.identityToolkitBase()}/accounts:lookup?key=${FirebaseRestConfig.API_KEY}"
        val res: HttpResponse = RestHttp.client.post(url) {
            contentType(ContentType.Application.Json)
            setBody(mapOf("idToken" to idToken))
        }
        if (!res.status.isSuccess()) return null
        val parsed: LookupResponse = res.body()
        return parsed.users.firstOrNull()
    }

    @Serializable
    internal data class UpdateResponse(
        val localId: String? = null,
        val email: String? = null,
        val idToken: String? = null,
        val refreshToken: String? = null,
    )

    /** accounts:update — change password and/or email for the current user.
     *  Caller passes a FRESH idToken (re-signed-in); returnSecureToken rotates
     *  the tokens that a password change invalidates. Nulls are omitted from the
     *  body so a password-only change never sends an empty email (and vice versa). */
    suspend fun update(idToken: String, password: String? = null, email: String? = null): UpdateResponse {
        val url = "${FirebaseRestConfig.identityToolkitBase()}/accounts:update?key=${FirebaseRestConfig.API_KEY}"
        val fields = buildList {
            add("\"idToken\":${kotlinx.serialization.json.JsonPrimitive(idToken)}")
            add("\"returnSecureToken\":true")
            if (password != null) add("\"password\":${kotlinx.serialization.json.JsonPrimitive(password)}")
            if (email != null) add("\"email\":${kotlinx.serialization.json.JsonPrimitive(email)}")
        }
        val res: HttpResponse = RestHttp.client.post(url) {
            contentType(ContentType.Application.Json)
            setBody("{${fields.joinToString(",")}}")
        }
        if (!res.status.isSuccess()) throw FirebaseRestException("update", res.status.value, res.bodyAsText())
        return res.body()
    }
}

internal class FirebaseRestException(
    op: String,
    val status: Int,
    val responseBody: String,
) : RuntimeException("Firebase REST $op failed: HTTP $status — $responseBody")
