package com.kinfolk.portal.auth

import java.io.File
import kotlin.test.Test
import kotlin.test.assertFalse
import kotlin.test.assertTrue
import kotlin.test.fail

/**
 * #911: the Android and web backend sends resets with the Firebase SDK, not the
 * `requestPasswordReset` callable.
 *
 * `FirebaseAuthBackend` lives in `firebaseMain`, which compiles only for
 * Android and Kotlin/JS and has no test source set, and it reaches the SDK
 * through the `Firebase.auth` global, which nothing here can substitute. So
 * this reads the file, the way `AppLinkManifestTest` reads the Android manifest
 * and `AppCheckWiringTest` reads `build.gradle.kts`. It is a wiring test, not a
 * behaviour test: it proves which call the Android app makes and which one it
 * no longer makes, and `testDebugUnitTest` proves that call compiles against
 * the real SDK.
 *
 * The behaviour around the call (what the household reads when the address is
 * not an account) is real-test covered in [PasswordResetSendTest] (shared) and
 * `RestAuthResetSendTest` (desktop, through the REST stack).
 */
class NativeResetWiringTest {

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
    fun theAndroidAndWebBackendSendsWithTheFirebaseSdk() {
        assertTrue(
            "sendPasswordResetEmail" in sendBody,
            "expected sendPasswordReset to call the SDK's sendPasswordResetEmail, got: $sendBody",
        )
    }

    /**
     * #936 moved the target out of this body and into the caller's argument, so
     * the expected literal is gone: what is pinned now is that the argument is
     * what the settings carry, and that a null one sends no settings at all,
     * which is the bare link portal web sends for a link that named no target.
     * [PasswordResetSendTest] pins the default the callers get.
     */
    @Test
    fun itAsksForALinkThatContinuesWhereTheCallerSaid() {
        assertTrue(
            "ActionCodeSettings" in sendBody && "url = it" in sendBody,
            "expected ActionCodeSettings built from the continueUrl argument, got: $sendBody",
        )
        assertTrue(
            "continueUrl?.let" in sendBody,
            "expected a null continueUrl to send no ActionCodeSettings, got: $sendBody",
        )
        assertTrue(
            "canHandleCodeInApp = false" in sendBody,
            "expected canHandleCodeInApp = false, matching portal web's handleCodeInApp: false, got: $sendBody",
        )
        assertFalse(
            "EmailAction.PORTAL_SIGN_IN_URL" in sendBody,
            "the target is the caller's now; hardcoding it here would ignore the argument, got: $sendBody",
        )
    }

    /**
     * The defect itself. The callable caps an address at 3 resets a day and then
     * reports success while sending nothing, so anyone who knows a household's
     * address can block its resets for 24 hours.
     */
    @Test
    fun itNoLongerSpendsTheCallablesPerEmailBudget() {
        assertFalse(
            "requestPasswordReset" in sendBody,
            "sendPasswordReset must not call the requestPasswordReset callable (#911), got: $sendBody",
        )
    }

    /** `recordFailedLogin` (#886) is a different callable and stays. */
    @Test
    fun theFailedLoginReportIsUntouched() {
        assertTrue(
            "recordFailedLogin" in source,
            "expected FirebaseAuthBackend to keep reporting failed logins",
        )
    }

    /** The one URL both clients and portal web ask for. */
    @Test
    fun thePortalContinueUrlIsThePortalSignIn() {
        assertTrue(EmailAction.PORTAL_SIGN_IN_URL == "https://kinfolk.tribetails.com/signin")
    }
}
