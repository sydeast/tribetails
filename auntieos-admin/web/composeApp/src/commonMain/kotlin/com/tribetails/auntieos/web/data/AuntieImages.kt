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
 * no timeouts and no guard. The only other ServiceLoader component on this
 * classpath is the console's own guarded fetcher, which this loader adds directly.
 * The Skia decoder is added directly by Coil, so nothing else is lost.
 *
 * Builds a new client and memory cache on every call. Screens use
 * [sharedAuntieImageLoader] instead.
 */
fun auntieImageLoader(context: PlatformContext): ImageLoader =
    ImageLoader.Builder(context)
        .components { add(KtorNetworkFetcherFactory(httpClient = { auntieHttpClient() })) }
        .serviceLoaderEnabled(false)
        .crossfade(true)
        .build()

private var sharedLoader: ImageLoader? = null

/**
 * #867 re-review: the one [auntieImageLoader] every image in the console uses,
 * built on first use. `AuntieAsyncImage` passes it explicitly, and it is also
 * Coil's singleton, so both paths share one client and one memory cache.
 */
fun sharedAuntieImageLoader(context: PlatformContext): ImageLoader =
    sharedLoader ?: auntieImageLoader(context).also { sharedLoader = it }

/**
 * Installs [sharedAuntieImageLoader] as Coil's singleton unless one is already set.
 * Called at app start and from `AuntieAppTheme`. Images no longer depend on it,
 * since `AuntieAsyncImage` passes the loader explicitly; it is there for anything
 * that asks Coil for its singleton.
 */
fun installAuntieImageLoader() {
    SingletonImageLoader.setSafe { sharedAuntieImageLoader(it) }
}
