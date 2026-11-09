package com.tribetails.auntieos.ui.admin

import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import com.tribetails.auntieos.ui.theme.AuntieTheme

/** #1593: what a figure shows while the money it would be worked out from is refused. */
internal const val NO_FIGURE = "-"

/**
 * #1593: a refusal under the field it is about, in the error colour. The field
 * beside it carries `isError`; this is the sentence that says what to change.
 */
@Composable
internal fun FieldProblem(text: String) {
    Text(text, style = AuntieTheme.typography.bodySmall, color = AuntieTheme.colors.error)
}
