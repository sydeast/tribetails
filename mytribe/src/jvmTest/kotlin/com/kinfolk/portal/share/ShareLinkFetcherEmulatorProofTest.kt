package com.kinfolk.portal.share

import com.kinfolk.portal.firebase.FirebaseRestConfig
import com.kinfolk.portal.firebase.RestHttp
import kotlinx.coroutines.runBlocking
import org.junit.Assume.assumeTrue
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals

/**
 * #889 review, item 2: proves getShareLink (JvmShareLinkFetcher) reaches the
 * Functions emulator's getShareLink. Skipped unless FUNCTIONS_EMULATOR_HOST
 * is set. A nonexistent share id resolves to NotFound; getting that answer
 * back (not a connection failure) is the proof.
 */
class ShareLinkFetcherEmulatorProofTest {

    @BeforeTest
    fun requireEmulator() {
        assumeTrue(
            "FUNCTIONS_EMULATOR_HOST is not set; this test only runs against the emulator",
            !System.getenv("FUNCTIONS_EMULATOR_HOST").isNullOrBlank(),
        )
    }

    @Test
    fun getShareLinkReachesTheFunctionsEmulator() = runBlocking {
        val fetcher = JvmShareLinkFetcher(DEFAULT_SHARE_BASE, RestHttp.client, FirebaseRestConfig)
        val result = fetcher.getShareLink("nonexistent-share-889-${System.nanoTime()}", null)
        assertEquals(GetShareLinkResult.NotFound, result)
    }
}
