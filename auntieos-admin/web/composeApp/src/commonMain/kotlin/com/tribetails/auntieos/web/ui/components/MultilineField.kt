package com.tribetails.auntieos.web.ui.components

import androidx.compose.animation.animateColorAsState
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.error
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.tribetails.auntieos.web.theme.AuntieTheme

/**
 * Multi-line glass textarea - 1px border, soft glass fill, brand cursor.
 *
 * 0B: optional [errorMessage] helper line, [required] marker, [onFocusLost]
 * blur hook, and screen-reader label/required/error semantics.
 */
@Composable
fun MultilineField(
    value: String,
    onValueChange: (String) -> Unit,
    label: String,
    modifier: Modifier = Modifier,
    placeholder: String = "",
    minLines: Int = 6,
    isError: Boolean = false,
    errorMessage: String? = null,
    required: Boolean = false,
    onFocusLost: (() -> Unit)? = null,
) {
    val c = AuntieTheme.colors
    val showError = fieldHasError(isError, errorMessage)
    var focused by remember { mutableStateOf(false) }
    var wasFocused by remember { mutableStateOf(false) }
    val borderColor = animateColorAsState(
        when {
            showError -> c.error
            focused   -> c.primary
            else      -> c.border
        }, label = "areaBorder",
    ).value
    val a11yDescription = buildString {
        append(label)
        if (required) append(", required")
    }

    Column(modifier = modifier) {
        Text(
            text  = if (required) "${label.uppercase()} *" else label.uppercase(),
            style = AuntieTheme.typography.labelSmall,
            color = if (showError) c.error else c.textDim,
            modifier = Modifier.padding(bottom = 6.dp),
        )
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .clip(RoundedCornerShape(8.dp))
                .background(c.surfaceGlass)
                .border(AuntieTheme.dims.borderHairline, borderColor, RoundedCornerShape(8.dp))
                .padding(horizontal = 12.dp, vertical = 10.dp),
        ) {
            BasicTextField(
                value         = value,
                onValueChange = onValueChange,
                cursorBrush   = SolidColor(c.primary),
                textStyle     = AuntieTheme.typography.bodyMedium.copy(color = c.textPrimary, lineHeight = 22.sp),
                modifier = Modifier
                    .fillMaxWidth()
                    .defaultMinSize(minHeight = (24 * minLines).dp)
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
                    Box(contentAlignment = Alignment.TopStart) {
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

/**
 * [TextFieldValue]-backed variant of [MultilineField], for editors that need the cursor
 * / selection (e.g. the Template Bank Markdown toolbar wrapping the selected text). Same
 * glass styling; the caller owns the [TextFieldValue] so it can apply toolbar edits.
 */
@Composable
fun MultilineFieldValue(
    value: TextFieldValue,
    onValueChange: (TextFieldValue) -> Unit,
    label: String,
    modifier: Modifier = Modifier,
    placeholder: String = "",
    minLines: Int = 6,
) {
    val c = AuntieTheme.colors
    var focused by remember { mutableStateOf(false) }
    Column(modifier = modifier) {
        Text(
            text  = label.uppercase(),
            style = AuntieTheme.typography.labelSmall,
            color = c.textDim,
            modifier = Modifier.padding(bottom = 6.dp),
        )
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .clip(RoundedCornerShape(8.dp))
                .background(c.surfaceGlass)
                .border(AuntieTheme.dims.borderHairline, if (focused) c.primary else c.border, RoundedCornerShape(8.dp))
                .padding(horizontal = 12.dp, vertical = 10.dp),
        ) {
            BasicTextField(
                value         = value,
                onValueChange = onValueChange,
                cursorBrush   = SolidColor(c.primary),
                textStyle     = AuntieTheme.typography.bodyMedium.copy(color = c.textPrimary, lineHeight = 22.sp),
                modifier = Modifier
                    .fillMaxWidth()
                    .defaultMinSize(minHeight = (24 * minLines).dp)
                    .semantics { contentDescription = label }
                    .onFocusChanged { focused = it.isFocused },
                decorationBox = { inner ->
                    Box(contentAlignment = Alignment.TopStart) {
                        if (value.text.isEmpty()) {
                            Text(placeholder, style = AuntieTheme.typography.bodyMedium, color = c.textFaint)
                        }
                        inner()
                    }
                },
            )
        }
    }
}
