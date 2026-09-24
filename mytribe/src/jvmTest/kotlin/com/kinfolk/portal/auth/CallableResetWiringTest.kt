package com.kinfolk.portal.auth

import java.io.File
import kotlin.test.Test
import kotlin.test.assertFalse
import kotlin.test.assertTrue
import kotlin.test.fail

/**
 * #905: the Android and web backend sends resets through our own
 * `requestPasswordReset` callable, not Firebase's `sendPasswordResetEmail`.
 * (Named NativeResetWiringTest under #911, which pinned the opposite; this is
 * that test inverted.)
 *
 * `FirebaseAuthBackend` lives in `firebaseMain`, which compiles only for
 * Android and Kotlin/JS and has no test source set, and it reaches the SDK
 * through the `Firebase.functions` global, which nothing here can substitute.
 * So this reads the file, the way `AppLinkManifestTest` reads the Android
 * manifest and `AppCheckWiringTest` reads `build.gradle.kts`. It is a wiring
 * test, not a behaviour test: it proves which call the Android app makes and
 * which one it no longer makes, and `testDebugUnitTest` proves that call
 * compiles against the real SDK.
 *
 * The behaviour around the call (what the household reads for a rate limit or
 * a failure) is real-test covered in [PasswordResetSendTest] (shared),
 * `SignInScreenResetSendTest` (the screen) and `RestAuthResetSendTest`
 * (desktop, through the REST stack).
 */
class CallableResetWiringTest {

    private fun moduleRoot(): File {
        var dir: File? = File(System.getProperty("user.dir")).absoluteFile
        while (dir != null) {
            if (File(dir, "src/commonTest").isDirectory && File(dir, "build.gradle.kts").isFile) {
                return dir
            }
            dir = dir.parentFile
        }
        fail("Could not find the mytribe module root from ${System.getProperty("user.dir")}")
    }

    private val source: String by lazy {
        val f = File(moduleRoot(), "src/firebaseMain/kotlin/com/kinfolk/portal/auth/FirebaseAuthBackend.kt")
        assertTrue(f.isFile, "Expected src/firebaseMain/kotlin/com/kinfolk/portal/auth/FirebaseAuthBackend.kt to exist")
        f.readText()
    }

    /** The body of `override suspend fun sendPasswordReset`, brace-matched. */
    private val sendBody: String by lazy {
        val start = source.indexOf("override suspend fun sendPasswordReset(")
        if (start < 0) fail("FirebaseAuthBackend has no sendPasswordReset override")
        val open = source.indexOf('{', start)
        var depth = 0
        var i = open
        while (i < source.length) {
            if (source[i] == '{') depth++
            if (source[i] == '}') {
                depth--
                if (depth == 0) return@lazy source.substring(open, i + 1)
            }
            i++
        }
        fail("sendPasswordReset's body is not brace-balanced")
    }

    @Test
    fun theAndroidAndWebBackendCallsTheRequestPasswordResetCallable() {
        assertTrue(
            "httpsCallable(\"requestPasswordReset\")" in sendBody,
            "expected sendPasswordReset to call the requestPasswordReset callable (#905), got: $sendBody",
        )
    }

    /**
     * The point of #905. Firebase's reset email uses a console template this
     * project cannot edit, so a household would keep getting Firebase's
     * wording instead of the operator's.
     */
    @Test
    fun itNoLongerSendsFirebasesOwnResetEmail() {
        assertFalse(
            "sendPasswordResetEmail" in sendBody,
            "sendPasswordReset must not call the SDK's sendPasswordResetEmail (#905), got: $sendBody",
        )
        // A call, not a mention: the KDoc names the SDK method it replaced.
        assertFalse(
            "sendPasswordResetEmail(" in source,
            "nothing in FirebaseAuthBackend should call the SDK's sendPasswordResetEmail (#905)",
        )
    }

    /**
     * The address is the whole request. The server picks where the link
     * continues from the account, so there is no settings object and no
     * continue URL for a caller to set.
     */
    @Test
    fun itSendsTheTrimmedAddressAndNothingElse() {
        assertTrue(
            "mapOf(\"email\" to email.trim())" in sendBody,
            "expected the callable to be sent { email: <trimmed> } only, got: $sendBody",
        )
        assertFalse("ActionCodeSettings" in sendBody, "no ActionCodeSettings belong in a callable send, got: $sendBody")
        assertFalse("continueUrl" in sendBody, "the server picks the continue URL, got: $sendBody")
    }

    /** `recordFailedLogin` (#886) is a different callable and stays. */
    @Test
    fun theFailedLoginReportIsUntouched() {
        assertTrue(
            "recordFailedLogin" in source,
            "expected FirebaseAuthBackend to keep reporting failed logins",
        )
    }
}
