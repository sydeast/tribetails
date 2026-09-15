package com.tribetails.auntieos.web.ui.components

import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.runDesktopComposeUiTest
import coil3.PlatformContext
import coil3.SingletonImageLoader
import coil3.annotation.InternalCoilApi
import coil3.compose.AsyncImage
import coil3.util.FetcherServiceLoaderTarget
import com.tribetails.auntieos.web.data.AuntieNetworkFetcherServiceLoaderTarget
import com.tribetails.auntieos.web.data.NetworkGuard
import com.tribetails.auntieos.web.data.sharedAuntieImageLoader
import java.util.Collections
import java.util.ServiceLoader
import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * #867 re-review, the reviewer's mutation (g): a raw Coil `AsyncImage`, outside
 * `AuntieAppTheme`, after `SingletonImageLoader.reset()`, so Coil builds its own
 * default loader. That loader must still send the request through the guard.
 *
 * The raw call is allowed here: the source check covers main code only. The URL
 * uses `.invalid`, which never resolves, so nothing can reach a real host.
 */
@OptIn(ExperimentalTestApi::class, InternalCoilApi::class)
class StrayImageNetworkGuardTest {

    private val captured: MutableList<String> = Collections.synchronizedList(mutableListOf())
    private val defaultOnBlocked = NetworkGuard.onBlocked

    @BeforeTest
    fun setUp() {
        NetworkGuard.onBlocked = { captured += it }
        SingletonImageLoader.reset()
    }

    @AfterTest
    fun tearDown() {
        NetworkGuard.onBlocked = defaultOnBlocked
        SingletonImageLoader.setUnsafe(sharedAuntieImageLoader(PlatformContext.INSTANCE))
    }

    @Test
    fun theGuardedFetcherOutranksCoilsOwnThroughServiceLoader() {
        val targets = ServiceLoader.load(FetcherServiceLoaderTarget::class.java).toList()
        val ours = targets.filterIsInstance<AuntieNetworkFetcherServiceLoaderTarget>()
        assertEquals(1, ours.size, "registered targets: ${targets.map { it::class.qualifiedName }}")
        val others = targets.filter { it !is AuntieNetworkFetcherServiceLoaderTarget }
        assertTrue(others.all { it.priority() < ours.single().priority() }, "priorities: ${targets.map { it::class.simpleName to it.priority() }}")
    }

    @Test
    fun aRawAsyncImageOutsideTheThemeIsStillRefusedByTheGuard() = runDesktopComposeUiTest {
        setContent {
            AsyncImage(model = "https://stray-image.example.invalid/kin.png", contentDescription = null)
        }
        waitUntil(timeoutMillis = 10_000) { captured.any { it.contains("stray-image.example.invalid") } }
    }
}
