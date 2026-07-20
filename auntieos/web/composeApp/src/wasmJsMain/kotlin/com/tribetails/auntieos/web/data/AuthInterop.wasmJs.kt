package com.tribetails.auntieos.web.data

import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlin.coroutines.resume

private val json = Json { ignoreUnknownKeys = true; isLenient = true }

@JsFun("(email, password, cb) => window.__fb.signIn(email, password, cb)")
private external fun jsSignIn(email: String, password: String, cb: (String) -> Unit)

@JsFun("(cb) => window.__fb.signOut(cb)")
private external fun jsSignOut(cb: (String) -> Unit)

@JsFun("(cb) => window.__fb.onAuthChange(cb)")
private external fun jsOnAuthChange(cb: (String) -> Unit): JsAny

@JsFun("(email, cb) => window.__fb.sendPasswordReset(email, cb)")
private external fun jsSendPasswordReset(email: String, cb: (String) -> Unit)

@JsFun("(forceRefresh, cb) => window.__fb.getIdToken(forceRefresh, cb)")
private external fun jsGetIdToken(forceRefresh: Boolean, cb: (String) -> Unit)

@JsFun("(forceRefresh, cb) => window.__fb.isCurrentUserAdmin(forceRefresh, cb)")
private external fun jsIsCurrentUserAdmin(forceRefresh: Boolean, cb: (Boolean) -> Unit)

@JsFun("(forceRefresh, cb) => window.__fb.testTribeId ? window.__fb.testTribeId(forceRefresh, cb) : cb('')")
private external fun jsTestTribeId(forceRefresh: Boolean, cb: (String) -> Unit)

@JsFun("(cur, next, cb) => window.__fb.updateLoginEmail(cur, next, cb)")
private external fun jsUpdateLoginEmail(cur: String, next: String, cb: (String) -> Unit)

@JsFun("(cur, next, cb) => window.__fb.updateLoginPassword(cur, next, cb)")
private external fun jsUpdateLoginPassword(cur: String, next: String, cb: (String) -> Unit)

internal actual fun platformAuthStateStream(): Flow<AuthUser?> = callbackFlow {
    val unsub = jsOnAuthChange { payload ->
        val user = if (payload == "null") null
                   else runCatching { json.decodeFromString<AuthUser>(payload) }.getOrNull()
        trySend(user)
    }
    awaitClose { /* Firebase onAuthStateChanged returns an unsubscribe but we don't need it during the app lifetime */ }
}

internal actual suspend fun platformSignIn(email: String, password: String): SignInResult =
    suspendCancellableCoroutine { cont ->
        jsSignIn(email, password) { payload ->
            val obj = json.parseToJsonElement(payload).jsonObject
            val ok = obj["ok"]?.jsonPrimitive?.boolean ?: false
            if (ok) {
                val user = AuthUser(
                    uid   = obj["uid"]?.jsonPrimitive?.content ?: "",
                    email = obj["email"]?.jsonPrimitive?.content,
                )
                cont.resume(SignInResult.Ok(user))
            } else {
                val err = obj["error"]?.jsonPrimitive?.content ?: "auth/unknown"
                cont.resume(SignInResult.Failure(err))
            }
        }
    }

internal actual suspend fun platformSignOut(): Unit =
    suspendCancellableCoroutine { cont ->
        jsSignOut { _ -> cont.resume(Unit) }
    }

internal actual suspend fun platformSendPasswordReset(email: String): Boolean =
    suspendCancellableCoroutine { cont ->
        jsSendPasswordReset(email) { result -> cont.resume(result == "ok") }
    }

internal actual suspend fun platformIdToken(forceRefresh: Boolean): String? =
    suspendCancellableCoroutine { cont ->
        jsGetIdToken(forceRefresh) { result ->
            cont.resume(result.ifBlank { null })
        }
    }

internal actual suspend fun platformIsCurrentUserAdmin(forceRefresh: Boolean): Boolean =
    suspendCancellableCoroutine { cont ->
        jsIsCurrentUserAdmin(forceRefresh) { result ->
            cont.resume(result)
        }
    }

internal actual suspend fun platformTestTribeId(forceRefresh: Boolean): String? =
    suspendCancellableCoroutine { cont ->
        jsTestTribeId(forceRefresh) { result ->
            cont.resume(result.ifBlank { null })
        }
    }

private fun parseAuthOp(payload: String): AuthOpResult {
    val obj = json.parseToJsonElement(payload).jsonObject
    val ok = obj["ok"]?.jsonPrimitive?.boolean ?: false
    return if (ok) AuthOpResult.Ok
           else AuthOpResult.Failure(obj["error"]?.jsonPrimitive?.content ?: "auth/unknown")
}

internal actual suspend fun platformUpdateEmail(currentPassword: String, newEmail: String): AuthOpResult =
    suspendCancellableCoroutine { cont ->
        jsUpdateLoginEmail(currentPassword, newEmail) { payload -> cont.resume(parseAuthOp(payload)) }
    }

internal actual suspend fun platformUpdatePassword(currentPassword: String, newPassword: String): AuthOpResult =
    suspendCancellableCoroutine { cont ->
        jsUpdateLoginPassword(currentPassword, newPassword) { payload -> cont.resume(parseAuthOp(payload)) }
    }
