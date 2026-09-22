package com.kinfolk.portal.firebase

import com.kinfolk.portal.auth.EmailAction
import io.ktor.client.HttpClient
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
 *
 * #889 review, item 5: [client] and [endpoints] are constructor params, not
 * RestHttp.client and FirebaseRestConfig read directly, so a test can inject
 * a MockEngine client and an explicit RestEndpoints instance and assert the
 * outgoing URL without touching process env or a real socket.
 */
internal class RestAuthClient(
    private val client: HttpClient = RestHttp.client,
    private val endpoints: RestEndpoints = FirebaseRestConfig,
) {

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
        val url = "${endpoints.identityToolkitBase()}/accounts:signInWithPassword?key=${endpoints.API_KEY}"
        val res: HttpResponse = client.post(url) {
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
        val url = "${endpoints.identityToolkitBase()}/accounts:signInWithCustomToken?key=${endpoints.API_KEY}"
        val res: HttpResponse = client.post(url) {
            contentType(ContentType.Application.Json)
            setBody(CustomTokenRequest(token))
        }
        if (!res.status.isSuccess()) throw FirebaseRestException("customToken", res.status.value, res.bodyAsText())
        return res.body()
    }

    /** Returns Pair(idToken, uid). Updates JvmTokenStore.refreshToken if rotated. */
    suspend fun refresh(refreshToken: String): Pair<String, String> {
        val url = "${endpoints.secureTokenBase()}/token?key=${endpoints.API_KEY}"
        val res: HttpResponse = client.post(url) {
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

    /**
     * Requests a password reset through Firebase's own
     * `accounts:sendOobCode`, the REST call `sendPasswordResetEmail` makes.
     *
     * #911: this used to post the `requestPasswordReset` callable, which capped
     * an address at 3 resets a day and then answered `{ ok: true }` while
     * sending nothing, so spending that budget silently blocked a household's
     * resets from desktop for 24 hours. Identity Toolkit has Google's own abuse
     * limits and no per-email budget an attacker can drain.
     *
     * The host comes from [endpoints] (#889), so `FIREBASE_AUTH_EMULATOR_HOST`
     * sends this at the Auth emulator exactly as it does sign-in. `continueUrl`
     * is a link destination rather than a call target, and is the same portal
     * sign-in the Android app and portal web ask for.
     *
     * An address that is not an account fails here with `EMAIL_NOT_FOUND`;
     * [AuthRepository.sendPasswordReset] absorbs that so no screen can report
     * it. Trimmed for the same reason the Android send trims.
     */
    suspend fun sendPasswordReset(email: String) {
        val url = "${endpoints.identityToolkitBase()}/accounts:sendOobCode?key=${endpoints.API_KEY}"
        val res: HttpResponse = client.post(url) {
            contentType(ContentType.Application.Json)
            setBody(passwordResetOobBody(email))
        }
        if (!res.status.isSuccess()) throw FirebaseRestException("sendPasswordReset", res.status.value, res.bodyAsText())
    }

    /**
     * #886: tells `recordFailedLogin` a sign-in failed on a credential error. No
     * Authorization header: the caller has just failed to sign in, and the
     * callable is unauthenticated. Same endpoint shape as [sendPasswordReset].
     */
    suspend fun reportFailedLogin(email: String) {
        val url = endpoints.functionUrl("recordFailedLogin")
        val body = """{"data":{"email":${kotlinx.serialization.json.JsonPrimitive(email)}}}"""
        val res: HttpResponse = client.post(url) {
            contentType(ContentType.Application.Json)
            setBody(body)
        }
        if (!res.status.isSuccess()) throw FirebaseRestException("recordFailedLogin", res.status.value, res.bodyAsText())
    }

    suspend fun lookup(idToken: String): LookupUser? {
        val url = "${endpoints.identityToolkitBase()}/accounts:lookup?key=${endpoints.API_KEY}"
        val res: HttpResponse = client.post(url) {
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
        val url = "${endpoints.identityToolkitBase()}/accounts:update?key=${endpoints.API_KEY}"
        val fields = buildList {
            add("\"idToken\":${kotlinx.serialization.json.JsonPrimitive(idToken)}")
            add("\"returnSecureToken\":true")
            if (password != null) add("\"password\":${kotlinx.serialization.json.JsonPrimitive(password)}")
            if (email != null) add("\"email\":${kotlinx.serialization.json.JsonPrimitive(email)}")
        }
        val res: HttpResponse = client.post(url) {
            contentType(ContentType.Application.Json)
            setBody("{${fields.joinToString(",")}}")
        }
        if (!res.status.isSuccess()) throw FirebaseRestException("update", res.status.value, res.bodyAsText())
        return res.body()
    }
}

/**
 * The `accounts:sendOobCode` body for a password reset, exactly as it goes on
 * the wire (#911).
 *
 * A top-level function rather than a private detail so a test can pin the four
 * fields without a socket, the way the admin desktop pins its own
 * (`encodePasswordResetRequestBody`, AuthInterop.jvm.kt). `encodeDefaults` is
 * on in [RestHttp.json], so `requestType`, `continueUrl` and
 * `canHandleCodeInApp` are all written even though they are defaulted.
 */
internal fun passwordResetOobBody(email: String): String =
    RestHttp.json.encodeToString(PasswordResetOobRequest(email = email.trim()))
@Serializable
internal data class PasswordResetOobRequest(
    val email: String,
    val requestType: String = "PASSWORD_RESET",
    /** Where the link continues once the password is set. Same target as portal web and Android. */
    val continueUrl: String = EmailAction.PORTAL_SIGN_IN_URL,
    val canHandleCodeInApp: Boolean = false,
)
internal class FirebaseRestException(
    op: String,
    val status: Int,
    val responseBody: String,
) : RuntimeException("Firebase REST $op failed: HTTP $status — $responseBody")
