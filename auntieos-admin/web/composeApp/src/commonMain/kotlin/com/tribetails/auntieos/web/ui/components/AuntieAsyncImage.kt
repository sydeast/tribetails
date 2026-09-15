package com.tribetails.auntieos.web.ui.components

import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.layout.ContentScale
import coil3.compose.AsyncImage
import coil3.compose.AsyncImagePainter
import coil3.compose.LocalPlatformContext
import coil3.compose.SubcomposeAsyncImage
import coil3.compose.SubcomposeAsyncImageScope
import com.tribetails.auntieos.web.data.sharedAuntieImageLoader

/**
 * #867 re-review: the only way the console shows a remote image. Every call passes
 * the console's loader explicitly, so a load gets timeouts and the desktop test
 * network guard whether or not the caller sits inside `AuntieAppTheme` and whether
 * or not a Coil singleton was installed.
 *
 * `ImageLoadSourceCheckTest` fails if any other main source file calls Coil's
 * `AsyncImage`, `SubcomposeAsyncImage` or `rememberAsyncImagePainter` directly.
 */
@Composable
fun AuntieAsyncImage(
    model: Any?,
    contentDescription: String?,
    modifier: Modifier = Modifier,
    contentScale: ContentScale = ContentScale.Fit,
    onState: ((AsyncImagePainter.State) -> Unit)? = null,
) {
    AsyncImage(
        model = model,
        contentDescription = contentDescription,
        imageLoader = sharedAuntieImageLoader(LocalPlatformContext.current),
        modifier = modifier,
        contentScale = contentScale,
        onState = onState,
    )
}

/** [AuntieAsyncImage] for callers that draw their own loading and error content from the painter state. */
@Composable
fun AuntieSubcomposeAsyncImage(
    model: Any?,
    contentDescription: String?,
    modifier: Modifier = Modifier,
    contentScale: ContentScale = ContentScale.Fit,
    content: @Composable SubcomposeAsyncImageScope.() -> Unit,
) {
    SubcomposeAsyncImage(
        model = model,
        contentDescription = contentDescription,
        imageLoader = sharedAuntieImageLoader(LocalPlatformContext.current),
        modifier = modifier,
        contentScale = contentScale,
        content = content,
    )
}
