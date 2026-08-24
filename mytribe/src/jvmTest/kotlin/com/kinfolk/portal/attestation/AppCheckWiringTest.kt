package com.kinfolk.portal.attestation

import java.io.File
import kotlin.test.Test
import kotlin.test.assertFalse
import kotlin.test.assertTrue
import kotlin.test.fail

/**
 * Issue #556, Android half: the portal Android app declared no App Check
 * dependency and installed no provider, so every callable it made reached the
 * backend unattested while the O-3 ruling described Android attestation as
 * shipped work.
 *
 * A state machine test cannot catch that coming back — the gap was never in the
 * logic, it was in the wiring, and the wiring lives in a Gradle file and an
 * `Application.onCreate` that no JVM test can execute. So this reads the two
 * files, the same way `ComposeUiTestSourceSetTest` reads `commonTest`. It is a
 * blunt instrument and it is the only one that fails when someone deletes the
 * dependency to fix a build.
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
    fun androidBuildDeclaresPlayIntegrity() {
        val gradle = read("build.gradle.kts")
        assertTrue(
            gradle.contains("com.google.firebase:firebase-appcheck-playintegrity"),
            "The portal Android app must depend on Play Integrity App Check (O-3 ruling D1). " +
                "Without it nothing installs a provider and every callable from the app is " +
                "unattested, which is what issue #556 found.",
        )
    }

    @Test
    fun androidBuildDoesNotUseSafetyNet() {
        val gradle = read("build.gradle.kts")
        // Decommissioned by Google. D1 rules out even a fallback to it.
        assertFalse(
            gradle.contains("firebase-appcheck-safetynet"),
            "SafetyNet App Check is decommissioned; Play Integrity is the only provider.",
        )
    }

    @Test
    fun applicationActivatesAppCheckOnStart() {
        val application = read("src/androidMain/kotlin/com/kinfolk/portal/KinfolkPortalApplication.kt")
        assertTrue(
            application.contains("activateAppCheck("),
            "KinfolkPortalApplication.onCreate must activate App Check, before any screen can " +
                "make a callable.",
        )
    }

    @Test
    fun releaseBuildsDoNotGetTheDebugProvider() {
        val activation = read("src/androidMain/kotlin/com/kinfolk/portal/attestation/AppCheck.android.kt")
        assertTrue(
            activation.contains("useDebugProvider"),
            "The provider choice must be explicit. A debug provider in a release build attests " +
                "nothing while looking like it works.",
        )
        val application = read("src/androidMain/kotlin/com/kinfolk/portal/KinfolkPortalApplication.kt")
        assertTrue(
            application.contains("FLAG_DEBUGGABLE"),
            "The debug provider must be chosen from the build's own debuggable flag, not from a " +
                "constant somebody can forget to flip before a release.",
        )
    }
}
