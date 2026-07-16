package com.kinfolk.portal.screens.kintales

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectDragGestures
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Image
import androidx.compose.material.icons.filled.Shield
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import com.kinfolk.portal.components.GlassCard
import com.kinfolk.portal.components.KinButton
import com.kinfolk.portal.components.KinField
import com.kinfolk.portal.portal.PortalApi
import com.kinfolk.portal.portal.ShareLinkCreated
import com.kinfolk.portal.theme.KinfolkBrand
import com.kinfolk.portal.theme.KinfolkGradients
import com.kinfolk.portal.theme.KinfolkShapes
import com.kinfolk.portal.theme.KinfolkSpacing
import com.kinfolk.portal.theme.KinfolkTheme
import kotlinx.coroutines.launch

/**
 * Modal for the primary kinfolk to mint a public share link for one KinTale.
 * Server enforces PRIMARY-only via `requirePrimary(memberDoc)` — secondary
 * contacts hitting Submit will get a permission-denied banner per the
 * fail-loud policy.
 *
 * Two-stage flow: form (Generate Link) → result (Copy Link).
 * Foundation-only — no M3 visual components.
 */
@Composable
fun ShareKinTaleModal(
    familyId: String,
    kinTaleId: String,
    portalApi: PortalApi,
    onDismiss: () -> Unit,
    onShared: (ShareLinkCreated) -> Unit = {},
) {
    val c = KinfolkTheme.colors
    val type = KinfolkTheme.typography
    val scope = rememberCoroutineScope()
    val clipboard = LocalClipboardManager.current

    var includePhotos by remember { mutableStateOf(true) }
    var passcode by remember { mutableStateOf("") }
    var expiresInDays by remember { mutableStateOf(7) }
    var submitting by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var created by remember { mutableStateOf<ShareLinkCreated?>(null) }
    var copied by remember { mutableStateOf(false) }

    Dialog(
        onDismissRequest = { if (!submitting) onDismiss() },
        properties = DialogProperties(usePlatformDefaultWidth = false),
    ) {
        Column(
            modifier = Modifier
                .widthIn(max = 480.dp)
                .padding(horizontal = 16.dp),
        ) {
            GlassCard(
                contentPadding = PaddingValues(KinfolkSpacing.l),
                modifier = Modifier.fillMaxWidth(),
            ) {
                if (created == null) {
                    ShareFormBody(
                        includePhotos = includePhotos,
                        onTogglePhotos = { includePhotos = it },
                        expiresInDays = expiresInDays,
                        onExpiresInDaysChange = { expiresInDays = it },
                        passcode = passcode,
                        onPasscodeChange = { passcode = it.take(8) },
                        submitting = submitting,
                        error = error,
                        onSubmit = {
                            if (passcode.isNotBlank() && passcode.length < 4) {
                                error = "Passcode must be at least 4 characters."
                                return@ShareFormBody
                            }
                            scope.launch {
                                submitting = true
                                error = null
                                try {
                                    val res = portalApi.createShareLink(
                                        familyId = familyId,
                                        kinTaleId = kinTaleId,
                                        includePhotos = includePhotos,
                                        expiresInDays = expiresInDays,
                                        passcode = passcode.ifBlank { null },
                                    )
                                    created = res
                                    onShared(res)
                                } catch (t: Throwable) {
                                    error = t.message ?: "Could not create share link."
                                } finally {
                                    submitting = false
                                }
                            }
                        },
                    )
                } else {
                    ShareResultBody(
                        link = created!!,
                        passcodeSet = passcode.isNotBlank(),
                        copied = copied,
                        onCopy = {
                            clipboard.setText(AnnotatedString(created!!.shareUrl))
                            copied = true
                        },
                        onDone = onDismiss,
                    )
                }
            }
            Spacer(Modifier.height(KinfolkSpacing.m))
            Column(horizontalAlignment = Alignment.CenterHorizontally, modifier = Modifier.fillMaxWidth()) {
                Text(
                    "protected by reCAPTCHA",
                    style = type.sansMeta.copy(color = Color.White.copy(alpha = 0.7f)),
                )
            }
        }
    }
}

// -----------------------------------------------------------------------------
// Form (stage 1)
// -----------------------------------------------------------------------------

@Composable
private fun ShareFormBody(
    includePhotos: Boolean,
    onTogglePhotos: (Boolean) -> Unit,
    expiresInDays: Int,
    onExpiresInDaysChange: (Int) -> Unit,
    passcode: String,
    onPasscodeChange: (String) -> Unit,
    submitting: Boolean,
    error: String?,
    onSubmit: () -> Unit,
) {
    val c = KinfolkTheme.colors
    val type = KinfolkTheme.typography

    Column(verticalArrangement = Arrangement.spacedBy(KinfolkSpacing.m)) {
        Text(
            text = "Invite the Family",
            style = type.heritageTitle,
            modifier = Modifier.fillMaxWidth(),
            textAlign = TextAlign.Center,
        )
        Text(
            text = "Share this story with family and friends. Choose how the link works.",
            style = type.sansBody.copy(color = c.navyMuted),
            textAlign = TextAlign.Center,
            modifier = Modifier.fillMaxWidth(),
        )

        // ---- Include Photos toggle ----
        ToggleRow(
            label = "Include Photos",
            value = includePhotos,
            onChange = onTogglePhotos,
        )

        // ---- Link Expiration slider ----
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .clip(KinfolkShapes.card)
                .background(c.glassSurface)
                .border(1.dp, c.glassBorder, KinfolkShapes.card)
                .padding(KinfolkSpacing.m),
            verticalArrangement = Arrangement.spacedBy(KinfolkSpacing.s),
        ) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Text("Link Expiration", style = type.sansBody.copy(fontWeight = FontWeight.SemiBold), modifier = Modifier.weight(1f))
                Box(
                    modifier = Modifier
                        .clip(CircleShape)
                        .background(Color.White)
                        .padding(horizontal = 12.dp, vertical = 4.dp),
                ) {
                    Text(
                        text = "$expiresInDays Days",
                        style = type.sansMeta.copy(color = c.primary, fontWeight = FontWeight.SemiBold),
                    )
                }
            }
            DaySlider(
                value = expiresInDays,
                onValueChange = onExpiresInDaysChange,
                min = 1,
                max = 90,
            )
            Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                Text("1", style = type.sansMeta.copy(color = c.navyMuted))
                Text("90", style = type.sansMeta.copy(color = c.navyMuted))
            }
        }

        // ---- Passcode field ----
        Text(
            text = "SECURE WITH PASSCODE",
            style = type.sansMeta.copy(color = c.navyMuted, fontWeight = FontWeight.SemiBold),
        )
        KinField(
            value = passcode,
            onValueChange = onPasscodeChange,
            label = "Optional, 4–8 characters",
        )

        if (error != null) {
            Text(
                text = error,
                style = type.sansMeta.copy(color = c.coral),
            )
        }

        Spacer(Modifier.height(4.dp))

        // ---- Generate Link button (dark pill, matches mockup) ----
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .clip(KinfolkShapes.pill)
                .background(c.navy)
                .clickable(enabled = !submitting, onClick = onSubmit)
                .padding(vertical = 14.dp),
            contentAlignment = Alignment.Center,
        ) {
            Text(
                text = if (submitting) "Creating…" else "Generate Link",
                style = type.sansButton.copy(color = Color.White),
            )
        }
    }
}

// -----------------------------------------------------------------------------
// Result (stage 2)
// -----------------------------------------------------------------------------

@Composable
private fun ShareResultBody(
    link: ShareLinkCreated,
    passcodeSet: Boolean,
    copied: Boolean,
    onCopy: () -> Unit,
    onDone: () -> Unit,
) {
    val c = KinfolkTheme.colors
    val type = KinfolkTheme.typography

    Column(verticalArrangement = Arrangement.spacedBy(KinfolkSpacing.m)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Box(
                modifier = Modifier
                    .size(28.dp)
                    .clip(CircleShape)
                    .background(c.teal),
                contentAlignment = Alignment.Center,
            ) {
                Icon(
                    imageVector = Icons.Filled.Check,
                    contentDescription = null,
                    tint = Color.White,
                    modifier = Modifier.size(16.dp),
                )
            }
            Text("Link Ready!", style = type.heritageTitle)
        }

        // URL pill + Copy Link
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .clip(KinfolkShapes.pill)
                .background(Color.White)
                .padding(start = 16.dp, top = 4.dp, bottom = 4.dp, end = 4.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Text(
                text = link.shareUrl,
                style = type.sansMeta.copy(color = c.navy),
                modifier = Modifier.weight(1f),
                maxLines = 1,
            )
            Box(
                modifier = Modifier
                    .clip(KinfolkShapes.pill)
                    .background(KinfolkGradients.orangeToPink)
                    .clickable(onClick = onCopy)
                    .padding(horizontal = 16.dp, vertical = 10.dp),
            ) {
                Text(
                    text = if (copied) "Copied" else "Copy Link",
                    style = type.sansButton.copy(color = Color.White),
                )
            }
        }

        // Passcode warning banner (only if a passcode was set)
        if (passcodeSet) {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .clip(KinfolkShapes.card)
                    .background(c.accent.copy(alpha = 0.85f))
                    .padding(KinfolkSpacing.m),
                verticalAlignment = Alignment.Top,
                horizontalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                Box(
                    modifier = Modifier
                        .size(28.dp)
                        .clip(CircleShape)
                        .background(Color.White.copy(alpha = 0.18f)),
                    contentAlignment = Alignment.Center,
                ) {
                    Icon(
                        imageVector = Icons.Filled.Shield,
                        contentDescription = null,
                        tint = Color.White,
                        modifier = Modifier.size(16.dp),
                    )
                }
                Text(
                    text = "Send the passcode separately. We don't store it, so keep a copy.",
                    style = type.sansBody.copy(color = Color.White, fontWeight = FontWeight.SemiBold),
                    modifier = Modifier.weight(1f),
                )
            }
        }

        Spacer(Modifier.height(4.dp))
        KinButton(label = "Done", onClick = onDone, modifier = Modifier.fillMaxWidth())
    }
}

// -----------------------------------------------------------------------------
// Toggle row — Foundation-only switch alternative
// -----------------------------------------------------------------------------

@Composable
private fun ToggleRow(label: String, value: Boolean, onChange: (Boolean) -> Unit) {
    val c = KinfolkTheme.colors
    val type = KinfolkTheme.typography
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clip(KinfolkShapes.card)
            .background(c.glassSurface)
            .border(1.dp, c.glassBorder, KinfolkShapes.card)
            .clickable { onChange(!value) }
            .padding(horizontal = KinfolkSpacing.m, vertical = KinfolkSpacing.s),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Box(
            modifier = Modifier
                .size(28.dp)
                .clip(RoundedCornerShape(6.dp))
                .background(c.primary.copy(alpha = 0.12f))
                .border(1.dp, c.primary.copy(alpha = 0.4f), RoundedCornerShape(6.dp)),
            contentAlignment = Alignment.Center,
        ) {
            Icon(
                imageVector = Icons.Filled.Image,
                contentDescription = null,
                tint = c.primary,
                modifier = Modifier.size(16.dp),
            )
        }
        Text(label, style = type.sansBody, modifier = Modifier.weight(1f))
        // Switch track + thumb (Foundation)
        Box(
            modifier = Modifier
                .size(width = 44.dp, height = 24.dp)
                .clip(CircleShape)
                .background(if (value) c.primary else c.navyHairline)
                .clickable { onChange(!value) },
            contentAlignment = if (value) Alignment.CenterEnd else Alignment.CenterStart,
        ) {
            Box(
                modifier = Modifier
                    .padding(horizontal = 2.dp)
                    .size(20.dp)
                    .clip(CircleShape)
                    .background(Color.White),
            )
        }
    }
}

// -----------------------------------------------------------------------------
// DaySlider — drag-and-tap horizontal slider, foundation-only
// -----------------------------------------------------------------------------

@Composable
private fun DaySlider(
    value: Int,
    onValueChange: (Int) -> Unit,
    min: Int,
    max: Int,
) {
    val c = KinfolkTheme.colors
    val ratio = ((value - min).toFloat() / (max - min).toFloat()).coerceIn(0f, 1f)

    BoxWithConstraints(modifier = Modifier.fillMaxWidth().height(28.dp)) {
        val density = LocalDensity.current
        val trackWidthPx = with(density) { maxWidth.toPx() }

        fun setFromX(x: Float) {
            if (trackWidthPx <= 0f) return
            val r = (x / trackWidthPx).coerceIn(0f, 1f)
            val v = (min + r * (max - min)).toInt().coerceIn(min, max)
            if (v != value) onValueChange(v)
        }

        Box(
            modifier = Modifier
                .fillMaxWidth()
                .height(28.dp)
                .pointerInput(min, max) {
                    detectTapGestures(onTap = { offset -> setFromX(offset.x) })
                }
                .pointerInput(min, max) {
                    detectDragGestures(onDrag = { change, _ -> setFromX(change.position.x) })
                },
            contentAlignment = Alignment.CenterStart,
        ) {
            // Track (unfilled)
            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .height(6.dp)
                    .clip(CircleShape)
                    .background(c.navyHairline),
            )
            // Filled portion
            Box(
                modifier = Modifier
                    .height(6.dp)
                    .fillMaxWidth(fraction = ratio.coerceAtLeast(0.001f))
                    .clip(CircleShape)
                    .background(c.primary),
            )
            // Thumb — anchored at ratio
            val thumbOffset = with(density) {
                (trackWidthPx * ratio - 10.dp.toPx()).coerceAtLeast(0f).toDp()
            }
            Box(
                modifier = Modifier
                    .padding(start = thumbOffset)
                    .size(20.dp)
                    .clip(CircleShape)
                    .background(Color.White)
                    .border(2.dp, c.primary, CircleShape),
            )
        }
    }
}
