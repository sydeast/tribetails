package com.tribetails.auntieos

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Test

/**
 * Regression guard: grpc-api and grpc-core must resolve to the SAME version.
 *
 * The bug being guarded (2026-05-08): google-api-client pulled grpc-api up to
 * 1.68.2, which REMOVED `io.grpc.InternalGlobalInterceptors`, while grpc-core
 * stayed at 1.62.2 (pinned by the Firebase BOM) and still called that class.
 * The result was a NoClassDefFoundError on first Firestore access, at runtime,
 * on a real phone. A version SKEW between the two artifacts is the defect. No
 * single version is.
 *
 * This test used to assert that `io.grpc.InternalGlobalInterceptors` loads,
 * which encoded one of the two possible fixes: pin api DOWN to match old core.
 * `app/build.gradle.kts` later took the other one and forced all three
 * artifacts UP to 1.83.0, which is equally coherent (1.83.0 core does not call
 * the removed class) and is what `verifyGrpcVersionPins` has asserted since.
 * The test was not updated, and it kept passing anyway because `configurations.all`
 * did not reach the unit-test classpath before AGP 9.3.1: the test measured a
 * 1.62.2 classpath that the shipped app never had. AGP 9.3.1 made the force
 * apply everywhere, the test saw the real 1.83.0 classpath for the first time,
 * and went red against a state that is correct.
 *
 * So it was passing for the wrong reason, on a classpath that did not exist in
 * the APK. It now asserts the invariant itself, which holds at 1.62.2, at
 * 1.83.0, and at whatever the pins say next.
 *
 * If this test fails: make the three `force()` calls in `configurations.all` in
 * `app/build.gradle.kts` agree, and update the expected versions in the
 * `verifyGrpcVersionPins` task to match. Do NOT add anything to ProGuard keep
 * rules; a keep rule cannot conjure a class that is not in the jar.
 */
class GrpcVersionRegressionTest {

    /**
     * Reads the artifact version out of the jar a class was loaded from. Gradle
     * lays the cache out as `.../<artifact>/<version>/<hash>/<artifact>-<version>.jar`,
     * so the file name carries it. Returns null rather than throwing when the
     * class comes from somewhere without a versioned jar name, which the caller
     * reports as its own distinct failure.
     */
    private fun resolvedVersionOf(className: String, artifact: String): String? {
        val location = runCatching {
            Class.forName(className).protectionDomain?.codeSource?.location?.path
        }.getOrNull() ?: return null
        val jar = location.substringAfterLast('/')
        if (!jar.startsWith("$artifact-") || !jar.endsWith(".jar")) return null
        return jar.removePrefix("$artifact-").removeSuffix(".jar")
    }

    @Test
    fun `grpc-api and grpc-core resolve to the same version`() {
        // io.grpc.ManagedChannel ships in grpc-api; io.grpc.internal.GrpcUtil in
        // grpc-core. Each is a stable, long-lived entry point in its own artifact.
        val apiVersion = resolvedVersionOf("io.grpc.ManagedChannel", "grpc-api")
        val coreVersion = resolvedVersionOf("io.grpc.internal.GrpcUtil", "grpc-core")

        assertNotNull(
            "Could not read the grpc-api version off the test classpath. " +
                "Either grpc-api is absent or it is no longer a plain jar. " +
                "Check the force() calls in configurations.all in app/build.gradle.kts.",
            apiVersion,
        )
        assertNotNull(
            "Could not read the grpc-core version off the test classpath. " +
                "Either grpc-core is absent or it is no longer a plain jar. " +
                "Check the force() calls in configurations.all in app/build.gradle.kts.",
            coreVersion,
        )

        assertEquals(
            "grpc-api and grpc-core disagree. This is the 2026-05-08 defect: " +
                "core calls api internals, so a skew is a NoClassDefFoundError on " +
                "first Firestore access, on device, not at build time. " +
                "Make the force() calls in configurations.all in app/build.gradle.kts agree.",
            apiVersion,
            coreVersion,
        )
    }
}
