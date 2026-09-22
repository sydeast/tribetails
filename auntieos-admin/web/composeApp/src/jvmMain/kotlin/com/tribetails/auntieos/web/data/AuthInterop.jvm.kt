package com.tribetails.auntieos.web.data

import io.ktor.client.HttpClient
import io.ktor.client.call.body
import io.ktor.client.engine.java.Java
import io.ktor.client.plugins.contentnegotiation.ContentNegotiation
import io.ktor.client.request.parameter
import io.ktor.client.request.post
import io.ktor.client.request.setBody
import io.ktor.client.statement.HttpResponse
import io.ktor.client.statement.bodyAsText
import io.ktor.http.ContentType
import io.ktor.http.contentType
import io.ktor.http.isSuccess
import io.ktor.serialization.kotlinx.json.json
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import java.net.URLEncoder
import java.util.Base64

/**
 * Desktop (JVM) Firebase Auth, implemented against the Identity Toolkit REST API.
 *
 * Desktop has no Firebase SDK (GitLive has no JVM publication; the wasm target uses the
 * raw JS SDK via window.__fb). This mirrors the web admin's auth behavior exactly:
 *   - sign-in via accounts:signInWithPassword,
 *   - admin gate by reading the `admin` custom claim straight off the ID token JWT
 *     (web does getIdTokenResult().claims.admin === true),
 *   - password reset via the NATIVE accounts:sendOobCode (the AuntieOS admin web app uses
 *     sendPasswordResetEmail, not the custom MyTribe callable).
 *
 * The Web API key is a public client identifier (already shipped in firebase-bridge.js to
 * every browser), not a secret, so embedding it here is safe.
 */
/**
 * Shared Json for the desktop auth REST calls. Mirror the JVM Firestore layer
 * (`JvmFirestoreRest.codec`, `FirestoreInterop.jvm.kt`): request bodies MUST encode
 * default-valued fields, or `returnSecureToken=true` is silently dropped on the wire.
 */
internal val authRestJson = Json { ignoreUnknownKeys = true; isLenient = true; encodeDefaults = true }

@Serializable
internal data class SignInRequest(
    val email: String,
    val password: String,
    val returnSecureToken: Boolean = true,
)

/** Serializes the signInWithPassword body exactly as it is posted on the wire (test seam). */
internal fun encodeSignInRequestBody(email: String, password: String): String =
    authRestJson.encodeToString(SignInRequest(email.trim(), password))

/** Where an admin reset link continues once the password is set (#892). */
internal const val ADMIN_SIGN_IN_URL = "https://auntie.tribetails.com/signin"

/**
 * accounts:sendOobCode body for a password reset.
 *
 * #892: the link opens the project's email action page on the portal
 * (Identity Toolkit's callbackUri is one URL per project). `continueUrl` sends
 * staff back to the admin sign-in instead of the kinfolk portal. Non-null with
 * defaults, so `encodeDefaults = true` always puts it on the wire.
 */
@Serializable
internal data class PasswordResetOobRequest(
    val email: String,
    val requestType: String = "PASSWORD_RESET",
    val continueUrl: String = ADMIN_SIGN_IN_URL,
    val canHandleCodeInApp: Boolean = false,
)

/** Serializes the password-reset sendOobCode body exactly as it is posted on the wire (test seam). */
internal fun encodePasswordResetRequestBody(email: String): String =
    authRestJson.encodeToString(PasswordResetOobRequest(email = email.trim()))

/** Parsed securetoken refresh response. */
internal data class RefreshedToken(val idToken: String, val refreshToken: String?, val expiresInSecs: Long)

/** Parse a securetoken refresh body. Returns null when no id_token is present (e.g. an error body). */
internal fun parseRefreshedToken(bodyText: String): RefreshedToken? = runCatching {
    val obj = authRestJson.parseToJsonElement(bodyText).jsonObject
    val id = obj["id_token"]?.jsonPrimitive?.content ?: return null
    RefreshedToken(
        idToken = id,
        refreshToken = obj["refresh_token"]?.jsonPrimitive?.content,
        expiresInSecs = obj["expires_in"]?.jsonPrimitive?.content?.toLongOrNull() ?: 3600L,
    )
}.getOrNull()

/**
 * Map an Identity Toolkit error body to the `auth/...` code AuthClient.friendly understands.
 * Internal (not private) so jvmTest can pin it, like [encodeSignInRequestBody].
 *
 * #886: `beforeSignIn`'s refusal of a locked account comes back as
 * `BLOCKING_FUNCTION_ERROR_RESPONSE : ((... {"error":{"message":"This account is locked. ..."}}))`
 * (verbatim from the Auth emulator). It is checked first and becomes
 * [ACCOUNT_LOCKED_CODE]; left to the `else` branch it would have been painted
 * as "Couldn't sign you in: BLOCKING_FUNCTION_ERROR_RESPONSE : ((HTTP request...".
 */
internal fun mapIdentityToolkitError(errBody: String): String {
    val message = runCatching {
        authRestJson.parseToJsonElement(errBody).jsonObject["error"]?.jsonObject
            ?.get("message")?.jsonPrimitive?.content
    }.getOrNull() ?: ""
    return when {
        message.startsWith("BLOCKING_FUNCTION_ERROR_RESPONSE") &&
            message.contains("account is locked", ignoreCase = true) -> ACCOUNT_LOCKED_CODE
        message.startsWith("EMAIL_NOT_FOUND") -> "auth/user-not-found"
        message.startsWith("INVALID_PASSWORD") -> "auth/wrong-password"
        message.startsWith("INVALID_LOGIN_CREDENTIALS") -> "auth/invalid-credential"
        message.startsWith("INVALID_EMAIL") -> "auth/invalid-email"
        message.startsWith("TOO_MANY_ATTEMPTS_TRY_LATER") -> "auth/too-many-requests"
        message.startsWith("USER_DISABLED") -> "auth/user-disabled"
        message.startsWith("EMAIL_EXISTS") -> "auth/email-already-in-use"
        message.startsWith("WEAK_PASSWORD") -> "auth/weak-password"
        message.startsWith("CREDENTIAL_TOO_OLD") || message.startsWith("TOKEN_EXPIRED") -> "auth/requires-recent-login"
        message.isBlank() -> "auth/unknown"
        else -> message
    }
}

private object FirebaseRestAuth {
    private const val API_KEY = "AIzaSyBnR7D4gORVehTr_-WB42_NyFeNO7acDTo"
    private const val IDENTITY = "https://identitytoolkit.googleapis.com/v1/accounts"
    private const val SECURETOKEN = "https://securetoken.googleapis.com/v1/token"

    private val json = authRestJson
    // #867: timeouts and the test network guard come from the shared factory.
    private val http = auntieHttpClient {
        install(ContentNegotiation) { json(json) }
    }

    private val mutex = Mutex()
    val authState = MutableStateFlow<AuthUser?>(null)

    // Session token state; null when signed out.
    private var idToken: String? = null
    private var refreshToken: String? = null
    private var localId: String? = null
    private var email: String? = null
    private var expiresAtMillis: Long = 0L

    val currentUid: String? get() = localId

    @Serializable
    private data class SignInResponse(
        val idToken: String = "",
        val refreshToken: String = "",
        val expiresIn: String = "3600",
        val localId: String = "",
        val email: String = "",
    )

    suspend fun signIn(emailArg: String, password: String): SignInResult = mutex.withLock {
        val resp: HttpResponse = try {
            http.post("$IDENTITY:signInWithPassword") {
                parameter("key", API_KEY)
                contentType(ContentType.Application.Json)
                setBody(SignInRequest(emailArg.trim(), password))
            }
        } catch (e: Exception) {
            return@withLock SignInResult.Failure("auth/network-request-failed")
        }
        if (!resp.status.isSuccess()) {
            return@withLock SignInResult.Failure(mapError(resp.bodyAsText()))
        }
        val body = resp.body<SignInResponse>()
        idToken = body.idToken
        refreshToken = body.refreshToken
        localId = body.localId
        email = body.email.ifBlank { emailArg.trim() }
        expiresAtMillis = nowMillis() + (body.expiresIn.toLongOrNull() ?: 3600L) * 1000L
        val user = AuthUser(uid = localId ?: "", email = email)
        authState.value = user
        SignInResult.Ok(user)
    }

    suspend fun signOut() = mutex.withLock {
        idToken = null; refreshToken = null; localId = null; email = null; expiresAtMillis = 0L
        authState.value = null
    }

    suspend fun freshIdToken(forceRefresh: Boolean): String? = mutex.withLock {
        val rt = refreshToken ?: return@withLock null
        if (forceRefresh || nowMillis() >= expiresAtMillis - 60_000L) {
            // Fail loud, never fake (CLAUDE.md): an attempted-but-failed refresh must NOT
            // silently fall back to the stale token. Surface it and fail closed (return null),
            // so the admin gate rejects visibly and Firestore calls 401 rather than masking.
            val refreshed = try {
                http.post(SECURETOKEN) {
                    parameter("key", API_KEY)
                    contentType(ContentType.Application.FormUrlEncoded)
                    // URL-encode the refresh token: a raw value containing `&`, `=`,
                    // `+` or other reserved chars would otherwise corrupt the form body
                    // and fail (or mis-parse) the refresh (NOTE-62).
                    setBody("grant_type=refresh_token&refresh_token=${URLEncoder.encode(rt, "UTF-8")}")
                }
            } catch (e: Exception) {
                System.err.println("[AuntieOS][auth] token refresh request failed: ${e.message}")
                com.tribetails.auntieos.web.observability.reportError(e, context = "auth.tokenRefresh")
                return@withLock null
            }
            if (!refreshed.status.isSuccess()) {
                System.err.println("[AuntieOS][auth] token refresh rejected: ${refreshed.status} ${refreshed.bodyAsText()}")
                com.tribetails.auntieos.web.observability.reportMessage(
                    "auth token refresh rejected: ${refreshed.status}", fatal = false,
                )
                return@withLock null
            }
            val parsed = parseRefreshedToken(refreshed.bodyAsText())
            if (parsed == null) {
                System.err.println("[AuntieOS][auth] token refresh returned no id_token")
                com.tribetails.auntieos.web.observability.reportMessage(
                    "auth token refresh returned no id_token", fatal = false,
                )
                return@withLock null
            }
            idToken = parsed.idToken
            refreshToken = parsed.refreshToken ?: refreshToken
            expiresAtMillis = nowMillis() + parsed.expiresInSecs * 1000L
        }
        idToken
    }

    suspend fun isAdmin(forceRefresh: Boolean): Boolean {
        val token = freshIdToken(forceRefresh) ?: return false
        return adminClaimOf(token)
    }

    /** Stage 0I: decode the `testTribeId` string claim off the current ID token. */
    suspend fun testTribeId(forceRefresh: Boolean): String? {
        val token = freshIdToken(forceRefresh) ?: return null
        return testTribeIdClaimOf(token)
    }

    suspend fun sendPasswordReset(emailArg: String): Boolean {
        return try {
            val resp = http.post("$IDENTITY:sendOobCode") {
                parameter("key", API_KEY)
                contentType(ContentType.Application.Json)
                setBody(PasswordResetOobRequest(email = emailArg.trim()))
            }
            resp.status.isSuccess()
        } catch (e: Exception) {
            false
        }
    }

    /** Decode the `admin` custom claim from a Firebase ID token (JWT) payload. */
    private fun adminClaimOf(jwt: String): Boolean = runCatching {
        val payload = jwt.split(".").getOrNull(1) ?: return false
        val decoded = Base64.getUrlDecoder().decode(payload.padEnd((payload.length + 3) / 4 * 4, '='))
        val claims: JsonObject = json.parseToJsonElement(decoded.decodeToString()).jsonObject
        claims["admin"]?.jsonPrimitive?.booleanOrNull == true
    }.getOrDefault(false)

    /** Decode the `testTribeId` string custom claim from a Firebase ID token (JWT) payload. */
    private fun testTribeIdClaimOf(jwt: String): String? = runCatching {
        val payload = jwt.split(".").getOrNull(1) ?: return null
        val decoded = Base64.getUrlDecoder().decode(payload.padEnd((payload.length + 3) / 4 * 4, '='))
        val claims: JsonObject = json.parseToJsonElement(decoded.decodeToString()).jsonObject
        claims["testTribeId"]?.jsonPrimitive?.contentOrNull?.ifBlank { null }
    }.getOrNull()

    /** Map an Identity Toolkit error body to the `auth/...` code AuthClient.friendly understands. */
    private fun mapError(errBody: String): String = mapIdentityToolkitError(errBody)

    @Serializable
    private data class UpdatePasswordRequest(val idToken: String, val password: String, val returnSecureToken: Boolean = true)

    @Serializable
    private data class ChangeEmailOobRequest(val requestType: String, val idToken: String, val email: String, val newEmail: String)

    /** Reauthenticate by re-signing-in (proves the current password + mints a fresh
     *  token, satisfying requires-recent-login). Returns the fresh idToken or a Failure. */
    private suspend fun reauthToken(currentPassword: String): Result<String> {
        val em = email ?: return Result.failure(AuthOpException("auth/no-current-user"))
        val resp = try {
            http.post("$IDENTITY:signInWithPassword") {
                parameter("key", API_KEY); contentType(ContentType.Application.Json)
                setBody(SignInRequest(em, currentPassword))
            }
        } catch (e: Exception) { return Result.failure(AuthOpException("auth/network-request-failed")) }
        if (!resp.status.isSuccess()) return Result.failure(AuthOpException(mapError(resp.bodyAsText())))
        return Result.success(resp.body<SignInResponse>().idToken)
    }

    suspend fun updatePassword(currentPassword: String, newPassword: String): AuthOpResult = mutex.withLock {
        val token = reauthToken(currentPassword).getOrElse { return@withLock AuthOpResult.Failure((it as AuthOpException).code) }
        val resp = try {
            http.post("$IDENTITY:update") {
                parameter("key", API_KEY); contentType(ContentType.Application.Json)
                setBody(UpdatePasswordRequest(token, newPassword))
            }
        } catch (e: Exception) { return@withLock AuthOpResult.Failure("auth/network-request-failed") }
        if (!resp.status.isSuccess()) return@withLock AuthOpResult.Failure(mapError(resp.bodyAsText()))
        // accounts:update returns refreshed tokens; swap them in so the session stays valid.
        runCatching { resp.body<SignInResponse>() }.getOrNull()?.let { updated ->
            if (updated.idToken.isNotBlank()) {
                idToken = updated.idToken
                if (updated.refreshToken.isNotBlank()) refreshToken = updated.refreshToken
                expiresAtMillis = nowMillis() + (updated.expiresIn.toLongOrNull() ?: 3600L) * 1000L
            }
        }
        AuthOpResult.Ok
    }

    suspend fun updateEmail(currentPassword: String, newEmail: String): AuthOpResult = mutex.withLock {
        val token = reauthToken(currentPassword).getOrElse { return@withLock AuthOpResult.Failure((it as AuthOpException).code) }
        val em = email ?: return@withLock AuthOpResult.Failure("auth/no-current-user")
        // Verify-before-update: sends a confirm link to the new address; the email
        // only flips after the operator confirms (parity with the web SDK contract).
        val resp = try {
            http.post("$IDENTITY:sendOobCode") {
                parameter("key", API_KEY); contentType(ContentType.Application.Json)
                setBody(ChangeEmailOobRequest("VERIFY_AND_CHANGE_EMAIL", token, em, newEmail.trim()))
            }
        } catch (e: Exception) { return@withLock AuthOpResult.Failure("auth/network-request-failed") }
        if (!resp.status.isSuccess()) return@withLock AuthOpResult.Failure(mapError(resp.bodyAsText()))
        AuthOpResult.Ok
    }

    private fun nowMillis(): Long = System.currentTimeMillis()
}

/** Carries an auth/... code through Result.failure for the credential-update flows. */
private class AuthOpException(val code: String) : Exception(code)

/** Shared accessor so the JVM Firestore REST layer can authorize its calls with the
 *  signed-in user's bearer token (auto-refreshed). Returns null when signed out. */
internal suspend fun jvmFirebaseIdToken(): String? = FirebaseRestAuth.freshIdToken(false)

/** Signed-in user's uid (for recipient-scoped reads like notifications). Null when signed out. */
internal fun jvmFirebaseUid(): String? = FirebaseRestAuth.currentUid

internal actual fun platformAuthStateStream(): Flow<AuthUser?> = FirebaseRestAuth.authState
internal actual suspend fun platformSignIn(email: String, password: String): SignInResult =
    FirebaseRestAuth.signIn(email, password)

/**
 * #886: POSTs `{"data":{"email":...}}` to the `recordFailedLogin` callable. Straight to
 * [JvmFirestoreRest.callable], not through the revocation-aware seam: there is no
 * session to end, and no signed-in token rides along after a failed sign-in.
 */
internal actual suspend fun platformReportFailedLogin(email: String) {
    val payload = "{\"email\":${kotlinx.serialization.json.JsonPrimitive(email)}}"
    val result = JvmFirestoreRest.callable("recordFailedLogin", payload)
    if (result is WriteResult.Err) throw IllegalStateException("recordFailedLogin failed: $result")
}
internal actual suspend fun platformSignOut() = FirebaseRestAuth.signOut()
internal actual suspend fun platformSendPasswordReset(email: String): Boolean =
    FirebaseRestAuth.sendPasswordReset(email)
internal actual suspend fun platformIdToken(forceRefresh: Boolean): String? =
    FirebaseRestAuth.freshIdToken(forceRefresh)
internal actual suspend fun platformIsCurrentUserAdmin(forceRefresh: Boolean): Boolean =
    FirebaseRestAuth.isAdmin(forceRefresh)
internal actual suspend fun platformTestTribeId(forceRefresh: Boolean): String? =
    FirebaseRestAuth.testTribeId(forceRefresh)
internal actual suspend fun platformUpdateEmail(currentPassword: String, newEmail: String): AuthOpResult =
    FirebaseRestAuth.updateEmail(currentPassword, newEmail)
internal actual suspend fun platformUpdatePassword(currentPassword: String, newPassword: String): AuthOpResult =
    FirebaseRestAuth.updatePassword(currentPassword, newPassword)
