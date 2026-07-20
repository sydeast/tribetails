package com.kinfolk.portal.error

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material.MaterialTheme
import androidx.compose.material.Surface
import androidx.compose.material.Text
import androidx.compose.material.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp

@Composable
fun OpaqueErrorBanner(
    envelope: ErrorEnvelope,
    onDismiss: () -> Unit,
    onRetry: (() -> Unit)? = null,
) {
    Surface(
        color = MaterialTheme.colors.surface,
        shape = MaterialTheme.shapes.medium,
        modifier = Modifier.fillMaxWidth(),
    ) {
        Column(modifier = Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(envelope.userMessage, style = MaterialTheme.typography.body1)
            Text(
                envelope.clientErrorId,
                style = MaterialTheme.typography.caption,
                color = Color.Gray,
            )
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                if (onRetry != null) TextButton(onClick = onRetry) { Text("Try again") }
                TextButton(onClick = onDismiss) { Text("Dismiss") }
            }
        }
    }
}
