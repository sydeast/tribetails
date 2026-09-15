package com.tribetails.auntieos.web.data

import coil3.Uri
import coil3.annotation.InternalCoilApi
import coil3.fetch.Fetcher
import coil3.network.ktor3.KtorNetworkFetcherFactory
import coil3.util.FetcherServiceLoaderTarget
import kotlin.reflect.KClass

/**
 * #867 re-review: the guarded network fetcher, offered to every Coil image loader
 * on this JVM through Coil's own ServiceLoader, including the default loader Coil
 * builds when nothing installed one.
 *
 * coil-network-ktor3 registers a fetcher the same way at priority 1, and that one
 * builds a plain `HttpClient()` with no timeouts and no test network guard. Coil
 * sorts ServiceLoader fetchers by priority, highest first, so at priority 2 this one
 * answers every `Uri` before it. The console's own loader ([auntieImageLoader])
 * turns ServiceLoader components off and adds the same factory directly; this
 * covers a stray `AsyncImage` that never got that loader, in the app and in tests.
 *
 * Registered in `src/jvmMain/resources/META-INF/services/coil3.util.FetcherServiceLoaderTarget`.
 * The interface is marked internal to Coil; it is the only hook Coil offers for this.
 */
@OptIn(InternalCoilApi::class)
class AuntieNetworkFetcherServiceLoaderTarget : FetcherServiceLoaderTarget<Uri> {
    override fun factory(): Fetcher.Factory<Uri> = KtorNetworkFetcherFactory(httpClient = { auntieHttpClient() })
    override fun type(): KClass<Uri> = Uri::class
    override fun priority(): Int = 2
}
