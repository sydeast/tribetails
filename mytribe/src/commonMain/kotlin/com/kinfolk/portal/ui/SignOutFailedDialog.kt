package com.kinfolk.portal.ui

import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable

/**
 * #2140: said over whatever screen the kinfolk lands back on when sign-out was
 * refused, because the shell re-checks the account and returns them to it.
 * Drawn by KinfolkPortalAppGuarded from [com.kinfolk.portal.auth.SignOutFailure].
 */
@Composable
fun SignOutFailedDialog(message: String, onDismiss: () -> Unit) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Still signed in") },
        text = { Text(message) },
        confirmButton = {
            TextButton(onClick = onDismiss) { Text("OK") }
        },
    )
}
