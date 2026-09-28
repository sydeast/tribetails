package com.kinfolk.portal.components

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.text.AnnotatedString
import com.kinfolk.portal.theme.KinfolkBrand
import com.kinfolk.portal.theme.KinfolkSpacing
import com.kinfolk.portal.theme.KinfolkTheme
import com.kinfolk.portal.util.claimInviteUrl

/**
 * What `addSecondaryContact` actually did, in place of "Invite sent." (#1018,
 * item 3). That callable sends no email of its own — `onInviteRequestCreate`
 * is an explicit no-op — so a claim link is the only thing that reaches the
 * secondary, and today nothing hands it to them but the primary. This is that
 * link, with a copy affordance so the primary can pass it along themselves.
 *
 * Trust note: `claimInviteSignup` marks the claiming account emailVerified on
 * the theory that only the invited mailbox ever sees the link. That theory
 * was already untested here (no email was ever sent), so showing the link
 * changes nothing about what a wrong recipient could do, only how easily a
 * RIGHT one gets it. See #1018's PR body for the fuller note.
 */
@Composable
fun InviteCreatedNotice(inviteId: String, modifier: Modifier = Modifier) {
    val type = KinfolkTheme.typography
    val clipboard = LocalClipboardManager.current
    var copied by remember(inviteId) { mutableStateOf(false) }
    val url = remember(inviteId) { claimInviteUrl(inviteId) }

    Column(modifier = modifier, verticalArrangement = Arrangement.spacedBy(KinfolkSpacing.xs)) {
        Text(
            "Invite created. No email goes out, so share this link with them yourself:",
            style = type.sansLabel.copy(color = KinfolkBrand.KinTeal),
        )
        Row(
            horizontalArrangement = Arrangement.spacedBy(KinfolkSpacing.s),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(url, style = type.sansMeta, modifier = Modifier.weight(1f), maxLines = 1)
            KinGhostButton(
                label = if (copied) "Copied" else "Copy link",
                onClick = {
                    clipboard.setText(AnnotatedString(url))
                    copied = true
                },
            )
        }
    }
}
