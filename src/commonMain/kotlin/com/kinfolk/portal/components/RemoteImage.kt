package com.kinfolk.portal.components

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.BrokenImage
import androidx.compose.material.icons.outlined.Person
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import coil3.compose.LocalPlatformContext
import coil3.compose.SubcomposeAsyncImage
import coil3.request.ImageRequest
import coil3.request.crossfade
import com.kinfolk.portal.theme.KinfolkBrand

@Composable
fun KinfolkRemoteImage(
    url: String,
    contentDescription: String?,
    modifier: Modifier = Modifier,
    contentScale: ContentScale = ContentScale.Crop,
    cornerRadius: Dp = 12.dp,
) {
    val shape = RoundedCornerShape(cornerRadius)
    Box(
        modifier = modifier
            .clip(shape)
            .background(KinfolkBrand.GlassSurface),
        contentAlignment = Alignment.Center,
    ) {
        if (url.isBlank()) {
            BrokenIcon(contentDescription)
            return@Box
        }
        SubcomposeAsyncImage(
            model = remoteImageRequest(url),
            contentDescription = contentDescription,
            modifier = Modifier.fillMaxSize(),
            contentScale = contentScale,
            loading = { CircularProgressIndicator(color = KinfolkBrand.PackPink, modifier = Modifier.size(20.dp)) },
            error = { BrokenIcon(contentDescription) },
        )
    }
}

@Composable
fun KinfolkAvatar(
    url: String,
    contentDescription: String?,
    size: Dp = 72.dp,
    modifier: Modifier = Modifier,
) {
    Box(
        modifier = modifier
            .size(size)
            .clip(CircleShape)
            .background(KinfolkBrand.GlassSurface),
        contentAlignment = Alignment.Center,
    ) {
        if (url.isBlank()) {
            PersonIcon(contentDescription, size)
            return@Box
        }
        SubcomposeAsyncImage(
            model = remoteImageRequest(url),
            contentDescription = contentDescription,
            modifier = Modifier.fillMaxSize(),
            contentScale = ContentScale.Crop,
            loading = { CircularProgressIndicator(color = KinfolkBrand.PackPink, modifier = Modifier.size(size.div(3))) },
            error = { PersonIcon(contentDescription, size) },
        )
    }
}

@Composable
private fun BrokenIcon(contentDescription: String?) {
    Icon(
        imageVector = Icons.Filled.BrokenImage,
        contentDescription = contentDescription,
        tint = KinfolkBrand.NavyMuted,
    )
}

@Composable
private fun PersonIcon(contentDescription: String?, size: Dp) {
    Icon(
        imageVector = Icons.Outlined.Person,
        contentDescription = contentDescription,
        tint = KinfolkBrand.NavyMuted,
        modifier = Modifier.size(size.div(2)),
    )
}

@Composable
private fun remoteImageRequest(url: String): ImageRequest =
    ImageRequest.Builder(LocalPlatformContext.current)
        .data(url)
        .crossfade(true)
        .build()
