package com.tribetails.auntieos.ui.directory

import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import com.tribetails.auntieos.ui.components.AuntieModal
import com.tribetails.auntieos.ui.components.AuntieTextBtn
import com.tribetails.auntieos.ui.components.PrimaryButton
import com.tribetails.auntieos.ui.theme.AuntieTheme

/** `INVITE_TTL_DAYS` in `mytribe/functions/src/lib/schema.ts`. */
internal const val PORTAL_INVITE_TTL_DAYS = 14

/**
 * #1602: what the confirm says before a portal invite goes out. It names the
 * address that will be mailed, because the invite used to fire on one click
 * with no recipient shown. Pure; unit-tested. Same words as the admin web.
 */
internal fun portalInviteConfirmText(householdName: String, email: String): String =
    "Send ${householdName.trim().ifBlank { "this household" }}'s portal claim link to ${email.trim()}? " +
        "The link expires in $PORTAL_INVITE_TTL_DAYS days, and whoever opens it becomes the primary " +
        "for this household."

/**
 * #1602: why Invite to portal is off, or null when it can be sent. Same order
 * as the admin web's `portalInviteBlocker`: no email first, then a primary
 * already on the portal. Pure; unit-tested.
 */
internal fun portalInviteBlocker(email: String, hasActivePrimary: Boolean?): String? = when {
    email.isBlank() -> "No email on file, so there is nobody to invite."
    hasActivePrimary == true -> "Already on the portal."
    else -> null
}

/** The ask before `inviteKinfolkToPortal` runs. Nothing is sent until Send invite. */
@Composable
internal fun PortalInviteConfirmDialog(
    householdName: String,
    email: String,
    onConfirm: () -> Unit,
    onDismiss: () -> Unit,
) {
    AuntieModal(
        onDismissRequest = onDismiss,
        title = "Invite to portal",
        confirmButton = { PrimaryButton(label = "Send invite", onClick = onConfirm) },
        dismissButton = { AuntieTextBtn(onClick = onDismiss) { Text("Cancel") } },
    ) {
        Text(
            portalInviteConfirmText(householdName, email),
            style = AuntieTheme.typography.bodyMedium,
            color = AuntieTheme.colors.textPrimary,
            modifier = Modifier.testTag("portal-invite-confirm"),
        )
    }
}
