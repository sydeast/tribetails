package com.kinfolk.portal.media

import coil3.ImageLoader
import coil3.network.ktor3.KtorNetworkFetcherFactory

actual fun installCoilNetwork(builder: ImageLoader.Builder): ImageLoader.Builder =
    builder.components { add(KtorNetworkFetcherFactory()) }
