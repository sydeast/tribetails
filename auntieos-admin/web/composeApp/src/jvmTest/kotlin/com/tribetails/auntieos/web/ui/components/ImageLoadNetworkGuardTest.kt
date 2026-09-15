package com.tribetails.auntieos.web.ui.components

import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.runDesktopComposeUiTest
import coil3.PlatformContext
import coil3.SingletonImageLoader
import coil3.request.ErrorResult
import coil3.request.ImageRequest
import com.tribetails.auntieos.web.data.NetworkBlockedError
import com.tribetails.auntieos.web.data.NetworkGuard
import com.tribetails.auntieos.web.data.auntieImageLoader
import com.tribetails.auntieos.web.theme.AuntieAppTheme
import com.tribetails.auntieos.web.theme.ThemeMode
import kotlinx.coroutines.runBlocking
import java.util.Collections
import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertTrue

/**
 * #867 review: an image load is a request like any other. Coil's default fetcher
 * builds its own HttpClient with no timeouts and no guard, so a render test showing
 * a real photo URL reached the network. The console's loader must be the one in
 * use, and the guard must see the request.
 *
 * The URLs use `.invalid`, a name that never resolves, so even with the guard
 * broken no request can reach a real host.
 */
@OptIn(ExperimentalTestApi::class)
class ImageLoadNetworkGuardTest {

    private val captured: MutableList<String> = Collections.synchronizedList(mutableListOf())
    private val defaultOnBlocked = NetworkGuard.onBlocked

    @BeforeTest
    fun setUp() {
        // Blocks made on purpose are captured, not reported as a leak.
        NetworkGuard.onBlocked = { captured += it }
        // Start from no singleton, so the theme's install is what puts the loader there.
        SingletonImageLoader.reset()
    }

    @AfterTest
    fun tearDown() {
        NetworkGuard.onBlocked = defaultOnBlocked
        SingletonImageLoader.setUnsafe(auntieImageLoader(PlatformContext.INSTANCE))
    }

    @Test
    fun theAppImageLoaderSendsItsRequestsThroughTheGuard() = runBlocking {
        val url = "https://photos-loader.example.invalid/kin.png"
        val loader = auntieImageLoader(PlatformContext.INSTANCE)
        val result = loader.execute(ImageRequest.Builder(PlatformContext.INSTANCE).data(url).build())
        assertTrue(result is ErrorResult, "expected the load to fail, got $result")
        assertTrue(result.throwable is NetworkBlockedError, "expected the guard to refuse it, got ${result.throwable}")
        assertTrue(captured.any { it.contains("photos-loader.example.invalid") }, "$captured")
    }

    @Test
    fun anAvatarWithAPhotoUrlIsRefusedByTheGuard() = runDesktopComposeUiTest {
        setContent {
            AuntieAppTheme(themeMode = ThemeMode.DARK) {
                AuntieAvatar(imageUrl = "https://photos-avatar.example.invalid/kinfolk.jpg", initials = "PK")
            }
        }
        waitUntil(timeoutMillis = 10_000) { captured.any { it.contains("photos-avatar.example.invalid") } }
    }
}
