package com.tribetails.auntieos.web.screens.account

import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.tribetails.auntieos.web.data.AuthClient
import com.tribetails.auntieos.web.data.AuthUser
import com.tribetails.auntieos.web.data.FirestoreClient
import com.tribetails.auntieos.web.data.FirestoreResult
import com.tribetails.auntieos.web.screens.settings.ProfilePanel
import com.tribetails.auntieos.web.screens.settings.SecurityPanel
import com.tribetails.auntieos.web.theme.AuntieTheme
import com.tribetails.auntieos.web.ui.components.DenPanel
import com.tribetails.auntieos.web.ui.components.DenScreenHeading
import com.tribetails.auntieos.web.ui.components.PrimaryButton
import com.tribetails.auntieos.web.ui.components.ScreenScaffold
import com.tribetails.auntieos.web.ui.components.StatusToast
import com.tribetails.auntieos.web.ui.components.ToastKind

/**
 * Account Settings (test-run punch list #4): the operator's OWN account, moved out
 * of the business Settings screen. Reached by clicking the account chip in the nav
 * rail. Holds the personal Profile + Security (login email/password) only; business
 * settings (business profile, hours, integrations, etc.) stay under Settings.
 *
 * Reuses the existing ProfilePanel + SecurityPanel (now internal) verbatim, so the
 * profile-save + credential flows are identical; only their home changed.
 */
@Composable
fun AccountSettingsScreen(
    authUser: AuthUser,
    auth: AuthClient,
    onOpenNotifications: () -> Unit,
) {
    val scope = rememberCoroutineScope()
    val client = remember { FirestoreClient() }
    val dims = AuntieTheme.dims

    val profileResult by remember(authUser.uid) { client.userProfileStream(authUser.uid) }
        .collectAsState(initial = FirestoreResult.Loading)
    val profileLoaded = (profileResult as? FirestoreResult.Data)?.value

    var displayName by remember(profileLoaded) { mutableStateOf(profileLoaded?.displayName ?: "") }
    var firstName by remember(profileLoaded) { mutableStateOf(profileLoaded?.firstName ?: "") }
    var lastName by remember(profileLoaded) { mutableStateOf(profileLoaded?.lastName ?: "") }
    var profilePhone by remember(profileLoaded) { mutableStateOf(profileLoaded?.phone ?: "") }
    var profileTitle by remember(profileLoaded) { mutableStateOf(profileLoaded?.title ?: "") }
    var profileBio by remember(profileLoaded) { mutableStateOf(profileLoaded?.bio ?: "") }
    var photoUrl by remember(profileLoaded) { mutableStateOf(profileLoaded?.photoUrl ?: "") }
    var savingProfile by remember { mutableStateOf(false) }
    var signingOut by remember { mutableStateOf(false) }
    var profileToast by remember { mutableStateOf<Pair<String, ToastKind>?>(null) }

    ScreenScaffold {
        DenScreenHeading(
            kicker = "The Den · Account",
            title = "Your account.",
            subtitle = "Your personal profile and login. Business settings live under Settings.",
        )
        Spacer(Modifier.height(dims.space5))
        ProfilePanel(
            authUser = authUser, auth = auth, client = client, scope = scope,
            displayName = displayName, onDisplayName = { displayName = it },
            firstName = firstName, onFirstName = { firstName = it },
            lastName = lastName, onLastName = { lastName = it },
            profilePhone = profilePhone, onProfilePhone = { profilePhone = it },
            profileTitle = profileTitle, onProfileTitle = { profileTitle = it },
            profileBio = profileBio, onProfileBio = { profileBio = it },
            photoUrl = photoUrl, onPhotoUrl = { photoUrl = it },
            profileLoaded = profileLoaded,
            savingProfile = savingProfile, onSavingProfile = { savingProfile = it },
            profileToast = profileToast, onProfileToast = { profileToast = it },
            signingOut = signingOut, onSigningOut = { signingOut = it },
        )
        Spacer(Modifier.height(dims.space5))
        SecurityPanel(authUser = authUser, auth = auth, scope = scope)
        Spacer(Modifier.height(dims.space5))
        DenPanel(
            title = "Notifications",
            subtitle = "Choose what reaches you, and how. Your business sets which channels each " +
                "notification can use; you pick what you actually receive within those.",
        ) {
            PrimaryButton(
                label = "Open my notification settings",
                onClick = onOpenNotifications,
                modifier = Modifier.fillMaxWidth(),
            )
        }

        profileToast?.let { (msg, kind) ->
            StatusToast(visible = true, message = msg, kind = kind, onDismiss = { profileToast = null })
        }
    }
}
