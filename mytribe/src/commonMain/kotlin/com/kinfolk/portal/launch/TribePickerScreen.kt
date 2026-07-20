package com.kinfolk.portal.launch

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.Card
import androidx.compose.material.CircularProgressIndicator
import androidx.compose.material.MaterialTheme
import androidx.compose.material.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.unit.dp
import com.kinfolk.portal.portal.TribeSummary
import com.kinfolk.portal.theme.KinfolkBrand
import com.kinfolk.portal.theme.LocalKinfolkTypography

@Composable
fun TribePickerScreen(
    tribes: List<TribeSummary>?,
    onPick: (String) -> Unit,
    onSignOut: (() -> Unit)? = null,
) {
    Column(modifier = Modifier.fillMaxSize().padding(24.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Row(modifier = Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Text("Choose a Tribe", style = MaterialTheme.typography.h5)
            Spacer(Modifier.weight(1f))
            // Operators land here before the shell exists, so this is their
            // only way out of a picked-wrong-account session.
            if (onSignOut != null) LaunchSignOutButton(onSignOut = onSignOut)
        }
        if (tribes == null) {
            Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                CircularProgressIndicator()
            }
            return
        }
        LazyColumn(
            verticalArrangement = Arrangement.spacedBy(8.dp),
            contentPadding = PaddingValues(vertical = 8.dp),
            modifier = Modifier.fillMaxSize(),
        ) {
            items(tribes, key = { it.id }) { tribe ->
                Card(modifier = Modifier.fillMaxWidth().clickable { onPick(tribe.id) }) {
                    Text(
                        tribe.displayName,
                        modifier = Modifier.fillMaxWidth().padding(16.dp),
                        style = MaterialTheme.typography.subtitle1,
                    )
                }
            }
        }
    }
}

/**
 * "Sign Out" text affordance for pre-shell screens (TribePicker, NoTribes),
 * mirroring the inline-link treatment of SignInScreen's "Forgot password?"
 * rather than a pill CTA. Signed-in shell screens keep their avatar-menu
 * sign-out; this exists for destinations that render without the shell chrome.
 */
@Composable
fun LaunchSignOutButton(onSignOut: () -> Unit, modifier: Modifier = Modifier) {
    val type = LocalKinfolkTypography.current
    Text(
        text = "Sign Out",
        style = type.sansLabel.copy(
            color = KinfolkBrand.NavySoft,
            fontWeight = FontWeight.SemiBold,
            textDecoration = TextDecoration.Underline,
        ),
        modifier = modifier
            .clickable { onSignOut() }
            .padding(8.dp),
    )
}
