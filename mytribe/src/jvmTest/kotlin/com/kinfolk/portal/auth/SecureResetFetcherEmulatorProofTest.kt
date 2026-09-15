package com.kinfolk.portal.auth

import com.kinfolk.portal.firebase.FirebaseRestConfig
import com.kinfolk.portal.firebase.RestHttp
import kotlinx.coroutines.runBlocking
import org.junit.Assume.assumeTrue
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertFailsWith

/**
 * #889 review, item 1: proves confirmReset (JvmSecureResetFetcher) reaches
 * the Functions emulator's confirmSecureReset. Skipped unless
 * FUNCTIONS_EMULATOR_HOST is set. Run it from mytribe/ alongside the
 * RestAuthEmulatorProofTest command (--tests "*SecureResetFetcherEmulatorProofTest").
 *
 * A bogus oobCode cannot succeed: confirmSecureReset consumes it via
 * Identity Toolkit before writing anything, so this always ends in a
 * SecureResetException. That exception coming back at all, instead of a
 * connection failure, is the proof the request reached the emulator.
 */
class SecureResetFetcherEmulatorProofTest {

    @BeforeTest
    fun requireEmulator() {
        assumeTrue(
            "FUNCTIONS_EMULATOR_HOST is not set; this test only runs against the emulator",
            !System.getenv("FUNCTIONS_EMULATOR_HOST").isNullOrBlank(),
        )
    }

    @Test
    fun confirmResetReachesTheFunctionsEmulator(): Unit = runBlocking {
        val fetcher = JvmSecureResetFetcher(DEFAULT_SECURE_RESET_BASE, RestHttp.client, FirebaseRestConfig)
        assertFailsWith<SecureResetException> {
            fetcher.confirmReset(
                oobCode = "bogus-oob-code-889",
                newPassword = "newpassword123",
                email = "nobody-889-${System.nanoTime()}@example.test",
                userAgent = "jvm-emulator-proof",
            )
        }
    }
}
