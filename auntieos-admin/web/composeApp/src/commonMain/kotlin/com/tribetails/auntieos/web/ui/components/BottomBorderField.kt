package com.tribetails.auntieos.web.ui.components

import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.Spring
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusProperties
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.error
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import com.tribetails.auntieos.web.theme.AuntieTheme

/**
 * Single-line text input with bottom-border-only treatment (no chunky outline).
 *
 * 0B: a resting line heavy enough to read against the dark ground, an optional
 * per-field [errorMessage] helper line, a [required] marker, an [onFocusLost]
 * blur hook for on-blur validation, and screen-reader label/required/error
 * semantics (not color-only).
 */
@Composable
fun BottomBorderField(
    value: String,
    onValueChange: (String) -> Unit,
    label: String,
    modifier: Modifier = Modifier,
    placeholder: String = "",
    enabled: Boolean = true,
    isError: Boolean = false,
    errorMessage: String? = null,
    required: Boolean = false,
    onFocusLost: (() -> Unit)? = null,
    keyboardType: KeyboardType = KeyboardType.Text,
    imeAction: ImeAction = ImeAction.Next,
    singleLine: Boolean = true,
    // 02-sign-in items 2/3: explicit Tab/IME traversal. Pass [fieldFocusRequester]
    // to let a parent target this field; [nextFocusRequester] wires Tab/Next to the
    // following field; [onImeAction] fires on the soft-keyboard Next/Done action.
    fieldFocusRequester: FocusRequester? = null,
    nextFocusRequester: FocusRequester? = null,
    onImeAction: (() -> Unit)? = null,
) {
    val c = AuntieTheme.colors
    val showError = fieldHasError(isError, errorMessage)
    val focusRequester = fieldFocusRequester ?: remember { FocusRequester() }
    val interactionSource = remember { androidx.compose.foundation.interaction.MutableInteractionSource() }
    var focused by remember { mutableStateOf(false) }
    var wasFocused by remember { mutableStateOf(false) }
    val borderColor = animateColorAsState(
        when {
            showError -> c.error
            focused   -> c.primary
            else      -> c.border
        }, label = "fieldBorder",
    ).value
    // 0B: a readable resting line (1.5px, was 0.5px) so the field boundary meets
    // contrast at rest; focus thickens it further.
    val lineWidth by animateFloatAsState(
        targetValue   = if (focused) 2.0f else 1.5f,
        animationSpec = spring(stiffness = Spring.StiffnessMedium),
        label         = "lineWidth",
    )
    val glowAlpha by animateFloatAsState(
        targetValue   = if (focused) 0.3f else 0f,
        animationSpec = tween(250),
        label         = "lineGlow",
    )

    // Screen-reader semantics: announce the label + requiredness, and the error
    // text when present (error is conveyed non-visually, not by color alone).
    val a11yDescription = buildString {
        append(label)
        if (required) append(", required")
    }

    Column(modifier = modifier) {
        Text(
            text  = if (required) "${label.uppercase()} *" else label.uppercase(),
            style = AuntieTheme.typography.labelSmall,
            color = when {
                showError -> c.error
                focused   -> c.primary
                else      -> c.textDim
            },
            modifier = Modifier.padding(bottom = 6.dp),
        )
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .height(if (singleLine) 36.dp else 88.dp)
                // The tap-forward wrapper must not itself land in Tab order, or it
                // intercepts the Email->Password traversal ("must Tab twice"). Only
                // the inner BasicTextField participates in focus.
                //
                // ORDER IS LOAD-BEARING: focusProperties applies to the focusTarget
                // that comes AFTER it in the chain. It must sit BEFORE .clickable so
                // canFocus=false binds to the clickable's own focusTarget. If placed
                // after .clickable, there is no following focusTarget in this chain,
                // so canFocus=false cascades onto the child BasicTextField and makes
                // the field itself unfocusable (click fires but no focus, no
                // keystrokes). That was the web/desktop "can't type in login" bug.
                .focusProperties { canFocus = false }
                // P1-FORMS fix 2026-05-26: forward taps anywhere inside the
                // Box to the inner BasicTextField. Previously the field only
                // gained focus when the small text-baseline area was tapped;
                // padding zones swallowed the gesture and looked dead.
                .clickable(
                    interactionSource = interactionSource,
                    indication = null,
                    enabled = enabled,
                    onClick = { focusRequester.requestFocus() },
                )
                .drawBehind {
                    val y = size.height - 1.dp.toPx()
                    // Glow
                    if (glowAlpha > 0f) {
                        drawRect(
                            brush = Brush.verticalGradient(
                                colors = listOf(Color.Transparent, c.primary.copy(alpha = glowAlpha)),
                                startY = y - 4.dp.toPx(),
                                endY   = y,
                            ),
                            topLeft = Offset(0f, y - 4.dp.toPx()),
                            size    = Size(size.width, 4.dp.toPx()),
                        )
                    }
                    drawLine(
                        color       = borderColor,
                        start       = Offset(0f, y),
                        end         = Offset(size.width, y),
                        strokeWidth = lineWidth,
                    )
                }
                .padding(vertical = 8.dp),
            contentAlignment = Alignment.TopStart,
        ) {
            BasicTextField(
                value          = value,
                onValueChange  = onValueChange,
                enabled        = enabled,
                singleLine     = singleLine,
                cursorBrush    = SolidColor(c.primary),
                textStyle      = AuntieTheme.typography.bodyMedium.copy(color = c.textPrimary),
                keyboardOptions = KeyboardOptions(keyboardType = keyboardType, imeAction = imeAction),
                keyboardActions = KeyboardActions(
                    onNext = { onImeAction?.invoke() },
                    onDone = { onImeAction?.invoke() },
                ),
                modifier = Modifier
                    .fillMaxWidth()
                    .focusRequester(focusRequester)
                    .then(if (nextFocusRequester != null) Modifier.focusProperties { next = nextFocusRequester } else Modifier)
                    .semantics {
                        contentDescription = a11yDescription
                        if (showError && !errorMessage.isNullOrBlank()) error(errorMessage)
                    }
                    .onFocusChanged {
                        val now = it.isFocused
                        if (blurOccurred(wasFocused, now)) onFocusLost?.invoke()
                        wasFocused = now
                        focused = now
                    },
                decorationBox = { inner ->
                    Box(contentAlignment = Alignment.CenterStart) {
                        if (value.isEmpty()) {
                            Text(
                                text  = placeholder,
                                style = AuntieTheme.typography.bodyMedium,
                                color = c.textFaint,
                            )
                        }
                        inner()
                    }
                },
            )
        }
        if (!errorMessage.isNullOrBlank()) {
            Text(
                text  = errorMessage,
                style = AuntieTheme.typography.labelSmall,
                color = c.error,
                modifier = Modifier.padding(top = 4.dp),
            )
        }
    }
}
