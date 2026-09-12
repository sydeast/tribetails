package com.tribetails.auntieos.ui.admin

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel
import com.composables.icons.lucide.Bell
import com.composables.icons.lucide.Camera
import com.composables.icons.lucide.Check
import com.composables.icons.lucide.Lock
import com.composables.icons.lucide.LogOut
import com.composables.icons.lucide.Lucide
import com.composables.icons.lucide.Mail
import com.composables.icons.lucide.Smartphone
import com.composables.icons.lucide.TriangleAlert
import com.tribetails.auntieos.AuntieOSApp
import com.tribetails.auntieos.data.model.AdminNotificationPrefs
import com.tribetails.auntieos.data.model.BusinessAdminRosterSource
import com.tribetails.auntieos.data.model.BusinessSettings
import com.tribetails.auntieos.data.model.ChannelSwitchScope
import com.tribetails.auntieos.data.model.NotificationMatrix
import com.tribetails.auntieos.data.model.UserProfile
import com.tribetails.auntieos.data.model.accountChannelScopes
import com.tribetails.auntieos.data.model.applyChannelToggle
import com.tribetails.auntieos.data.model.channelMasterCount
import com.tribetails.auntieos.data.model.channelMasterOn
import com.tribetails.auntieos.ui.components.AuntieAvatar
import com.tribetails.auntieos.ui.components.AuntieBanner
import com.tribetails.auntieos.ui.components.AuntieBannerTone
import com.tribetails.auntieos.ui.components.AuntieField
import com.tribetails.auntieos.ui.components.AuntiePasswordField
import com.tribetails.auntieos.ui.components.AuntieScreenScaffold
import com.tribetails.auntieos.ui.components.AuntieSettingRow
import com.tribetails.auntieos.ui.components.AuntieStatusPill
import com.tribetails.auntieos.ui.components.AuntieStatusTone
import com.tribetails.auntieos.ui.components.AuntieToggle
import com.tribetails.auntieos.ui.components.BottomBorderField
import com.tribetails.auntieos.ui.components.DenCrumb
import com.tribetails.auntieos.ui.components.DenPanel
import com.tribetails.auntieos.ui.components.DenScreenHeading
import com.tribetails.auntieos.ui.components.GhostButton
import com.tribetails.auntieos.ui.components.LoadingHint
import com.tribetails.auntieos.ui.components.PrimaryButton
import com.tribetails.auntieos.ui.components.StatusToast
import com.tribetails.auntieos.ui.components.ToastKind
import com.tribetails.auntieos.ui.theme.AuntieTheme
import kotlinx.coroutines.launch

/**
 * Account Settings (punch list #4): the operator's own account, moved out of the
 * business Admin Settings screen. Reached from the "Your account" entry on Admin
 * Settings, which is why the crumb trail reads "Settings / User profile".
 *
 * #755 sweep (User profile), matched to
 * `ui-ideas/auntieos-user-profile-2026-05-27.html` and to the web `Account`
 * screen:
 *
 *   hero    the kit band: crumbs, the avatar in `leading`, the operator's name
 *           as the title, the role line as `detail`, the email under it, the
 *           three tags as kit pills, then Change photo and Save profile
 *   Profile the inline fields, saved by the hero button
 *   Business profile   the same five fields the web panel edits, saved through
 *           the view model's diff-and-save. Until this pass Android decoded
 *           businessName / businessEmail / businessPhone / businessAddress and
 *           diffed them, and no screen could edit them.
 *   Notifications      one switch per channel, over the same store the
 *           My Notifications screen edits row by row
 *   Security           a reset-link row and a Sign out row, then the login
 *           email form
 *
 * The typed current / new / confirm password form is gone, as it went on web
 * under #719: the mock draws "Change password" as a reset link, which also
 * works for an operator who has forgotten the current password.
 * `changeLoginPassword` stays on the view model; nothing about the credential
 * flow broke, this screen just stopped asking for three password boxes.
 *
 * The mock's third right-column card, "Sign out all devices", is drawn there as
 * an explicit "Suggestion, not in current model". Nothing in this app revokes
 * refresh tokens, so it is not built here.
 */
@Composable
fun AccountSettingsScreen(
    onBack: () -> Unit,
    onOpenNotifications: () -> Unit = {},
    viewModel: AdminSettingsViewModel = viewModel<AdminSettingsViewModel>(),
) {
    val uiState by viewModel.uiState.collectAsState()
    val context = LocalContext.current
    val dims = AuntieTheme.dims

    val avatarPicker = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.PickVisualMedia(),
    ) { uri -> if (uri != null) viewModel.uploadAvatar(context, uri) }

    var toastMessage by remember { mutableStateOf("") }
    var toastVisible by remember { mutableStateOf(false) }
    var toastKind by remember { mutableStateOf(ToastKind.Info) }

    LaunchedEffect(Unit) {
        viewModel.loadUserProfile()
        viewModel.loadBusinessSettings()
    }
    LaunchedEffect(uiState.profileSaveSuccess) {
        if (uiState.profileSaveSuccess) {
            toastMessage = "Profile saved"; toastKind = ToastKind.Success; toastVisible = true
            viewModel.clearProfileSaveSuccess()
        }
    }
    LaunchedEffect(uiState.saveSuccess) {
        if (uiState.saveSuccess) {
            toastMessage = "Business profile saved"; toastKind = ToastKind.Success; toastVisible = true
            viewModel.clearSaveSuccess()
        }
    }
    LaunchedEffect(uiState.passwordResetSent) {
        if (uiState.passwordResetSent) {
            toastMessage = "Password reset email sent"; toastKind = ToastKind.Success; toastVisible = true
            viewModel.clearPasswordResetSent()
        }
    }
    LaunchedEffect(uiState.error) {
        val err = uiState.error
        if (err != null) {
            toastMessage = err; toastKind = ToastKind.Error; toastVisible = true
            viewModel.clearError()
        }
    }

    Box(modifier = Modifier.fillMaxSize()) {
        AuntieScreenScaffold(title = "Account", onBack = onBack, imePaddingEnabled = true) {
            Column(
                modifier = Modifier
                    .fillMaxSize()
                    .padding(dims.space4)
                    .verticalScroll(rememberScrollState()),
            ) {
                AccountHero(
                    profile = uiState.profile,
                    isUploadingAvatar = uiState.isUploadingAvatar,
                    isLoading = uiState.isLoading,
                    onBack = onBack,
                    onPickAvatar = {
                        avatarPicker.launch(
                            PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly),
                        )
                    },
                    onSaveProfile = { viewModel.saveProfile() },
                )
                Spacer(Modifier.height(dims.space5))

                // One column on a phone, in the mock's order: its left column
                // (Profile, Business profile) then its right (Notifications,
                // Security).
                ProfilePanel(
                    profile = uiState.profile,
                    onProfileField = viewModel::updateProfileField,
                )
                Spacer(Modifier.height(dims.space5))

                BusinessProfilePanel(
                    settings = uiState.businessSettings,
                    onSave = { viewModel.updateBusinessSettings(it) },
                )
                Spacer(Modifier.height(dims.space5))

                NotificationChannelsPanel(onOpenNotifications = onOpenNotifications)
                Spacer(Modifier.height(dims.space5))

                SecurityPanel(
                    email = uiState.profile.email,
                    isSending = uiState.isSendingPasswordReset,
                    busy = uiState.credentialBusy,
                    message = uiState.credentialMessage,
                    onSendReset = { viewModel.sendPasswordResetEmail(uiState.profile.email) },
                    onChangeEmail = { curPw, newEmail -> viewModel.changeLoginEmail(curPw, newEmail) },
                )
            }
        }

        StatusToast(
            visible = toastVisible,
            message = toastMessage,
            kind = toastKind,
            onDismiss = { toastVisible = false },
            modifier = Modifier.align(Alignment.BottomCenter).padding(dims.space4),
        )
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Hero
// ─────────────────────────────────────────────────────────────────────────────

/** The web `roleLabel`, word for word, so the two heroes read the same line. */
internal fun accountRoleLine(title: String, sandbox: Boolean): String =
    listOf(title.trim(), if (sandbox) "Test admin (sandbox)" else "Operator (full admin)")
        .filter { it.isNotBlank() }
        .joinToString(" · ")

/** First 10 characters of the uid, the mock's `uid: nppJN0a4x2…` badge. */
internal fun accountUidBadge(uid: String): String =
    if (uid.length > 10) uid.take(10) + "…" else uid

/** One or two letters for the avatar tile, the web `profileInitials`. */
internal fun accountInitials(name: String): String {
    val words = name.trim().split(Regex("\\s+")).filter { it.isNotEmpty() }
    if (words.isEmpty()) return "?"
    val first = words.first().first()
    val last = if (words.size > 1) words.last().first() else null
    return (first.toString() + (last?.toString() ?: "")).uppercase()
}

/**
 * The mock's hero on the kit band: avatar 88dp at the mock's 26 radius, the
 * name as the title, the role line, the email, the tags, and the two actions.
 *
 * The "Sole admin" pill is the only one needing a round-trip, so it loads here:
 * when `listBusinessAdmins` fails there is simply no pill, because "you are the
 * only admin" is a claim this screen must not make without the roster that
 * proves it. The pills take the mock's own tones: `.tag` orange (Active),
 * `.tag.sole` purple, `.tag.uid` teal.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun AccountHero(
    profile: UserProfile,
    isUploadingAvatar: Boolean,
    isLoading: Boolean,
    onBack: () -> Unit,
    onPickAvatar: () -> Unit,
    onSaveProfile: () -> Unit,
) {
    val c = AuntieTheme.colors
    val repo = remember { AuntieOSApp.instance.repository }
    var soleAdmin by remember { mutableStateOf(false) }
    var sandbox by remember { mutableStateOf(false) }
    LaunchedEffect(Unit) {
        repo.listBusinessAdmins().onSuccess { roster ->
            soleAdmin = roster.source != BusinessAdminRosterSource.None && roster.members.size == 1
        }
        sandbox = repo.isTestAdminActive()
    }
    val name = profile.displayLabel
    DenScreenHeading(
        kicker = "The Den · Account",
        crumbs = listOf(DenCrumb("Settings", onBack), DenCrumb("User profile")),
        title = name,
        detail = accountRoleLine(profile.title, sandbox),
        modifier = Modifier.fillMaxWidth(),
        leading = {
            AuntieAvatar(
                imageUrl = profile.photoUrl.ifBlank { null },
                initials = accountInitials(name),
                size = 88.dp,
                shape = RoundedCornerShape(26.dp),
                gradientSeed = profile.uid.ifBlank { name },
            )
        },
        content = {
            Text(
                text = profile.email.ifBlank { "No login email on file" },
                style = AuntieTheme.typography.bodySmall,
                color = c.textDim,
            )
        },
        badges = {
            // AdminGate stands in front of this route, so the account IS
            // active by the time this renders.
            AuntieStatusPill(label = "Active", tone = AuntieStatusTone.Orange, mono = true)
            if (soleAdmin) {
                AuntieStatusPill(label = "Sole admin", tone = AuntieStatusTone.Purple, mono = true)
            }
            if (profile.uid.isNotBlank()) {
                AuntieStatusPill(
                    label = "uid: ${accountUidBadge(profile.uid)}",
                    tone = AuntieStatusTone.Teal,
                    mono = true,
                )
            }
        },
        trailing = {
            FlowRow(
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                GhostButton(
                    label = if (isUploadingAvatar) "Uploading…" else "Change photo",
                    leading = { Icon(Lucide.Camera, contentDescription = null, modifier = Modifier.size(16.dp), tint = c.textPrimary) },
                    onClick = onPickAvatar,
                    enabled = !isUploadingAvatar,
                )
                PrimaryButton(
                    label = "Save profile",
                    leading = { Icon(Lucide.Check, contentDescription = null, modifier = Modifier.size(16.dp), tint = c.background) },
                    onClick = onSaveProfile,
                    enabled = !isLoading && !isUploadingAvatar,
                )
            }
        },
    )
}

// ─────────────────────────────────────────────────────────────────────────────
// Profile
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The mock's Profile card: two pairs, the display name and the bio between,
 * on the mock's bottom-rule fields (`.lab` over `.fld`, which is
 * [BottomBorderField]). The avatar row and the Save button that used to sit
 * here moved into the hero.
 *
 * Email stays editable here although the mock draws it only in the hero: it
 * is a persisted `users/{uid}` field this panel has always edited, and taking
 * an editable field away is not a fidelity fix.
 */
@Composable
internal fun ProfilePanel(
    profile: UserProfile,
    onProfileField: ((UserProfile) -> UserProfile) -> Unit,
) {
    val dims = AuntieTheme.dims
    DenPanel(title = "Profile", subtitle = "What kinfolk see on your KinTales and replies.") {
        Row(horizontalArrangement = Arrangement.spacedBy(dims.space4), modifier = Modifier.fillMaxWidth()) {
            BottomBorderField(
                value = profile.firstName,
                onValueChange = { v -> onProfileField { it.copy(firstName = v) } },
                label = "First name",
                modifier = Modifier.weight(1f),
            )
            BottomBorderField(
                value = profile.lastName,
                onValueChange = { v -> onProfileField { it.copy(lastName = v) } },
                label = "Last name",
                modifier = Modifier.weight(1f),
            )
        }
        Spacer(Modifier.height(dims.space3))
        BottomBorderField(
            value = profile.displayName,
            onValueChange = { v -> onProfileField { it.copy(displayName = v) } },
            label = "Display name",
            modifier = Modifier.fillMaxWidth(),
        )
        Spacer(Modifier.height(dims.space3))
        Row(horizontalArrangement = Arrangement.spacedBy(dims.space4), modifier = Modifier.fillMaxWidth()) {
            BottomBorderField(
                value = profile.email,
                onValueChange = { v -> onProfileField { it.copy(email = v) } },
                label = "Email address",
                modifier = Modifier.weight(1f),
            )
            BottomBorderField(
                value = profile.phone,
                onValueChange = { v -> onProfileField { it.copy(phone = v) } },
                label = "Phone",
                modifier = Modifier.weight(1f),
            )
        }
        Spacer(Modifier.height(dims.space3))
        BottomBorderField(
            value = profile.title,
            onValueChange = { v -> onProfileField { it.copy(title = v) } },
            label = "Title / Role",
            modifier = Modifier.fillMaxWidth(),
        )
        Spacer(Modifier.height(dims.space3))
        BottomBorderField(
            value = profile.bio,
            onValueChange = { v -> onProfileField { it.copy(bio = v) } },
            label = "Bio",
            placeholder = "A short note for your team.",
            singleLine = false,
            modifier = Modifier.fillMaxWidth(),
        )
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Business profile
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The mock's Business Profile card, with the web panel's field list: name,
 * email, phone, address and, since mark 16 of the 2026-08-17 walk, the weather
 * area. Its own Save, separate from the hero's, as the mock draws.
 *
 * A local draft over [settings], reset whenever the loaded copy changes, so a
 * save that fails leaves the typed values on screen. The save itself is the
 * view model's diff-and-save: only the fields that changed reach Firestore.
 */
@Composable
internal fun BusinessProfilePanel(
    settings: BusinessSettings,
    onSave: (BusinessSettings) -> Unit,
) {
    val dims = AuntieTheme.dims
    var name by remember(settings.businessName) { mutableStateOf(settings.businessName) }
    var email by remember(settings.businessEmail) { mutableStateOf(settings.businessEmail) }
    var phone by remember(settings.businessPhone) { mutableStateOf(settings.businessPhone) }
    var address by remember(settings.businessAddress) { mutableStateOf(settings.businessAddress) }
    var weather by remember(settings.weatherLocation) { mutableStateOf(settings.weatherLocation) }
    val dirty = name != settings.businessName ||
        email != settings.businessEmail ||
        phone != settings.businessPhone ||
        address != settings.businessAddress ||
        weather != settings.weatherLocation

    DenPanel(title = "Business profile", subtitle = "Identity used on invoices, emails, and KinTales.") {
        Column(verticalArrangement = Arrangement.spacedBy(dims.space3)) {
            BottomBorderField(value = name, onValueChange = { name = it }, label = "Business name", modifier = Modifier.fillMaxWidth())
            BottomBorderField(value = email, onValueChange = { email = it }, label = "Email", modifier = Modifier.fillMaxWidth())
            BottomBorderField(value = phone, onValueChange = { phone = it }, label = "Phone", modifier = Modifier.fillMaxWidth())
            BottomBorderField(value = address, onValueChange = { address = it }, label = "Address", modifier = Modifier.fillMaxWidth())
            BottomBorderField(
                value = weather,
                onValueChange = { weather = it },
                label = "Weather area",
                placeholder = "Austin, TX",
                modifier = Modifier.fillMaxWidth(),
            )
            Spacer(Modifier.height(dims.space1))
            PrimaryButton(
                label = "Save",
                enabled = dirty,
                onClick = {
                    onSave(
                        settings.copy(
                            businessName = name.trim(),
                            businessEmail = email.trim(),
                            businessPhone = phone.trim(),
                            businessAddress = address.trim(),
                            weatherLocation = weather.trim(),
                        ),
                    )
                },
            )
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Notifications
// ─────────────────────────────────────────────────────────────────────────────

internal data class ChannelRow(val channel: String, val title: String, val detail: String, val icon: ImageVector)

/** The mock's three `.trow`s, in the web `CHANNEL_ROWS` words. */
internal val ACCOUNT_CHANNEL_ROWS = listOf(
    ChannelRow("email", "Email notifications", "Receipts, alerts, and daily summaries by email.", Lucide.Mail),
    ChannelRow("sms", "SMS notifications", "Text pings for time-sensitive booking changes.", Lucide.Smartphone),
    ChannelRow("push", "Push notifications", "In-app and device push for live session updates.", Lucide.Bell),
)

/**
 * Three switches, one per channel, over the SAME store the full My
 * Notifications screen edits (`staff/{uid}.notificationPrefs`, read and
 * written by the same two callables). That store has no global per-channel
 * bit, so each switch stands for every notification the operator may decide on
 * that channel: ON when at least one would reach them there, and flipping it
 * writes every editable row. `AccountChannelSwitch.kt` holds that rule and
 * its tests.
 *
 * Instant save, no draft: the loaded prefs drive `checked`, so a save that
 * fails leaves the switch exactly where it was with a banner saying why,
 * rather than showing a flip that never persisted.
 *
 * The link to the full page stays. This panel cannot express "email for
 * invoices, not for reminders", and the page that can is one tap away.
 */
@Composable
internal fun NotificationChannelsPanel(onOpenNotifications: () -> Unit) {
    val c = AuntieTheme.colors
    val dims = AuntieTheme.dims
    val repo = remember { AuntieOSApp.instance.repository }
    val scope = rememberCoroutineScope()

    var matrix by remember { mutableStateOf<NotificationMatrix?>(null) }
    var prefs by remember { mutableStateOf<AdminNotificationPrefs?>(null) }
    var loading by remember { mutableStateOf(true) }
    var loadError by remember { mutableStateOf<String?>(null) }
    var saveError by remember { mutableStateOf<String?>(null) }
    var busyChannel by remember { mutableStateOf<String?>(null) }

    LaunchedEffect(Unit) {
        loading = true
        loadError = null
        repo.getBusinessNotificationOverrides()
            .onSuccess { matrix = it }
            .onFailure { loadError = it.message ?: "Couldn't load the notification gate" }
        repo.getMyAdminNotificationPrefs()
            .onSuccess { prefs = it }
            .onFailure {
                val msg = it.message ?: "Couldn't load your preferences"
                loadError = if (loadError == null) msg else "$loadError  $msg"
            }
        loading = false
    }

    DenPanel(
        title = "Notifications",
        subtitle = "Each switch covers every notification on that channel. Pick them one by one on the full page.",
    ) {
        Column {
            saveError?.let {
                AuntieBanner(tone = AuntieBannerTone.Error, title = "Couldn't save that change", icon = Lucide.TriangleAlert) {
                    Text(it, style = AuntieTheme.typography.bodySmall, color = c.textDim)
                }
                Spacer(Modifier.height(dims.space3))
            }
            val m = matrix
            val p = prefs
            when {
                loading -> LoadingHint("Loading notification settings…")
                loadError != null || m == null || p == null -> {
                    AuntieBanner(tone = AuntieBannerTone.Error, title = "Couldn't load notification settings", icon = Lucide.TriangleAlert) {
                        Text(loadError ?: "Couldn't load notification settings", style = AuntieTheme.typography.bodySmall, color = c.textDim)
                    }
                }
                else -> {
                    val scopes: List<ChannelSwitchScope> = remember(m) { m.accountChannelScopes() }
                    ACCOUNT_CHANNEL_ROWS.forEachIndexed { i, row ->
                        val count = m.channelMasterCount(scopes, row.channel)
                        val on = p.channelMasterOn(m, scopes, row.channel)
                        AuntieSettingRow(
                            title = row.title,
                            description = if (count == 0) {
                                "${row.detail} Your business offers no notification on this channel right now."
                            } else {
                                row.detail
                            },
                            leadingIcon = row.icon,
                            showDivider = i < ACCOUNT_CHANNEL_ROWS.size - 1,
                        ) {
                            AuntieToggle(
                                checked = on,
                                enabled = count > 0 && busyChannel == null,
                                onCheckedChange = { next ->
                                    if (busyChannel != null) return@AuntieToggle
                                    busyChannel = row.channel
                                    saveError = null
                                    val updated = p.applyChannelToggle(m, scopes, row.channel, next)
                                    scope.launch {
                                        repo.saveMyAdminNotificationPrefs(updated)
                                            .onSuccess { prefs = updated }
                                            .onFailure { saveError = it.message ?: "Save failed." }
                                        busyChannel = null
                                    }
                                },
                            )
                        }
                    }
                }
            }
            Spacer(Modifier.height(dims.space3))
            GhostButton(label = "Open my notification settings", onClick = onOpenNotifications)
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Security
// ─────────────────────────────────────────────────────────────────────────────

/** The mock's two `.secrow`s (reset link, sign out), then the login email form (kept, see the screen header). */
@Composable
internal fun SecurityPanel(
    email: String,
    isSending: Boolean,
    busy: Boolean,
    message: String?,
    onSendReset: () -> Unit,
    onChangeEmail: (currentPassword: String, newEmail: String) -> Unit,
) {
    val c = AuntieTheme.colors
    val dims = AuntieTheme.dims
    val repo = remember { AuntieOSApp.instance.repository }
    val scope = rememberCoroutineScope()
    var newEmail by remember { mutableStateOf("") }
    var emailPw by remember { mutableStateOf("") }
    var signingOut by remember { mutableStateOf(false) }
    var signOutError by remember { mutableStateOf<String?>(null) }
    val canReset = !isSending && isPlausibleEmail(email)

    DenPanel(title = "Security", subtitle = "Your password, this session, and the address you sign in with.") {
        Column(verticalArrangement = Arrangement.spacedBy(dims.space2)) {
            message?.let {
                Text(it, style = AuntieTheme.typography.bodySmall, color = c.success)
            }

            // "Change password" in the mock's words: a reset link to the account
            // email, not a form. Disabled when Auth holds no usable address,
            // because there is nowhere to send the link.
            AuntieSettingRow(
                title = "Change password",
                description = if (isPlausibleEmail(email)) {
                    "A password reset link goes to $email."
                } else {
                    "No login email is on file, so there is nowhere to send a reset link."
                },
                leadingIcon = Lucide.Lock,
            ) {
                GhostButton(
                    label = if (isSending) "Sending…" else "Send reset email",
                    onClick = onSendReset,
                    enabled = canReset,
                )
            }
            // Ends THIS session on THIS device, the same `signOut` the admin gate
            // offers. The auth listener routes back to the sign-in screen.
            AuntieSettingRow(
                title = "Sign out",
                description = signOutError ?: "End this session on this device.",
                leadingIcon = Lucide.LogOut,
                showDivider = false,
            ) {
                GhostButton(
                    label = if (signingOut) "Signing out…" else "Sign out",
                    enabled = !signingOut,
                    onClick = {
                        signingOut = true
                        signOutError = null
                        scope.launch {
                            repo.signOut().onFailure {
                                signOutError = "Couldn't sign you out: ${it.message ?: "unknown error"}"
                            }
                            signingOut = false
                        }
                    },
                )
            }

            Spacer(Modifier.height(dims.space3))
            // Login email (15.4): editable via verify-before-update. Kept although
            // the mock does not draw it: no other surface offers it.
            Text("Login email", style = AuntieTheme.typography.titleMedium, color = c.textPrimary)
            Text(
                "Signed in as ${email.ifBlank { "(no address on file)" }}. This is your account login, not your business contact email.",
                style = AuntieTheme.typography.bodySmall, color = c.textDim,
            )
            AuntieField(value = newEmail, onValueChange = { newEmail = it }, label = "New login email", modifier = Modifier.fillMaxWidth())
            AuntiePasswordField(value = emailPw, onValueChange = { emailPw = it }, label = "Current password", modifier = Modifier.fillMaxWidth())
            PrimaryButton(
                label = if (busy) "Sending..." else "Send verification link",
                enabled = !busy && isPlausibleEmail(newEmail) && emailPw.isNotBlank(),
                onClick = { onChangeEmail(emailPw, newEmail.trim()); emailPw = "" },
                modifier = Modifier.fillMaxWidth(),
            )
        }
    }
}
