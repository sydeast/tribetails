package com.tribetails.auntieos.ui.components

import androidx.compose.animation.animateColorAsState
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
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.error
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import com.tribetails.auntieos.ui.theme.*
import com.tribetails.auntieos.ui.theme.AuntieTheme

/**
 * 0B: parity with the web primitive. Readable resting line, optional per-field
 * [errorMessage] helper, [required] marker, [onFocusLost] blur hook, and
 * screen-reader label/required/error semantics.
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
    // What the soft keyboard's action key does. Default is the platform's
    // (Next moves focus, Done hides the keyboard).
    keyboardActions: KeyboardActions = KeyboardActions.Default,
    // Applied to the inner BasicTextField so a caller can attach autofill
    // semantics to the actual focusable input. Default no-op, same as
    // AuntieField's.
    fieldModifier: Modifier = Modifier,
) {
    val c = AuntieTheme.colors
    val showError = fieldHasError(isError, errorMessage)
    var focused by remember { mutableStateOf(false) }
    var wasFocused by remember { mutableStateOf(false) }
    val borderColor = animateColorAsState(
        when {
            showError -> c.error
            focused   -> c.kinfolkOrange
            else      -> c.border
        }, label = "fieldBorder",
    ).value
    val a11yDescription = buildString {
        append(label)
        if (required) append(", required")
    }

    Column(modifier = modifier) {
        Text(
            text = if (required) "${label.uppercase()} *" else label.uppercase(),
            style = AuntieTheme.typography.labelSmall,
            color = if (showError) c.error else c.textDim,
            modifier = Modifier.padding(bottom = 6.dp),
        )
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .height(if (singleLine) 36.dp else 88.dp)
                .drawBehind {
                    val y = size.height - 0.5.dp.toPx()
                    drawLine(
                        color = borderColor,
                        start = Offset(0f, y),
                        end = Offset(size.width, y),
                        // 0B: 1.5px resting line (was 1px) for contrast at rest.
                        strokeWidth = if (focused) 2.0.dp.toPx() else 1.5.dp.toPx(),
                    )
                }
                .padding(vertical = 8.dp),
            contentAlignment = Alignment.TopStart,
        ) {
            BasicTextField(
                value = value,
                onValueChange = onValueChange,
                enabled = enabled,
                singleLine = singleLine,
                cursorBrush = SolidColor(AuntieTheme.colors.kinfolkOrange),
                textStyle = AuntieTheme.typography.bodyMedium.copy(color = AuntieTheme.colors.textPrimary),
                keyboardOptions = KeyboardOptions(keyboardType = keyboardType, imeAction = imeAction),
                keyboardActions = keyboardActions,
                modifier = Modifier
                    .fillMaxWidth()
                    .semantics {
                        contentDescription = a11yDescription
                        if (showError && !errorMessage.isNullOrBlank()) error(errorMessage)
                    }
                    .onFocusChanged {
                        val now = it.isFocused
                        if (blurOccurred(wasFocused, now)) onFocusLost?.invoke()
                        wasFocused = now
                        focused = now
                    }
                    .then(fieldModifier),
                decorationBox = { inner ->
                    Box(contentAlignment = Alignment.CenterStart) {
                        if (value.isEmpty()) {
                            Text(
                                text = placeholder,
                                style = AuntieTheme.typography.bodyMedium,
                                color = AuntieTheme.colors.textFaint,
                            )
                        }
                        inner()
                    }
                },
            )
        }
        if (!errorMessage.isNullOrBlank()) {
            Text(
                text = errorMessage,
                style = AuntieTheme.typography.labelSmall,
                color = c.error,
                modifier = Modifier.padding(top = 4.dp),
            )
        }
    }
}
