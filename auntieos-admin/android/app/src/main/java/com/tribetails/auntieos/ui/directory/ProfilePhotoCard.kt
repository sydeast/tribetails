package com.tribetails.auntieos.ui.directory

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.unit.dp
import coil3.compose.AsyncImage
import com.tribetails.auntieos.ui.components.AuntieCard
import com.tribetails.auntieos.ui.components.AuntieTextBtn
import com.tribetails.auntieos.ui.theme.AuntieTheme

/**
 * Shared profile-photo control for Kinfolk/Kin edit. Tap the avatar or the button
 * to pick an image; the caller owns the PickVisualMedia launcher and wires onPick
 * to the relevant ViewModel upload (uploadKinfolkPhoto / uploadKinPhoto). Mirrors
 * the AdminSettings avatar pattern and the web KinfolkEditScreen/KinEditScreen flow.
 */
@Composable
fun ProfilePhotoCard(
    photoUrl: String,
    isUploading: Boolean,
    fallbackInitial: String,
    onPick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val c = AuntieTheme.colors
    AuntieCard(modifier = modifier.fillMaxWidth()) {
        Column(modifier = Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Text(
                "PHOTO",
                style = AuntieTheme.typography.labelSmall,
                color = c.kinfolkOrange,
            )
            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(16.dp),
            ) {
                Box(
                    modifier = Modifier
                        .size(88.dp)
                        .clip(CircleShape)
                        .background(c.surface2)
                        .clickable(enabled = !isUploading, onClick = onPick),
                    contentAlignment = Alignment.Center,
                ) {
                    if (photoUrl.isNotBlank()) {
                        AsyncImage(
                            model = photoUrl,
                            contentDescription = "Profile photo",
                            modifier = Modifier.fillMaxSize().clip(CircleShape),
                        )
                    } else {
                        Text(
                            text = fallbackInitial.firstOrNull()?.uppercaseChar()?.toString() ?: "?",
                            style = AuntieTheme.typography.displayLarge,
                            color = c.textDim,
                        )
                    }
                }
                AuntieTextBtn(onClick = onPick, enabled = !isUploading) {
                    Text(
                        when {
                            isUploading -> "Uploading..."
                            photoUrl.isNotBlank() -> "Change Photo"
                            else -> "Add Photo"
                        }
                    )
                }
            }
        }
    }
}
