package com.tribetails.auntieos.ui.components

import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.*
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.LocalContentColor
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.*
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.*
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import com.composables.icons.lucide.Bluetooth
import com.composables.icons.lucide.ChevronDown
import com.composables.icons.lucide.ChevronLeft
import com.composables.icons.lucide.ChevronUp
import com.composables.icons.lucide.Lucide
import com.composables.icons.lucide.PhoneOutgoing
import com.composables.icons.lucide.Volume2
import com.tribetails.auntieos.ui.theme.AuntieTheme
import com.tribetails.auntieos.voice.AudioRoute

// ─────────────────────────────────────────────────────────────────────────────
// AuntieCard - replaces M3 Card
// Flat rounded surface, no M3 tonal elevation.
// ─────────────────────────────────────────────────────────────────────────────

@Composable
fun AuntieCard(
    modifier: Modifier = Modifier,
    containerColor: Color = AuntieTheme.colors.surface,
    border: BorderStroke? = BorderStroke(0.5.dp, AuntieTheme.colors.border),
    shape: Shape = RoundedCornerShape(16.dp),
    onClick: (() -> Unit)? = null,
    content: @Composable ColumnScope.() -> Unit,
) {
    val base = modifier
        .clip(shape)
        .background(containerColor)
        .then(if (border != null) Modifier.border(border, shape) else Modifier)
    Column(
        modifier = if (onClick != null) base.clickable(onClick = onClick) else base,
        content  = content,
    )
}

// ─────────────────────────────────────────────────────────────────────────────
// AuntieField - replaces M3 OutlinedTextField
// Label above (uppercase, labelSmall). No floating label. Animated border.
// ─────────────────────────────────────────────────────────────────────────────

@Composable
fun AuntieField(
    value: String,
    onValueChange: (String) -> Unit,
    modifier: Modifier = Modifier,
    label: String? = null,
    placeholder: String = "",
    enabled: Boolean = true,
    readOnly: Boolean = false,
    singleLine: Boolean = true,
    minLines: Int = 1,
    maxLines: Int = if (singleLine) 1 else Int.MAX_VALUE,
    keyboardOptions: KeyboardOptions = KeyboardOptions.Default,
    keyboardActions: KeyboardActions = KeyboardActions.Default,
    visualTransformation: VisualTransformation = VisualTransformation.None,
    isError: Boolean = false,
    leading: (@Composable () -> Unit)? = null,
    trailing: (@Composable () -> Unit)? = null,
    // Applied to the inner BasicTextField (not the outer Column) so callers can attach
    // focus traversal / autofill semantics to the actual focusable input. Default no-op.
    fieldModifier: Modifier = Modifier,
) {
    var focused by remember { mutableStateOf(false) }
    val glowAlpha by animateFloatAsState(
        targetValue   = if (focused && !isError) 0.22f else 0f,
        animationSpec = tween(200),
        label         = "fieldGlow",
    )
    val borderWidth by animateFloatAsState(
        targetValue   = if (focused || isError) 1.5f else 1f,
        animationSpec = spring(stiffness = Spring.StiffnessMedium),
        label         = "borderWidth",
    )
    val borderColor by animateColorAsState(
        targetValue = when {
            isError -> AuntieTheme.colors.error
            focused -> AuntieTheme.colors.kinfolkOrange
            else    -> AuntieTheme.colors.border
        },
        label = "fieldBorder",
    )

    Column(modifier = modifier) {
        if (label != null) {
            Text(
                text     = label.uppercase(),
                style    = AuntieTheme.typography.labelSmall,
                color    = if (focused) AuntieTheme.colors.kinfolkOrange else AuntieTheme.colors.textDim,
                modifier = Modifier.padding(bottom = 6.dp),
            )
        }

        val glowColor = AuntieTheme.colors.kinfolkOrange
        BasicTextField(
            value                = value,
            onValueChange        = onValueChange,
            enabled              = enabled,
            readOnly             = readOnly,
            singleLine           = singleLine,
            minLines             = minLines,
            maxLines             = maxLines,
            keyboardOptions      = keyboardOptions,
            keyboardActions      = keyboardActions,
            visualTransformation = visualTransformation,
            cursorBrush          = SolidColor(AuntieTheme.colors.kinfolkOrange),
            textStyle            = AuntieTheme.typography.bodyMedium.copy(color = AuntieTheme.colors.textPrimary),
            modifier = Modifier
                .fillMaxWidth()
                .clip(RoundedCornerShape(12.dp))
                .background(AuntieTheme.colors.surface)
                .drawBehind {
                    val expandPx = 3.dp.toPx()
                    val borderWidthPx = borderWidth.dp.toPx()
                    if (glowAlpha > 0f) {
                        drawRoundRect(
                            color        = glowColor.copy(alpha = glowAlpha),
                            topLeft      = Offset(-expandPx, -expandPx),
                            size         = Size(size.width + expandPx * 2, size.height + expandPx * 2),
                            cornerRadius = CornerRadius(15.dp.toPx()),
                        )
                    }
                    drawRoundRect(
                        color        = borderColor,
                        cornerRadius = CornerRadius(12.dp.toPx()),
                        style        = Stroke(width = borderWidthPx),
                    )
                }
                .onFocusChanged { focused = it.isFocused }
                .then(fieldModifier),
            decorationBox = { innerField ->
                Row(
                    modifier              = Modifier.padding(horizontal = 12.dp, vertical = 12.dp),
                    verticalAlignment     = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    if (leading != null) {
                        CompositionLocalProvider(LocalContentColor provides AuntieTheme.colors.textDim) {
                            leading()
                        }
                    }
                    Box(modifier = Modifier.weight(1f)) {
                        if (value.isEmpty()) {
                            Text(
                                text  = placeholder,
                                style = AuntieTheme.typography.bodyMedium,
                                color = AuntieTheme.colors.textFaint,
                            )
                        }
                        innerField()
                    }
                    if (trailing != null) {
                        CompositionLocalProvider(LocalContentColor provides AuntieTheme.colors.textDim) {
                            trailing()
                        }
                    }
                }
            },
        )
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// AuntieDropdownField - enclosed field + popup. Replaces ExposedDropdownMenuBox.
// ─────────────────────────────────────────────────────────────────────────────

@Composable
fun <T> AuntieDropdownField(
    value: T?,
    options: List<T>,
    onSelect: (T) -> Unit,
    displayText: (T) -> String,
    label: String? = null,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    placeholder: String = "Select…",
) {
    var expanded by remember { mutableStateOf(false) }

    Column(modifier = modifier) {
        if (label != null) {
            Text(
                text     = label.uppercase(),
                style    = AuntieTheme.typography.labelSmall,
                color    = if (expanded) AuntieTheme.colors.kinfolkOrange else AuntieTheme.colors.textDim,
                modifier = Modifier.padding(bottom = 6.dp),
            )
        }
        Box {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .clip(RoundedCornerShape(12.dp))
                    .background(AuntieTheme.colors.surface)
                    .border(
                        1.dp,
                        if (expanded) AuntieTheme.colors.kinfolkOrange else AuntieTheme.colors.border,
                        RoundedCornerShape(12.dp),
                    )
                    .clickable(enabled = enabled) { expanded = !expanded }
                    .padding(horizontal = 12.dp, vertical = 12.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    text     = value?.let(displayText) ?: placeholder,
                    style    = AuntieTheme.typography.bodyMedium,
                    color    = if (value != null) AuntieTheme.colors.textPrimary else AuntieTheme.colors.textFaint,
                    modifier = Modifier.weight(1f),
                    overflow = TextOverflow.Ellipsis,
                    maxLines = 1,
                )
                Icon(
                    imageVector        = if (expanded) Lucide.ChevronUp else Lucide.ChevronDown,
                    contentDescription = null,
                    tint               = AuntieTheme.colors.textDim,
                    modifier           = Modifier.size(16.dp),
                )
            }
            DropdownMenu(
                expanded         = expanded,
                onDismissRequest = { expanded = false },
            ) {
                options.forEach { option ->
                    DropdownMenuItem(
                        text    = { Text(displayText(option)) },
                        onClick = { onSelect(option); expanded = false },
                    )
                }
            }
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// AuntieTopBar - replaces M3 TopAppBar
// ─────────────────────────────────────────────────────────────────────────────

@Composable
fun AuntieTopBar(
    title: String,
    modifier: Modifier = Modifier,
    onBack: (() -> Unit)? = null,
    actions: (@Composable RowScope.() -> Unit)? = null,
) {
    Row(
        modifier = modifier
            .fillMaxWidth()
            .background(AuntieTheme.colors.background)
            .statusBarsPadding()
            .displayCutoutPadding()
            .padding(horizontal = 4.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (onBack != null) {
            AuntieIconBtn(onClick = onBack, modifier = Modifier.size(44.dp)) {
                Icon(Lucide.ChevronLeft, contentDescription = "Back", tint = AuntieTheme.colors.textPrimary)
            }
        } else {
            Spacer(Modifier.width(44.dp))
        }

        Text(
            text     = title,
            style    = AuntieTheme.typography.titleLarge,
            color    = AuntieTheme.colors.textPrimary,
            modifier = Modifier
                .weight(1f)
                .padding(horizontal = 4.dp),
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )

        if (actions != null) {
            Row(
                horizontalArrangement = Arrangement.End,
                verticalAlignment     = Alignment.CenterVertically,
                content               = actions,
            )
        } else {
            Spacer(Modifier.width(44.dp))
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// AuntieScreenScaffold - page primitive
// Wraps optional AuntieTopBar + content slot. Always applies statusBarsPadding()
// so screens are edge-to-edge safe. Opt-in imePadding() for screens with input
// fields. Paints AuntieTheme.colors.background AND the drifting mesh ground
// unless backgroundFullBleed = true, which hands the whole ground to the caller
// (a screen doing its own full-bleed art must not get a second mesh under it).
// NEVER use M3 Scaffold - this primitive replaces it.
//
// The mesh is the Android half of issue #751: every mock draws the screens on a
// navy ground with three drifting brand-coloured blobs behind the panels, the
// web shell has painted them since the port, and Compose had AnimatedMeshBackground
// sitting in AuntieGlass.kt with almost nothing calling it. Putting it here, in
// the one primitive every screen goes through, is what makes the two platforms
// the same world rather than the same palette.
// ─────────────────────────────────────────────────────────────────────────────

@Composable
fun AuntieScreenScaffold(
    title: String? = null,
    modifier: Modifier = Modifier,
    onBack: (() -> Unit)? = null,
    actions: (@Composable RowScope.() -> Unit)? = null,
    imePaddingEnabled: Boolean = false,
    backgroundFullBleed: Boolean = false,
    content: @Composable ColumnScope.() -> Unit,
) {
    var ground: Modifier = Modifier.fillMaxSize()
    if (!backgroundFullBleed) {
        ground = ground.background(AuntieTheme.colors.background)
    }
    // The insets stay on the CONTENT, not on the ground: a mesh that stopped at
    // the status bar would draw a hard edge across the top of every screen.
    var inner: Modifier = Modifier.fillMaxSize().statusBarsPadding()
    if (imePaddingEnabled) {
        inner = inner.imePadding()
    }
    Box(modifier = ground.then(modifier)) {
        if (!backgroundFullBleed) {
            AnimatedMeshBackground(Modifier.matchParentSize())
        }
        Column(modifier = inner) {
            if (title != null || onBack != null) {
                AuntieTopBar(title = title ?: "", onBack = onBack, actions = actions)
            }
            content()
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// AuntieFab - replaces M3 FloatingActionButton
// ─────────────────────────────────────────────────────────────────────────────

@Composable
fun AuntieFab(
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    containerColor: Color = AuntieTheme.colors.kinfolkOrange,
    contentColor: Color = AuntieTheme.colors.background,
    shape: Shape = CircleShape,
    content: @Composable () -> Unit,
) {
    Box(
        modifier = modifier
            .size(56.dp)
            .clip(shape)
            .background(containerColor)
            .clickable(onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        CompositionLocalProvider(LocalContentColor provides contentColor) { content() }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// AuntieChip - replaces M3 FilterChip
// ─────────────────────────────────────────────────────────────────────────────

@Composable
fun AuntieChip(
    selected: Boolean,
    onClick: () -> Unit,
    label: String,
    modifier: Modifier = Modifier,
    selectedContainerColor: Color = AuntieTheme.colors.kinfolkOrange,
    selectedLabelColor: Color = AuntieTheme.colors.background,
) {
    Box(
        modifier = modifier
            .clip(RoundedCornerShape(999.dp))
            .background(if (selected) selectedContainerColor else AuntieTheme.colors.surface2)
            .border(
                1.dp,
                if (selected) selectedContainerColor else AuntieTheme.colors.border,
                RoundedCornerShape(999.dp),
            )
            .clickable(onClick = onClick)
            .padding(horizontal = 14.dp, vertical = 7.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text  = label,
            style = AuntieTheme.typography.labelMedium,
            color = if (selected) selectedLabelColor else AuntieTheme.colors.textDim,
        )
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// AuntieIconBtn - replaces M3 IconButton
// ─────────────────────────────────────────────────────────────────────────────

@Composable
fun AuntieIconBtn(
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    content: @Composable () -> Unit,
) {
    Box(
        modifier         = modifier
            .clip(CircleShape)
            .clickable(enabled = enabled, onClick = onClick)
            .padding(8.dp),
        contentAlignment = Alignment.Center,
        content          = { content() },
    )
}

// ─────────────────────────────────────────────────────────────────────────────
// AuntieTextBtn - replaces M3 TextButton
// ─────────────────────────────────────────────────────────────────────────────

@Composable
fun AuntieTextBtn(
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    contentColor: Color = AuntieTheme.colors.kinfolkOrange,
    content: @Composable RowScope.() -> Unit,
) {
    Row(
        modifier = modifier
            .clip(RoundedCornerShape(8.dp))
            .clickable(enabled = enabled, onClick = onClick)
            .padding(horizontal = 12.dp, vertical = 8.dp),
        verticalAlignment     = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.Center,
    ) {
        CompositionLocalProvider(LocalContentColor provides contentColor) { content() }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// AuntieModal - replaces M3 AlertDialog
// ─────────────────────────────────────────────────────────────────────────────

@Composable
fun AuntieModal(
    onDismissRequest: () -> Unit,
    title: String? = null,
    confirmButton: (@Composable () -> Unit)? = null,
    dismissButton: (@Composable () -> Unit)? = null,
    properties: DialogProperties = DialogProperties(),
    content: @Composable () -> Unit,
) {
    Dialog(
        onDismissRequest = onDismissRequest,
        properties       = properties,
    ) {
        Column(
            modifier = Modifier
                .clip(RoundedCornerShape(20.dp))
                .background(AuntieTheme.colors.surface)
                .border(0.5.dp, AuntieTheme.colors.border, RoundedCornerShape(20.dp))
                .padding(24.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            if (title != null) {
                Text(title, style = AuntieTheme.typography.titleLarge, color = AuntieTheme.colors.textPrimary)
            }
            content()
            if (confirmButton != null || dismissButton != null) {
                Row(
                    modifier              = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.End,
                    verticalAlignment     = Alignment.CenterVertically,
                ) {
                    dismissButton?.invoke()
                    confirmButton?.invoke()
                }
            }
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// AuntieSpinner - replaces M3 CircularProgressIndicator
// ─────────────────────────────────────────────────────────────────────────────

@Composable
fun AuntieSpinner(
    modifier: Modifier = Modifier,
    color: Color = AuntieTheme.colors.kinfolkOrange,
    strokeWidth: Dp = 2.5.dp,
) {
    val infiniteTransition = rememberInfiniteTransition(label = "spinner")
    val angle by infiniteTransition.animateFloat(
        initialValue  = 0f,
        targetValue   = 360f,
        animationSpec = infiniteRepeatable(
            animation  = tween(durationMillis = 750, easing = LinearEasing),
            repeatMode = RepeatMode.Restart,
        ),
        label = "rotation",
    )
    androidx.compose.foundation.Canvas(modifier = modifier) {
        drawArc(
            color      = color,
            startAngle = angle,
            sweepAngle = 270f,
            useCenter  = false,
            style      = Stroke(width = strokeWidth.toPx(), cap = StrokeCap.Round),
        )
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// AuntieLinearProgress - replaces M3 LinearProgressIndicator
// ─────────────────────────────────────────────────────────────────────────────

@Composable
fun AuntieLinearProgress(
    modifier: Modifier = Modifier,
    color: Color = AuntieTheme.colors.kinfolkOrange,
    trackColor: Color = AuntieTheme.colors.surface2,
) {
    val infiniteTransition = rememberInfiniteTransition(label = "progress")
    val fraction by infiniteTransition.animateFloat(
        initialValue  = -0.5f,
        targetValue   = 1.3f,
        animationSpec = infiniteRepeatable(
            animation  = tween(durationMillis = 1000, easing = FastOutSlowInEasing),
            repeatMode = RepeatMode.Restart,
        ),
        label = "sweep",
    )
    Box(
        modifier = modifier
            .fillMaxWidth()
            .height(3.dp)
            .clip(RoundedCornerShape(999.dp))
            .background(trackColor),
    ) {
        BoxWithConstraints(modifier = Modifier.fillMaxSize()) {
            val w = maxWidth
            Box(
                modifier = Modifier
                    .offset(x = w * fraction)
                    .width(w * 0.35f)
                    .fillMaxHeight()
                    .clip(RoundedCornerShape(999.dp))
                    .background(color),
            )
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// AuntieTabRow - replaces M3 TabRow + Tab
// Animated underline indicator, no M3 ripple.
// ─────────────────────────────────────────────────────────────────────────────

@Composable
fun AuntieTabRow(
    selectedIndex: Int,
    tabs: List<String>,
    onSelect: (Int) -> Unit,
    modifier: Modifier = Modifier,
    containerColor: Color = AuntieTheme.colors.background,
    selectedColor: Color = AuntieTheme.colors.kinfolkOrange,
    unselectedColor: Color = AuntieTheme.colors.textDim,
) {
    Column(modifier = modifier.background(containerColor)) {
        Row(modifier = Modifier.fillMaxWidth()) {
            tabs.forEachIndexed { index, label ->
                val selected = index == selectedIndex
                Column(
                    modifier = Modifier
                        .weight(1f)
                        .clickable { onSelect(index) }
                        .padding(vertical = 12.dp),
                    horizontalAlignment = Alignment.CenterHorizontally,
                ) {
                    Text(
                        text  = label,
                        style = AuntieTheme.typography.labelMedium,
                        color = if (selected) selectedColor else unselectedColor,
                    )
                }
            }
        }
        BoxWithConstraints(modifier = Modifier.fillMaxWidth().height(2.dp)) {
            val tabWidth = maxWidth / tabs.size
            val indicatorOffset by animateDpAsState(
                targetValue   = tabWidth * selectedIndex,
                animationSpec = spring(stiffness = Spring.StiffnessMediumLow),
                label         = "tabIndicator",
            )
            Box(
                modifier = Modifier
                    .offset(x = indicatorOffset)
                    .width(tabWidth)
                    .height(2.dp)
                    .clip(RoundedCornerShape(999.dp))
                    .background(selectedColor),
            )
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// AuntieAudioRouteToggle - 3-cell segmented control for the in-call audio route.
// Reuses the AuntieTabRow visual idiom but renders cells (Earpiece / Speaker /
// Bluetooth) and disables cells whose route isn't in `available`.
// Disabled cell: alpha 0.35 + no click handler (so Compose tests see it as not
// enabled per the standard hasClickAction matcher).
// ─────────────────────────────────────────────────────────────────────────────

@Composable
fun AuntieAudioRouteToggle(
    current: AudioRoute,
    available: Set<AudioRoute>,
    onSelect: (AudioRoute) -> Unit,
    modifier: Modifier = Modifier,
) {
    val cells = listOf(
        Triple(AudioRoute.Earpiece,  "Earpiece",  Lucide.PhoneOutgoing),
        Triple(AudioRoute.Speaker,   "Speaker",   Lucide.Volume2),
        Triple(AudioRoute.Bluetooth, "Bluetooth", Lucide.Bluetooth),
    )
    Row(
        modifier = modifier
            .fillMaxWidth()
            .height(40.dp)
            .clip(RoundedCornerShape(8.dp))
            .background(AuntieTheme.colors.surfaceGlass)
            .border(1.dp, AuntieTheme.colors.border, RoundedCornerShape(8.dp)),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        cells.forEach { (route, label, icon) ->
            val enabled  = route in available
            val selected = route == current
            val cellColor = when {
                !enabled -> AuntieTheme.colors.textDim.copy(alpha = 0.35f)
                selected -> AuntieTheme.colors.kinfolkOrange
                else     -> AuntieTheme.colors.textPrimary
            }
            Box(
                modifier = Modifier
                    .weight(1f)
                    .fillMaxHeight()
                    .clickable(enabled = enabled) { onSelect(route) }
                    .padding(horizontal = 8.dp),
                contentAlignment = Alignment.Center,
            ) {
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    Icon(
                        imageVector = icon,
                        contentDescription = label,
                        modifier = Modifier.size(16.dp),
                        tint = cellColor,
                    )
                    Text(
                        text  = label,
                        style = AuntieTheme.typography.labelLarge,
                        color = cellColor,
                    )
                }
            }
        }
    }
}
