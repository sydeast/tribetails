package com.tribetails.auntieos.web.data

import coil3.ImageLoader
import coil3.PlatformContext
import coil3.SingletonImageLoader
import coil3.network.ktor3.KtorNetworkFetcherFactory
import coil3.request.crossfade
import coil3.serviceLoaderEnabled

/**
 * #867 review: the console's one image loader. Its network fetcher uses
 * [auntieHttpClient], so image loads get the same timeouts as every other request
 * and, on desktop, the test network guard.
 *
 * `serviceLoaderEnabled(false)` matters: coil-network-ktor3 registers its own
 * fetcher through ServiceLoader, and that one builds a plain `HttpClient()` with
 * no timeouts and no guard. The only ServiceLoader component on this classpath is
 * that fetcher (the Skia decoder is added directly), so nothing else is lost.
 */
fun auntieImageLoader(context: PlatformContext): ImageLoader =
    ImageLoader.Builder(context)
        .components { add(KtorNetworkFetcherFactory(httpClient = { auntieHttpClient() })) }
        .serviceLoaderEnabled(false)
        .crossfade(true)
        .build()

/**
 * Installs [auntieImageLoader] as Coil's singleton unless one is already set.
 * Called from `AuntieAppTheme`, which every screen and every render test sits
 * inside (the theme colors throw without it), so Coil's own default loader, and
 * its unguarded client, never gets built.
 */
fun installAuntieImageLoader() {
    SingletonImageLoader.setSafe { auntieImageLoader(it) }
}
