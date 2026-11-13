package com.tribetails.auntieos.ui.inbox
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.TextStyle
/**
 * One stored message body. Rich text (the server's tag subset) is drawn as
 * formatting; a body with no tags is drawn as typed (its entities decoded
 * once). Never shows raw tags.
 */
@Composable
fun MessageBody(body: String, style: TextStyle, color: Color, linkColor: Color, modifier: Modifier = Modifier) {
    val text = remember(body, linkColor) {
        if (hasRichTextMarkup(body)) richTextToAnnotatedString(body, linkColor) else AnnotatedString(messageBodyText(body))
    }
    Text(text = text, style = style, color = color, modifier = modifier)
}
