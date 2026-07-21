package com.tribetails.auntieos

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * Regression guard: grpc-api must NOT be upgraded past 1.62.2.
 *
 * Root cause (fixed 2026-05-08):
 *   google-api-client:2.7.1 → google-http-client:1.45.2 → grpc-context:1.68.2
 *   → grpc-api:1.68.2, which REMOVED io.grpc.InternalGlobalInterceptors.
 *   grpc-core:1.62.2 (pinned by Firebase BOM) calls that class at runtime
 *   → NoClassDefFoundError on first Firestore access.
 *
 * Fix: configurations.all { resolutionStrategy { force("io.grpc:grpc-api:1.62.2") } }
 *      in app/build.gradle.kts.
 *
 * If this test fails: do NOT add the class to ProGuard keep rules.
 *   Restore the force() block in build.gradle.kts.
 */
class GrpcVersionRegressionTest {

    @Test
    fun `InternalGlobalInterceptors is loadable - grpc-api must stay at 1 62 2`() {
        // Class was removed in grpc-api:1.68.2. Its presence confirms we're running
        // against 1.62.2 (or another version that still ships it).
        val clazz = runCatching { Class.forName("io.grpc.InternalGlobalInterceptors") }
        assertEquals(
            "io.grpc.InternalGlobalInterceptors not found. " +
            "grpc-api was likely upgraded past 1.62.2. " +
            "Restore force(\"io.grpc:grpc-api:1.62.2\") in configurations.all " +
            "in app/build.gradle.kts.",
            null,
            clazz.exceptionOrNull()
        )
    }
}
