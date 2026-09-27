package com.kinfolk.portal.attestation

import java.io.File
import kotlin.test.Test
import kotlin.test.assertFalse
import kotlin.test.assertTrue
import kotlin.test.fail

/**
 * R3 ruling (2026-09-27, mytribe/docs/O3_APP_CHECK_RULING_2026-07-13.md):
 * "Android has no App Check. Rely on sign-in and rate limits. Stop the
 * failing Play request." This app is sideloaded and will never be in the
 * Play Console, so Play Integrity could never verify a token; every launch
 * was spending one failed attestation request for a check the server does
 * not enforce on Android.
 *
 * This test used to assert the OPPOSITE of what is below, back when O-3's D1
 * had Play Integrity as the shipped provider (issue #556). It is inverted
 * here rather than deleted for the same reason it existed in the first
 * place: the gap this class of test catches is never in application logic,
 * it is in a Gradle file and an `Application.onCreate` that no JVM unit test
 * can execute, so a blunt text read of both is what stops the App Check
 * dependency or its activation call quietly creeping back in.
 */
class AppCheckWiringTest {

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

    private fun read(relativePath: String): String {
        val file = File(moduleRoot(), relativePath)
        assertTrue(file.isFile, "Expected $relativePath to exist")
        return file.readText()
    }

    @Test
    fun androidBuildDoesNotDependOnPlayIntegrity() {
        val gradle = read("build.gradle.kts")
        assertFalse(
            gradle.contains("firebase-appcheck-playintegrity"),
            "R3 ruling: the portal Android app must not depend on Play Integrity App Check. " +
                "It is sideloaded and will never be in the Play Console, so the token request " +
                "always failed; the dependency should not come back.",
        )
    }

    @Test
    fun androidBuildDoesNotDependOnTheDebugAppCheckProvider() {
        val gradle = read("build.gradle.kts")
        assertFalse(
            gradle.contains("firebase-appcheck-debug"),
            "R3 ruling: the debug App Check provider fed a system nothing enforces on Android; " +
                "it should not come back either.",
        )
    }

    @Test
    fun androidBuildDoesNotUseSafetyNet() {
        val gradle = read("build.gradle.kts")
        // Decommissioned by Google, and was never used here even when Play
        // Integrity was: this guard against a fallback to it still applies.
        assertFalse(
            gradle.contains("firebase-appcheck-safetynet"),
            "SafetyNet App Check is decommissioned and must never be a fallback.",
        )
    }

    @Test
    fun applicationDoesNotActivateAppCheckOnStart() {
        val application = read("src/androidMain/kotlin/com/kinfolk/portal/KinfolkPortalApplication.kt")
        assertFalse(
            application.contains("activateAppCheck("),
            "R3 ruling: KinfolkPortalApplication.onCreate must not activate App Check. " +
                "The server does not enforce it on Android, and the Play Integrity token " +
                "request failed on every launch.",
        )
    }
}
