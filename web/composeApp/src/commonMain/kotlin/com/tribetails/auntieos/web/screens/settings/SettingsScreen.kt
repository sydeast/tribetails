package com.tribetails.auntieos.web.screens.settings

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.unit.dp
import com.composables.icons.lucide.Bell
import com.composables.icons.lucide.Building2
import com.composables.icons.lucide.CalendarClock
import com.composables.icons.lucide.Camera
import com.composables.icons.lucide.Heart
import com.composables.icons.lucide.LayoutGrid
import com.composables.icons.lucide.PawPrint
import com.composables.icons.lucide.LogOut
import com.composables.icons.lucide.Lock
import com.composables.icons.lucide.LockOpen
import com.composables.icons.lucide.Lucide
import com.composables.icons.lucide.Pencil
import com.composables.icons.lucide.Users
import com.composables.icons.lucide.Trash2
import com.composables.icons.lucide.MapPin
import com.composables.icons.lucide.ExternalLink
import com.tribetails.auntieos.web.ui.components.AuntieIconButton
import com.tribetails.auntieos.web.platform.launchUri
import com.composables.icons.lucide.Menu
import com.composables.icons.lucide.Moon
import com.composables.icons.lucide.Palette
import com.composables.icons.lucide.Plane
import com.composables.icons.lucide.ShieldCheck
import com.composables.icons.lucide.SlidersHorizontal
import com.composables.icons.lucide.Sparkles
import com.composables.icons.lucide.Stethoscope
import com.composables.icons.lucide.Wallet
import com.composables.icons.lucide.Sun
import com.composables.icons.lucide.User
import com.tribetails.auntieos.web.config.LocalFeatureFlags
import com.tribetails.auntieos.web.data.AuditLog
import com.tribetails.auntieos.web.data.AuthClient
import com.tribetails.auntieos.web.data.AuthOpResult
import com.tribetails.auntieos.web.ui.components.AuntiePasswordField
import com.tribetails.auntieos.web.data.VetClinic
import com.tribetails.auntieos.web.data.AuthUser
import com.tribetails.auntieos.web.data.BusinessSettings
import com.tribetails.auntieos.web.branding.DEFAULT_BRAND_TAGLINE
import com.tribetails.auntieos.web.branding.DEFAULT_BRAND_WORDMARK
import com.tribetails.auntieos.web.branding.DEFAULT_HOME_ACCENT_TAIL
import com.tribetails.auntieos.web.branding.brandingDirty
import com.tribetails.auntieos.web.branding.withBranding
import com.tribetails.auntieos.web.data.CloudNotificationOverridesRepository
import com.tribetails.auntieos.web.data.FirestoreClient
import com.tribetails.auntieos.web.data.FirestoreResult
import com.tribetails.auntieos.web.data.NotificationCatalogEntry
import com.tribetails.auntieos.web.data.NotifAudience
import com.tribetails.auntieos.web.data.alwaysEnabledFor
import com.tribetails.auntieos.web.data.displayTitle
import com.tribetails.auntieos.web.data.notifAudiences
import com.tribetails.auntieos.web.data.sectionedNotifications
import com.tribetails.auntieos.web.data.sharedCopyCaption
import com.tribetails.auntieos.web.data.lockReasonFor
import com.tribetails.auntieos.web.data.streamEffectiveChannel
import com.tribetails.auntieos.web.data.streamEffectiveChannelLocked
import com.tribetails.auntieos.web.data.streamEffectiveEnabled
import com.tribetails.auntieos.web.data.streamEffectiveLockedEnabled
import com.tribetails.auntieos.web.data.toggledStreamChannelLock
import com.tribetails.auntieos.web.data.toggledStreamEnabledLock
import com.tribetails.auntieos.web.data.withStreamGate
import com.tribetails.auntieos.web.data.NotificationMatrix
import com.tribetails.auntieos.web.data.NotificationOverride
import com.tribetails.auntieos.web.data.UserProfile
import com.tribetails.auntieos.web.data.WriteResult
import com.tribetails.auntieos.web.theme.AccentChoice
import com.tribetails.auntieos.web.theme.AuntieTheme
import com.tribetails.auntieos.web.theme.AuntieThemePreset
import com.tribetails.auntieos.web.theme.swatch
import com.tribetails.auntieos.web.ui.shell.NavigationPanel
import com.tribetails.auntieos.web.theme.DensityChoice
import com.tribetails.auntieos.web.theme.FontScaleChoice
import com.tribetails.auntieos.web.theme.ThemeMode
import com.tribetails.auntieos.web.theme.ThemePersonalization
import com.tribetails.auntieos.web.data.Kinfolk
import com.tribetails.auntieos.web.ui.components.AuntieAvatar
import com.tribetails.auntieos.web.ui.components.AuntieBanner
import com.tribetails.auntieos.web.ui.components.AuntieBannerTone
import com.tribetails.auntieos.web.ui.components.AuntieDialog
import com.tribetails.auntieos.web.ui.components.AuntieIconTile
import com.tribetails.auntieos.web.ui.components.AuntieSaveBar
import com.tribetails.auntieos.web.ui.components.AuntieSettingRow
import com.tribetails.auntieos.web.ui.components.AuntieStatusPill
import com.tribetails.auntieos.web.ui.components.AuntieStatusTone
import com.tribetails.auntieos.web.ui.components.AuntieToggle
import com.tribetails.auntieos.web.ui.components.BottomBorderField
import com.tribetails.auntieos.web.ui.components.DenPanel
import com.tribetails.auntieos.web.ui.components.DenScreenHeading
import com.tribetails.auntieos.web.ui.components.GhostButton
import com.tribetails.auntieos.web.ui.components.GlassSurface
import com.tribetails.auntieos.web.ui.components.MultilineField
import com.tribetails.auntieos.web.ui.components.PrimaryButton
import com.tribetails.auntieos.web.ui.components.ScreenScaffold
import com.tribetails.auntieos.web.ui.components.SegmentedPicker
import com.tribetails.auntieos.web.ui.components.StatusToast
import com.tribetails.auntieos.web.ui.components.ThemeSwatchCard
import com.tribetails.auntieos.web.ui.components.ToastKind
import kotlinx.coroutines.launch

/**
 * Settings, rebuilt in the Den aesthetic.
 *
 * The screen owns the full operator settings set (Profile, Business Profile,
 * Business Hours, Notifications, Integrations, Scheduling, Appearance, Security,
 * Time Off, Dynamic Fields). The section nav is a real single-panel switch:
 * clicking a nav item changes [SettingsSection] and the right column renders only
 * that section. The mockup's Integrations-only card concept is folded in as one
 * of those sections.
 *
 * Fail-loud notes:
 *  - Profile-picture upload ships dark (flags.settingsProfilePicUpload): no file picker
 *    exists, so the control stays disabled with a Not-wired banner instead of
 *    silently uploading an empty file.
 *  - Integration "status" pills reflect STATIC config in source, not a live health
 *    check, so they are labelled accordingly (no fake "Connected" glow).
 *  - The Google Calendar sync is server-backed (syncGoogleCalendarBusyEvents); the
 *    extra scheduling toggles below it have no backend yet and stay read-only.
 *  - Save buttons disable until the business_settings doc has loaded.
 */
@Composable
fun SettingsScreen(
    authUser: AuthUser,
    auth: AuthClient,
    themeMode: ThemeMode,
    onThemeModeChange: (ThemeMode) -> Unit,
    personalization: ThemePersonalization,
    onPersonalizationChange: (ThemePersonalization) -> Unit,
) {
    val dims = AuntieTheme.dims
    val scope = rememberCoroutineScope()
    var signingOut by remember { mutableStateOf(false) }

    val client = remember { FirestoreClient() }
    val dataSource = remember { FirestoreClientSettingsDataSource(client) }
    val vm = remember { SettingsViewModel(dataSource) }
    val uiState by vm.uiState.collectAsState()

    val settingsData = (uiState.settingsResult as? FirestoreResult.Data<BusinessSettings>)?.value
    val settingsLoaded = settingsData != null

    var selectedSection by remember { mutableStateOf(SettingsSection.BusinessProfile) }

    val daysOfWeek = listOf("Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday")

    var businessName    by remember(settingsData) { mutableStateOf(settingsData?.businessName ?: "") }
    var businessEmail   by remember(settingsData) { mutableStateOf(settingsData?.businessEmail ?: "") }
    var businessPhone   by remember(settingsData) { mutableStateOf(settingsData?.businessPhone ?: "") }
    var businessAddress by remember(settingsData) { mutableStateOf(settingsData?.businessAddress ?: "") }
    var businessHours   by remember(settingsData) {
        mutableStateOf(settingsData?.businessHours ?: emptyMap())
    }
    var observedHolidays by remember(settingsData) {
        mutableStateOf<Set<String>>(settingsData?.observedUsHolidays?.toSet() ?: emptySet())
    }
    var companyHolidays by remember(settingsData) {
        mutableStateOf<List<String>>(settingsData?.companyHolidays ?: emptyList())
    }
    var newHolidayDate by remember { mutableStateOf("") }
    var newHolidayName by remember { mutableStateOf("") }

    // ---- Admin / Auntie profile ----
    val profileResult by remember(authUser.uid) { client.userProfileStream(authUser.uid) }.collectAsState(initial = FirestoreResult.Loading)
    val profileLoaded = (profileResult as? FirestoreResult.Data)?.value
    var displayName by remember(profileLoaded) { mutableStateOf(profileLoaded?.displayName ?: "") }
    var firstName   by remember(profileLoaded) { mutableStateOf(profileLoaded?.firstName ?: "") }
    var lastName    by remember(profileLoaded) { mutableStateOf(profileLoaded?.lastName  ?: "") }
    var profilePhone by remember(profileLoaded) { mutableStateOf(profileLoaded?.phone    ?: "") }
    var profileTitle by remember(profileLoaded) { mutableStateOf(profileLoaded?.title    ?: "") }
    var profileBio   by remember(profileLoaded) { mutableStateOf(profileLoaded?.bio      ?: "") }
    var photoUrl     by remember(profileLoaded) { mutableStateOf(profileLoaded?.photoUrl ?: "") }
    var savingProfile by remember { mutableStateOf(false) }
    var profileToast by remember { mutableStateOf<Pair<String, ToastKind>?>(null) }

    // ---- 0A: theme + hours/notifications persistence ----
    var themeError by remember { mutableStateOf<String?>(null) }
    var pendingSection by remember { mutableStateOf<SettingsSection?>(null) }

    // Business-hours edits back a dedicated Save bar on the Business-hours panel.
    val hoursDirty = settingsData != null &&
        businessSettingsDirty(settingsData, businessHours)

    // NOTE: theme + personalization REHYDRATION is hoisted to the app shell
    // (SignedInApp in App.kt). It used to run here, which meant opening Settings
    // was the only thing that synced the saved theme, flipping the whole app
    // dark->light on that navigation (prod 2026-06-08). Settings only PERSISTS
    // changes now (persistTheme / persistAppearance below).

    // Theme change: update the live app theme AND persist to UserProfile. Fail loud
    // if the profile has not loaded yet (saving a fresh doc would clobber the
    // operator's other fields, so we surface the wait instead of silently dropping).
    val persistTheme: (ThemeMode) -> Unit = { mode ->
        val p = profileLoaded
        if (p == null) {
            themeError = "Still loading your profile, your theme change was not saved. Try again in a moment."
        } else {
            onThemeModeChange(mode)
            scope.launch {
                when (val r = client.saveUserProfile(p.withTheme(mode))) {
                    is WriteResult.Err -> themeError = "Theme not saved: ${r.message}"
                    is WriteResult.Ok  -> themeError = null
                }
            }
        }
    }

    // ---- 17.1 personalization (accent / density / font scale) ----
    // #10 (2026-06-08): the knobs now apply LIVE for instant preview but persist
    // ONLY via an explicit Save button. Previously every knob auto-saved to the
    // cloud; a silent write failure looked like "the color does not save". Now the
    // operator picks (sees it immediately), then Save commits with a toast, and an
    // error is surfaced fail-loud. Discard reverts to the saved profile value.
    var appearanceError by remember { mutableStateOf<String?>(null) }
    var savingAppearance by remember { mutableStateOf(false) }

    // Read the LIVE personalization inside the knob callbacks (not a stale closure),
    // so two quick changes both build on the latest state.
    val livePersonalization by rememberUpdatedState(personalization)
    val appearanceSaveMutex = remember { Mutex() }

    // Saved baseline = the operator's last-persisted personalization (or shipped
    // default until the profile loads). Dirty when the live selection differs.
    val savedPersonalization = hydratedPersonalization(profileLoaded)
    val appearanceDirty = personalization != savedPersonalization

    // Knob change: apply live for preview only. No cloud write here.
    val previewAppearance: (ThemePersonalization) -> Unit = { next ->
        appearanceError = null
        onPersonalizationChange(next)
    }

    // Explicit Save: persist the current live personalization. Writes all three
    // knobs onto the loaded profile (saveUserProfile overwrites the doc, so a
    // partial write would clobber the others). Fail loud when the profile has not
    // loaded yet (a fresh-doc save would drop the operator's other fields).
    val saveAppearance: () -> Unit = {
        val p = profileLoaded
        if (p == null) {
            appearanceError = "Still loading your profile, your change was not saved. Try again in a moment."
        } else if (!savingAppearance) {
            savingAppearance = true
            val snapshot = personalization
            scope.launch {
                appearanceSaveMutex.withLock {
                    val merged = p.withAccent(snapshot.accent).withDensity(snapshot.density)
                        .withFontScale(snapshot.fontScale).withThemePreset(snapshot.themePreset)
                    when (val r = client.saveUserProfile(merged)) {
                        is WriteResult.Err -> appearanceError = "Appearance not saved: ${r.message}"
                        is WriteResult.Ok  -> appearanceError = null
                    }
                    savingAppearance = false
                }
            }
        }
    }

    // Discard: revert the live preview back to the saved profile value.
    val discardAppearance: () -> Unit = {
        appearanceError = null
        onPersonalizationChange(savedPersonalization)
    }

    val appearanceControls = AppearanceControls(
        personalization = personalization,
        onAccent    = { a -> previewAppearance(livePersonalization.copy(accent = a)) },
        onDensity   = { d -> previewAppearance(livePersonalization.copy(density = d)) },
        onFontScale = { s -> previewAppearance(livePersonalization.copy(fontScale = s)) },
        onThemePreset = { p -> previewAppearance(livePersonalization.copy(themePreset = p)) },
        error = appearanceError,
        dirty = appearanceDirty,
        saving = savingAppearance,
        onSave = saveAppearance,
        onDiscard = discardAppearance,
    )

    val onSaveHours: () -> Unit = {
        settingsData?.let { base ->
            scope.launch { vm.saveSettings(editedBusinessSettings(base, businessHours)) }
        }
    }
    val onCancelHours: () -> Unit = {
        settingsData?.let { base ->
            businessHours = base.businessHours
        }
    }
    // Guard section changes that would silently drop unsaved business-hours edits.
    val requestSection: (SettingsSection) -> Unit = { target ->
        if (hoursDirty && target != selectedSection) pendingSection = target
        else selectedSection = target
    }

    ScreenScaffold {
        DenScreenHeading(
            kicker     = "The Den · Settings",
            title      = "How the Den",
            accentTail = "runs.",
            subtitle   = "Pick a section on the left to edit your profile, business details, hours, notifications and more.",
        )
        Spacer(Modifier.height(dims.space5))

        // ── Two-column: section nav (real switch) + the selected panel ─────────
        BoxWithConstraints(modifier = Modifier.fillMaxWidth()) {
            val twoCol = maxWidth >= 820.dp

            if (twoCol) {
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(dims.space5),
                    verticalAlignment = Alignment.Top,
                ) {
                    Box(modifier = Modifier.width(220.dp)) {
                        SectionNav(selected = selectedSection, onSelect = requestSection)
                    }
                    Column(modifier = Modifier.weight(1f)) {
                        SectionPanel(
                            section = selectedSection,
                            authUser = authUser,
                            auth = auth,
                            client = client,
                            vm = vm,
                            uiState = uiState,
                            settingsData = settingsData,
                            settingsLoaded = settingsLoaded,
                            scope = scope,
                            themeMode = themeMode,
                            onThemeModeChange = persistTheme,
                            themeError = themeError,
                            appearance = appearanceControls,
                            hoursDirty = hoursDirty,
                            onSaveHours = onSaveHours,
                            onCancelHours = onCancelHours,
                            hoursSaveError = uiState.saveError,
                            daysOfWeek = daysOfWeek,
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
                            businessName = businessName, onBusinessName = { businessName = it },
                            businessEmail = businessEmail, onBusinessEmail = { businessEmail = it },
                            businessPhone = businessPhone, onBusinessPhone = { businessPhone = it },
                            businessAddress = businessAddress, onBusinessAddress = { businessAddress = it },
                            businessHours = businessHours, onBusinessHours = { businessHours = it },
                            observedHolidays = observedHolidays, onObservedHolidays = { observedHolidays = it },
                            companyHolidays = companyHolidays, onCompanyHolidays = { companyHolidays = it },
                            newHolidayDate = newHolidayDate, onNewHolidayDate = { newHolidayDate = it },
                            newHolidayName = newHolidayName, onNewHolidayName = { newHolidayName = it },
                        )
                    }
                }
            } else {
                Column(verticalArrangement = Arrangement.spacedBy(dims.space5)) {
                    SectionNav(selected = selectedSection, onSelect = requestSection)
                    SectionPanel(
                        section = selectedSection,
                        authUser = authUser,
                        auth = auth,
                        client = client,
                        vm = vm,
                        uiState = uiState,
                        settingsData = settingsData,
                        settingsLoaded = settingsLoaded,
                        scope = scope,
                        themeMode = themeMode,
                        onThemeModeChange = persistTheme,
                        themeError = themeError,
                        appearance = appearanceControls,
                        hoursDirty = hoursDirty,
                        onSaveHours = onSaveHours,
                        onCancelHours = onCancelHours,
                        hoursSaveError = uiState.saveError,
                        daysOfWeek = daysOfWeek,
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
                        businessName = businessName, onBusinessName = { businessName = it },
                        businessEmail = businessEmail, onBusinessEmail = { businessEmail = it },
                        businessPhone = businessPhone, onBusinessPhone = { businessPhone = it },
                        businessAddress = businessAddress, onBusinessAddress = { businessAddress = it },
                        businessHours = businessHours, onBusinessHours = { businessHours = it },
                        observedHolidays = observedHolidays, onObservedHolidays = { observedHolidays = it },
                        companyHolidays = companyHolidays, onCompanyHolidays = { companyHolidays = it },
                        newHolidayDate = newHolidayDate, onNewHolidayDate = { newHolidayDate = it },
                        newHolidayName = newHolidayName, onNewHolidayName = { newHolidayName = it },
                    )
                }
            }
        }

        StatusToast(
            visible  = uiState.saveSuccess,
            message  = "Settings saved",
            kind     = ToastKind.Success,
            onDismiss = { vm.clearSaveSuccess() },
        )

        uiState.saveError?.let { err ->
            StatusToast(
                visible  = true,
                message  = err,
                kind     = ToastKind.Error,
                onDismiss = { vm.clearSaveError() },
            )
        }

        // Unsaved-changes guard: leaving Business hours with pending edits must not
        // silently drop them (fail loud, never silent loss).
        AuntieDialog(
            visible = pendingSection != null,
            title = "Discard unsaved changes?",
            onDismiss = { pendingSection = null },
            hint = "Your edits to your business hours have not been saved yet.",
            footer = {
                GhostButton(label = "Keep editing", onClick = { pendingSection = null })
                PrimaryButton(
                    label = "Discard changes",
                    onClick = {
                        onCancelHours()
                        pendingSection?.let { selectedSection = it }
                        pendingSection = null
                    },
                )
            },
        ) {
            Text(
                "Switching sections will revert your business hours to their last saved values.",
                style = AuntieTheme.typography.bodyMedium,
                color = AuntieTheme.colors.textDim,
            )
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Section model + nav
// ─────────────────────────────────────────────────────────────────────────────

private enum class SettingsSection(val label: String, val icon: ImageVector) {
    BusinessProfile("Business profile", Lucide.Building2),
    BusinessHours("Business hours", Lucide.CalendarClock),
    Notifications("Notifications", Lucide.Bell),
    Integrations("Integrations", Lucide.LayoutGrid),
    KinCareTypes("Booking", Lucide.SlidersHorizontal),
    Payments("Payments", Lucide.Wallet),
    VetClinics("Vet clinics", Lucide.Stethoscope),
    Appearance("Appearance", Lucide.Palette),
    Branding("Branding", Lucide.Sparkles),
    MyTribe("MyTribe", Lucide.Heart),
    Navigation("Navigation", Lucide.Menu),
    // 1C: legacy "Dynamic fields" retired. Custom fields are now authored via the
    // FormSchema editor (form_schemas is the single field-authoring system).
}

@Composable
private fun SectionNav(
    selected: SettingsSection,
    onSelect: (SettingsSection) -> Unit,
) {
    val c = AuntieTheme.colors
    val dims = AuntieTheme.dims
    GlassSurface(cornerRadius = 18.dp, modifier = Modifier.fillMaxWidth()) {
        Column(modifier = Modifier.padding(dims.space2), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            SettingsSection.entries.forEach { item ->
                val active = item == selected
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .clip(RoundedCornerShape(11.dp))
                        .then(if (active) Modifier.background(c.textPrimary) else Modifier)
                        .clickable(
                            interactionSource = remember { MutableInteractionSource() },
                            indication = null,
                        ) { onSelect(item) }
                        .padding(horizontal = dims.space3, vertical = dims.space3),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(dims.space3),
                ) {
                    Icon(
                        imageVector = item.icon,
                        contentDescription = null,
                        tint = if (active) c.background else c.textDim,
                        modifier = Modifier.size(17.dp),
                    )
                    Text(
                        text  = item.label,
                        style = AuntieTheme.typography.titleSmall,
                        color = if (active) c.background else c.textDim,
                    )
                }
            }
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// The single selected panel. Renders only the section the nav points at.
// ─────────────────────────────────────────────────────────────────────────────

@Composable
private fun SectionPanel(
    section: SettingsSection,
    authUser: AuthUser,
    auth: AuthClient,
    client: FirestoreClient,
    vm: SettingsViewModel,
    uiState: SettingsUiState,
    settingsData: BusinessSettings?,
    settingsLoaded: Boolean,
    scope: kotlinx.coroutines.CoroutineScope,
    themeMode: ThemeMode,
    onThemeModeChange: (ThemeMode) -> Unit,
    themeError: String?,
    appearance: AppearanceControls,
    hoursDirty: Boolean,
    onSaveHours: () -> Unit,
    onCancelHours: () -> Unit,
    hoursSaveError: String?,
    daysOfWeek: List<String>,
    displayName: String, onDisplayName: (String) -> Unit,
    firstName: String, onFirstName: (String) -> Unit,
    lastName: String, onLastName: (String) -> Unit,
    profilePhone: String, onProfilePhone: (String) -> Unit,
    profileTitle: String, onProfileTitle: (String) -> Unit,
    profileBio: String, onProfileBio: (String) -> Unit,
    photoUrl: String, onPhotoUrl: (String) -> Unit,
    profileLoaded: UserProfile?,
    savingProfile: Boolean, onSavingProfile: (Boolean) -> Unit,
    profileToast: Pair<String, ToastKind>?, onProfileToast: (Pair<String, ToastKind>?) -> Unit,
    signingOut: Boolean, onSigningOut: (Boolean) -> Unit,
    businessName: String, onBusinessName: (String) -> Unit,
    businessEmail: String, onBusinessEmail: (String) -> Unit,
    businessPhone: String, onBusinessPhone: (String) -> Unit,
    businessAddress: String, onBusinessAddress: (String) -> Unit,
    businessHours: Map<String, String>, onBusinessHours: (Map<String, String>) -> Unit,
    observedHolidays: Set<String>, onObservedHolidays: (Set<String>) -> Unit,
    companyHolidays: List<String>, onCompanyHolidays: (List<String>) -> Unit,
    newHolidayDate: String, onNewHolidayDate: (String) -> Unit,
    newHolidayName: String, onNewHolidayName: (String) -> Unit,
) {
    when (section) {
        SettingsSection.BusinessProfile -> Column(verticalArrangement = Arrangement.spacedBy(16.dp)) {
            BusinessProfilePanel(
                authUser = authUser, client = client, vm = vm, uiState = uiState,
                settingsData = settingsData, settingsLoaded = settingsLoaded, scope = scope,
                businessName = businessName, onBusinessName = onBusinessName,
                businessEmail = businessEmail, onBusinessEmail = onBusinessEmail,
                businessPhone = businessPhone, onBusinessPhone = onBusinessPhone,
                businessAddress = businessAddress, onBusinessAddress = onBusinessAddress,
                businessHours = businessHours,
            )
            WeatherAreaPanel(
                authUser = authUser, client = client, vm = vm, uiState = uiState,
                settingsData = settingsData, settingsLoaded = settingsLoaded, scope = scope,
            )
        }
        SettingsSection.BusinessHours -> Column(verticalArrangement = Arrangement.spacedBy(16.dp)) {
            BusinessHoursPanel(
                daysOfWeek = daysOfWeek,
                businessHours = businessHours, onBusinessHours = onBusinessHours,
                dirty = hoursDirty, onSave = onSaveHours, onCancel = onCancelHours,
                saveError = hoursSaveError,
            )
            // #7: Google Calendar sync + busy-block now live under Business Hours.
            GcalSyncPanel(
                settingsData = settingsData, settingsLoaded = settingsLoaded,
                vm = vm, scope = scope, saveError = uiState.saveError,
            )
            // #5: Time off now lives under Business Hours.
            TimeOffPanel(
                client = client, vm = vm, settingsData = settingsData, settingsLoaded = settingsLoaded, scope = scope,
                businessName = businessName, businessEmail = businessEmail,
                businessPhone = businessPhone, businessAddress = businessAddress,
                businessHours = businessHours,
                observedHolidays = observedHolidays, onObservedHolidays = onObservedHolidays,
                companyHolidays = companyHolidays, onCompanyHolidays = onCompanyHolidays,
                newHolidayDate = newHolidayDate, onNewHolidayDate = onNewHolidayDate,
                newHolidayName = newHolidayName, onNewHolidayName = onNewHolidayName,
            )
        }
        SettingsSection.Notifications -> Column(verticalArrangement = Arrangement.spacedBy(16.dp)) {
            // The per-notification gate matrix is the single source of truth for which
            // channels each notification offers. The old global pause + coarse
            // Email/SMS/Push boxes were removed; this panel persists each change itself.
            NotificationMatrixPanel()
        }
        SettingsSection.Integrations -> IntegrationsPanel(settingsResult = uiState.settingsResult)
        SettingsSection.KinCareTypes -> Column(verticalArrangement = Arrangement.spacedBy(16.dp)) {
            KinCareTypesPanel(
                settingsData = settingsData,
                settingsLoaded = settingsLoaded,
                vm = vm,
                scope = scope,
                saveError = uiState.saveError,
            )
            // #7: booking behavior (auto-confirm + snap) now lives under Booking.
            BookingBehaviorPanel(settingsData = settingsData, settingsLoaded = settingsLoaded, vm = vm)
        }
        SettingsSection.Payments -> PaymentOptionsPanel(
            authUser = authUser, client = client, vm = vm, uiState = uiState,
            settingsData = settingsData, settingsLoaded = settingsLoaded, scope = scope,
        )
        SettingsSection.VetClinics -> VetClinicsPanel(vm = vm)
        SettingsSection.Appearance -> AppearancePanel(
            themeMode = themeMode, onThemeModeChange = onThemeModeChange,
            themeError = themeError, appearance = appearance,
        )
        SettingsSection.Branding -> BrandingPanel(
            authUser = authUser,
            client = client,
            settingsData = settingsData,
            settingsLoaded = settingsLoaded,
            vm = vm,
            scope = scope,
            saveError = uiState.saveError,
        )
        SettingsSection.MyTribe -> MyTribePanel(
            authUser = authUser,
            client = client,
            vm = vm,
            settingsData = settingsData,
            settingsLoaded = settingsLoaded,
            scope = scope,
            saveError = uiState.saveError,
        )
        SettingsSection.Navigation -> NavigationPanel(authUser = authUser)
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Profile
// ─────────────────────────────────────────────────────────────────────────────

@Composable
internal fun ProfilePanel(
    authUser: AuthUser,
    auth: AuthClient,
    client: FirestoreClient,
    scope: kotlinx.coroutines.CoroutineScope,
    displayName: String, onDisplayName: (String) -> Unit,
    firstName: String, onFirstName: (String) -> Unit,
    lastName: String, onLastName: (String) -> Unit,
    profilePhone: String, onProfilePhone: (String) -> Unit,
    profileTitle: String, onProfileTitle: (String) -> Unit,
    profileBio: String, onProfileBio: (String) -> Unit,
    photoUrl: String, onPhotoUrl: (String) -> Unit,
    profileLoaded: UserProfile?,
    savingProfile: Boolean, onSavingProfile: (Boolean) -> Unit,
    profileToast: Pair<String, ToastKind>?, onProfileToast: (Pair<String, ToastKind>?) -> Unit,
    signingOut: Boolean, onSigningOut: (Boolean) -> Unit,
) {
    val c = AuntieTheme.colors
    val dims = AuntieTheme.dims
    val flags = LocalFeatureFlags.current
    // Tracks the in-flight avatar upload so the Edit-photo button shows progress
    // and cannot be double-fired. Reset on Ok or Err (fail loud, never fake).
    var uploadingAvatar by remember { mutableStateOf(false) }
    DenPanel(title = "Profile", subtitle = "Who the kinfolk see on your KinTales and replies.") {
        Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(dims.space4),
        ) {
            ProfileAvatar(
                photoUrl = photoUrl,
                initials = UserProfile(
                    displayName = displayName,
                    firstName   = firstName,
                    lastName    = lastName,
                    email       = authUser.email ?: "",
                ).initials,
            )
            Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(
                    text  = displayName.ifBlank { authUser.email ?: "Signed in" },
                    style = AuntieTheme.typography.titleLarge,
                    color = c.textPrimary,
                )
                Text(
                    text  = profileTitle.ifBlank { "Admin" },
                    style = AuntieTheme.typography.bodySmall,
                    color = c.primary,
                )
                Text(
                    text  = authUser.email ?: "No email on file",
                    style = AuntieTheme.typography.bodySmall,
                    color = c.textDim,
                )
                Text(
                    text  = "uid: ${authUser.uid.take(12)}",
                    style = AuntieTheme.typography.labelSmall,
                    color = c.textFaint,
                )
            }
        }

        Spacer(Modifier.height(dims.space3))

        // Profile-picture upload. The wasmJs/JVM upload pipeline self-picks a file,
        // uploads to Cloudinary, and writes a media_files doc; setMediaProfilePhoto
        // then stamps users/{uid}.photoUrl + flips isProfilePhoto in one atomic admin
        // batch. Two-step is fail-loud: an upload Ok followed by a stamp Err surfaces
        // "photo uploaded but profile save failed", never a fake success.
        if (flags.settingsProfilePicUpload) {
            GhostButton(
                label   = if (uploadingAvatar) "Uploading photo" else "Edit photo",
                enabled = !uploadingAvatar,
                onClick = {
                    uploadingAvatar = true
                    scope.launch {
                        when (val up = client.uploadMedia(authUser.uid, "USER", byteArrayOf(), "image/jpeg")) {
                            is WriteResult.Err -> {
                                onProfileToast("Photo upload failed: ${up.message}" to ToastKind.Error)
                                uploadingAvatar = false
                            }
                            is WriteResult.Ok -> {
                                val media = up.value
                                if (media._id.isBlank() || media.storageUrl.isBlank()) {
                                    // Cancelled picker / no asset: do not fake a success.
                                    onProfileToast("No photo selected" to ToastKind.Error)
                                    uploadingAvatar = false
                                } else when (val stamp = client.setMediaProfilePhoto(media._id, "USER", authUser.uid)) {
                                    is WriteResult.Ok -> {
                                        onPhotoUrl(media.storageUrl)
                                        AuditLog.fire(
                                            scope            = scope,
                                            client           = client,
                                            actorId          = authUser.uid,
                                            actionType       = "UPDATE_PROFILE_PHOTO",
                                            description      = "Updated profile photo",
                                            targetId         = authUser.uid,
                                            targetCollection = "users",
                                        )
                                        onProfileToast("Profile photo updated" to ToastKind.Success)
                                        uploadingAvatar = false
                                    }
                                    is WriteResult.Err -> {
                                        onProfileToast(
                                            "Photo uploaded but profile save failed: ${stamp.message}" to ToastKind.Error,
                                        )
                                        uploadingAvatar = false
                                    }
                                }
                            }
                        }
                    }
                },
            )
        } else {
            // Kill-switch OFF: photo upload is built + live by default (the if-branch
            // above); this only shows when an admin disables it. Honest disabled
            // state, not "not wired" (the pipeline exists on web + android).
            AuntieBanner(
                tone = AuntieBannerTone.Info,
                dashed = true,
                title = "Photo upload disabled",
                pillLabel = "Disabled",
                body = {
                    Text(
                        "Profile-photo upload is turned off in Feature Flags. Re-enable it to change the avatar.",
                        style = AuntieTheme.typography.bodySmall,
                        color = c.textDim,
                    )
                },
            )
        }

        Spacer(Modifier.height(dims.space4))

        Row(horizontalArrangement = Arrangement.spacedBy(dims.space3), modifier = Modifier.fillMaxWidth()) {
            BottomBorderField(
                value         = firstName,
                onValueChange = onFirstName,
                label         = "First Name",
                modifier      = Modifier.weight(1f),
            )
            BottomBorderField(
                value         = lastName,
                onValueChange = onLastName,
                label         = "Last Name",
                modifier      = Modifier.weight(1f),
            )
        }
        Spacer(Modifier.height(dims.space3))
        BottomBorderField(
            value         = displayName,
            onValueChange = onDisplayName,
            label         = "Display Name",
            modifier      = Modifier.fillMaxWidth(),
        )
        Spacer(Modifier.height(dims.space3))
        Row(horizontalArrangement = Arrangement.spacedBy(dims.space3), modifier = Modifier.fillMaxWidth()) {
            BottomBorderField(
                value         = profilePhone,
                onValueChange = onProfilePhone,
                label         = "Phone",
                modifier      = Modifier.weight(1f),
            )
            BottomBorderField(
                value         = profileTitle,
                onValueChange = onProfileTitle,
                label         = "Title / Role",
                modifier      = Modifier.weight(1f),
            )
        }
        Spacer(Modifier.height(dims.space3))
        MultilineField(
            value         = profileBio,
            onValueChange = onProfileBio,
            label         = "Bio",
            placeholder   = "A short note for your team",
            modifier      = Modifier.fillMaxWidth(),
        )

        Spacer(Modifier.height(dims.space4))

        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(dims.space2),
        ) {
            PrimaryButton(
                label   = if (savingProfile) "Saving" else "Save Profile",
                enabled = !savingProfile,
                onClick = {
                    onSavingProfile(true)
                    scope.launch {
                        val updated = (profileLoaded ?: UserProfile()).copy(
                            uid         = authUser.uid,
                            email       = authUser.email ?: profileLoaded?.email.orEmpty(),
                            displayName = displayName,
                            firstName   = firstName,
                            lastName    = lastName,
                            phone       = profilePhone,
                            title       = profileTitle,
                            photoUrl    = photoUrl,
                            bio         = profileBio,
                        )
                        onProfileToast(when (val r = client.saveUserProfile(updated)) {
                            is WriteResult.Ok  -> {
                                AuditLog.fire(
                                    scope            = scope,
                                    client           = client,
                                    actorId          = authUser.uid,
                                    actionType       = "UPDATE_PROFILE",
                                    description      = "Updated profile for ${updated.displayLabel}",
                                    targetId         = authUser.uid,
                                    targetCollection = "users",
                                )
                                "Profile saved" to ToastKind.Success
                            }
                            is WriteResult.Err -> "Save failed: ${r.message}" to ToastKind.Error
                        })
                        onSavingProfile(false)
                    }
                },
                modifier = Modifier.weight(1f),
            )
            GhostButton(
                label   = if (signingOut) "Signing out" else "Sign out",
                enabled = !signingOut,
                onClick = {
                    onSigningOut(true)
                    scope.launch { auth.signOut() }
                },
                leading = {
                    Icon(Lucide.LogOut, contentDescription = null, tint = c.textDim, modifier = Modifier.size(14.dp))
                },
            )
        }

        profileToast?.let { (msg, kind) ->
            StatusToast(visible = true, message = msg, kind = kind, onDismiss = { onProfileToast(null) })
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Business Profile
// ─────────────────────────────────────────────────────────────────────────────

@Composable
private fun BusinessProfilePanel(
    authUser: AuthUser,
    client: FirestoreClient,
    vm: SettingsViewModel,
    uiState: SettingsUiState,
    settingsData: BusinessSettings?,
    settingsLoaded: Boolean,
    scope: kotlinx.coroutines.CoroutineScope,
    businessName: String, onBusinessName: (String) -> Unit,
    businessEmail: String, onBusinessEmail: (String) -> Unit,
    businessPhone: String, onBusinessPhone: (String) -> Unit,
    businessAddress: String, onBusinessAddress: (String) -> Unit,
    businessHours: Map<String, String>,
) {
    val c = AuntieTheme.colors
    val dims = AuntieTheme.dims
    DenPanel(title = "Business Profile", subtitle = "The contact details kinfolk and invoices use.") {
        when (uiState.settingsResult) {
            is FirestoreResult.Loading -> EmptyHintLine("Loading settings", c.textDim)
            is FirestoreResult.Error ->
                EmptyHintLine("Error: ${(uiState.settingsResult as FirestoreResult.Error).message}", c.error)
            else -> {
                Column(verticalArrangement = Arrangement.spacedBy(dims.space3)) {
                    BottomBorderField(
                        value = businessName, onValueChange = onBusinessName,
                        label = "Business Name", modifier = Modifier.fillMaxWidth(),
                    )
                    BottomBorderField(
                        value = businessEmail, onValueChange = onBusinessEmail,
                        label = "Business Email", modifier = Modifier.fillMaxWidth(),
                    )
                    BottomBorderField(
                        value = businessPhone, onValueChange = onBusinessPhone,
                        label = "Business Phone", modifier = Modifier.fillMaxWidth(),
                    )
                    BottomBorderField(
                        value = businessAddress, onValueChange = onBusinessAddress,
                        label = "Business Address", modifier = Modifier.fillMaxWidth(),
                    )
                    Spacer(Modifier.height(dims.space1))
                    PrimaryButton(
                        label   = if (settingsLoaded) "Save" else "Loading settings…",
                        enabled = settingsLoaded,
                        onClick = {
                            scope.launch {
                                val updated = (settingsData ?: BusinessSettings()).copy(
                                    businessName        = businessName,
                                    businessEmail       = businessEmail,
                                    businessPhone       = businessPhone,
                                    businessAddress     = businessAddress,
                                    businessHours       = businessHours,
                                )
                                vm.saveSettings(updated)
                                AuditLog.fire(
                                    scope            = scope,
                                    client           = client,
                                    actorId          = authUser.uid,
                                    actionType       = "UPDATE_SETTINGS",
                                    description      = "Updated business settings",
                                    targetId         = updated._id,
                                    targetCollection = "business_settings",
                                )
                            }
                        },
                        modifier = Modifier.fillMaxWidth(),
                    )
                }
            }
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Payment Options (operator-entered Venmo / PayPal / Cash App handles)
// ─────────────────────────────────────────────────────────────────────────────

@Composable
private fun PaymentOptionsPanel(
    authUser: AuthUser,
    client: FirestoreClient,
    vm: SettingsViewModel,
    uiState: SettingsUiState,
    settingsData: BusinessSettings?,
    settingsLoaded: Boolean,
    scope: kotlinx.coroutines.CoroutineScope,
) {
    val c = AuntieTheme.colors
    val dims = AuntieTheme.dims
    DenPanel(
        title = "Payment Options",
        subtitle = "How kinfolk pay you. Each handle you enter prints on every invoice; leave one blank to hide it.",
    ) {
        when (uiState.settingsResult) {
            is FirestoreResult.Loading -> EmptyHintLine("Loading settings", c.textDim)
            is FirestoreResult.Error ->
                EmptyHintLine("Error: ${(uiState.settingsResult as FirestoreResult.Error).message}", c.error)
            else -> {
                // Seeded from the loaded doc; re-seed if the stream delivers fresh values.
                var venmo by remember(settingsData?.venmoHandle) { mutableStateOf(settingsData?.venmoHandle.orEmpty()) }
                var paypal by remember(settingsData?.paypalHandle) { mutableStateOf(settingsData?.paypalHandle.orEmpty()) }
                var cashapp by remember(settingsData?.cashappHandle) { mutableStateOf(settingsData?.cashappHandle.orEmpty()) }
                Column(verticalArrangement = Arrangement.spacedBy(dims.space3)) {
                    BottomBorderField(
                        value = venmo, onValueChange = { venmo = it },
                        label = "Venmo handle", placeholder = "@tribetails",
                        modifier = Modifier.fillMaxWidth(),
                    )
                    BottomBorderField(
                        value = paypal, onValueChange = { paypal = it },
                        label = "PayPal", placeholder = "you@email.com or paypal.me/tribetails",
                        modifier = Modifier.fillMaxWidth(),
                    )
                    BottomBorderField(
                        value = cashapp, onValueChange = { cashapp = it },
                        label = "Cash App", placeholder = "\$tribetails",
                        modifier = Modifier.fillMaxWidth(),
                    )
                    Spacer(Modifier.height(dims.space1))
                    PrimaryButton(
                        label   = if (settingsLoaded) "Save" else "Loading settings…",
                        enabled = settingsLoaded,
                        onClick = {
                            scope.launch {
                                val updated = (settingsData ?: BusinessSettings()).copy(
                                    venmoHandle   = venmo.trim(),
                                    paypalHandle  = paypal.trim(),
                                    cashappHandle = cashapp.trim(),
                                )
                                vm.saveSettings(updated)
                                AuditLog.fire(
                                    scope            = scope,
                                    client           = client,
                                    actorId          = authUser.uid,
                                    actionType       = "UPDATE_SETTINGS",
                                    description      = "Updated payment options",
                                    targetId         = updated._id,
                                    targetCollection = "business_settings",
                                )
                            }
                        },
                        modifier = Modifier.fillMaxWidth(),
                    )
                }
            }
        }
    }
}

/**
 * A8 W16/W17: the weather widgets' coverage area. A place NAME (city / metro / ZIP), not
 * a street address: the operator sets the area they serve (e.g. "Austin, TX") and never
 * has to expose their home/business address. Self-contained like PaymentOptionsPanel.
 */
@Composable
private fun WeatherAreaPanel(
    authUser: AuthUser,
    client: FirestoreClient,
    vm: SettingsViewModel,
    uiState: SettingsUiState,
    settingsData: BusinessSettings?,
    settingsLoaded: Boolean,
    scope: kotlinx.coroutines.CoroutineScope,
) {
    val c = AuntieTheme.colors
    val dims = AuntieTheme.dims
    DenPanel(
        title = "Weather area",
        subtitle = "Where the Home weather widgets forecast for. Enter a city, metro, or ZIP (e.g. \"Austin, TX\"), not your street address. For a metro the centre point covers the whole area.",
    ) {
        when (uiState.settingsResult) {
            is FirestoreResult.Loading -> EmptyHintLine("Loading settings", c.textDim)
            is FirestoreResult.Error ->
                EmptyHintLine("Error: ${(uiState.settingsResult as FirestoreResult.Error).message}", c.error)
            else -> {
                var area by remember(settingsData?.weatherLocation) { mutableStateOf(settingsData?.weatherLocation.orEmpty()) }
                Column(verticalArrangement = Arrangement.spacedBy(dims.space3)) {
                    BottomBorderField(
                        value = area, onValueChange = { area = it },
                        label = "City, metro, or ZIP", placeholder = "Austin, TX",
                        modifier = Modifier.fillMaxWidth(),
                    )
                    Spacer(Modifier.height(dims.space1))
                    PrimaryButton(
                        label   = if (settingsLoaded) "Save" else "Loading settings…",
                        enabled = settingsLoaded,
                        onClick = {
                            scope.launch {
                                val updated = (settingsData ?: BusinessSettings()).copy(weatherLocation = area.trim())
                                vm.saveSettings(updated)
                                AuditLog.fire(
                                    scope            = scope,
                                    client           = client,
                                    actorId          = authUser.uid,
                                    actionType       = "UPDATE_SETTINGS",
                                    description      = "Updated weather area",
                                    targetId         = updated._id,
                                    targetCollection = "business_settings",
                                )
                            }
                        },
                        modifier = Modifier.fillMaxWidth(),
                    )
                }
            }
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Business Hours
// ─────────────────────────────────────────────────────────────────────────────

@Composable
private fun BusinessHoursPanel(
    daysOfWeek: List<String>,
    businessHours: Map<String, String>,
    onBusinessHours: (Map<String, String>) -> Unit,
    dirty: Boolean,
    onSave: () -> Unit,
    onCancel: () -> Unit,
    saveError: String?,
) {
    val c = AuntieTheme.colors
    val dims = AuntieTheme.dims
    DenPanel(title = "Business hours", subtitle = "When the Den is open for visits. Use 24h ranges like 09:00-17:00, or leave blank for closed.") {
        Column(verticalArrangement = Arrangement.spacedBy(dims.space2)) {
            daysOfWeek.forEach { day ->
                val current = businessHours[day] ?: ""
                // Light validation: flag a non-empty value that does not look like a HH:MM-HH:MM range.
                val malformed = current.isNotBlank() && !HOURS_RANGE_REGEX.matches(current.trim())
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(dims.space2),
                ) {
                    Text(
                        day.take(3),
                        style = AuntieTheme.typography.labelSmall,
                        color = c.textDim,
                        modifier = Modifier.width(36.dp),
                    )
                    BottomBorderField(
                        value         = current,
                        onValueChange = { onBusinessHours(businessHours + (day to it)) },
                        label         = "",
                        placeholder   = "09:00-17:00 or leave blank if closed",
                        modifier      = Modifier.weight(1f),
                    )
                    if (malformed) {
                        AuntieStatusPill(label = "Check format", tone = AuntieStatusTone.Warning, mono = true)
                    }
                }
            }
            if (saveError != null) {
                AuntieBanner(tone = AuntieBannerTone.Error, title = "Save failed") {
                    Text(saveError, style = AuntieTheme.typography.bodySmall, color = c.textDim)
                }
            }
            AuntieSaveBar(
                dirty = dirty,
                saveEnabled = dirty,
                onCancel = onCancel,
                onSave = onSave,
                dirtyLabel = "Unsaved hours",
                savedLabel = "Hours saved",
            )
        }
    }
}

private val HOURS_RANGE_REGEX = Regex("""^\d{1,2}:\d{2}\s*-\s*\d{1,2}:\d{2}$""")

// ─────────────────────────────────────────────────────────────────────────────
// Notifications
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Phase 15.2, per-notification type × channel matrix. Self-contained: loads the
 * catalog + saved overrides via [CloudNotificationOverridesRepository], renders a
 * toggle per notification type plus a toggle per allowed channel, and persists each
 * change immediately (optimistic, reverts on failure). Catalog-required channels and
 * alwaysEnabled types render as locked toggles. Fail-loud on load/save errors.
 */
@Composable
private fun NotificationMatrixPanel() {
    val c = AuntieTheme.colors
    val scope = rememberCoroutineScope()
    val repo = remember { CloudNotificationOverridesRepository() }
    var matrix by remember { mutableStateOf<NotificationMatrix?>(null) }
    var loading by remember { mutableStateOf(true) }
    var loadError by remember { mutableStateOf<String?>(null) }
    var saveError by remember { mutableStateOf<String?>(null) }

    suspend fun reload() {
        loading = true
        when (val r = repo.getMatrix()) {
            is WriteResult.Ok -> { matrix = r.value; loadError = null }
            is WriteResult.Err -> loadError = r.message
        }
        loading = false
    }
    LaunchedEffect(Unit) { reload() }

    var selectedTab by remember { mutableStateOf(NotifAudience.Business) }

    fun persist(entry: NotificationCatalogEntry, override: NotificationOverride) {
        val m = matrix ?: return
        matrix = m.copy(overrides = m.overrides + (entry.key to override)) // optimistic
        scope.launch {
            when (val r = repo.saveOverride(entry.key, override)) {
                is WriteResult.Ok -> saveError = null
                is WriteResult.Err -> { saveError = r.message; reload() } // revert to server truth
            }
        }
    }

    // Build the full current override for an entry so a single-field edit preserves the rest.
    fun currentOverride(m: NotificationMatrix, entry: NotificationCatalogEntry): NotificationOverride =
        m.overrides[entry.key] ?: NotificationOverride(
            enabled = m.effectiveEnabled(entry.key),
            channels = entry.allowedChannels.associateWith { m.effectiveChannel(entry.key, it) },
        )

    DenPanel(
        title = "Notification gate",
        subtitle = "This is the gate. For each notification, turn a channel on to OFFER it in people's " +
            "own notification settings, Lock it to force it on, or turn it off to hide it. Locked rows " +
            "carry your reason, written right under the row. Each tab gates one audience, and a " +
            "notification can serve more than one.",
    ) {
        when {
            loading -> Text("Loading notification settings…", style = AuntieTheme.typography.bodySmall, color = c.textDim)
            loadError != null -> AuntieBanner(tone = AuntieBannerTone.Error, title = "Couldn't load notification settings") {
                Text(loadError!!, style = AuntieTheme.typography.bodySmall, color = c.textDim)
            }
            else -> {
                val m = matrix!!
                Column {
                    if (saveError != null) {
                        AuntieBanner(tone = AuntieBannerTone.Error, title = "Save failed") {
                            Text(saveError!!, style = AuntieTheme.typography.bodySmall, color = c.textDim)
                        }
                        Spacer(Modifier.height(12.dp))
                    }
                    if (m.catalog.isEmpty()) {
                        Text("No notification types in the catalog yet.", style = AuntieTheme.typography.bodySmall, color = c.textDim)
                    }

                    // #12: Flowbite-style underline tabs with icons (Business / Staff / Kinfolk).
                    NotifTabBar(catalog = m.catalog, selected = selectedTab, onSelect = { selectedTab = it })
                    Spacer(Modifier.height(6.dp))
                    // Operator pain: "I can't tell which is a business vs a kinfolk
                    // notification." Spell out what the selected audience tab governs.
                    Text(
                        notifAudienceBlurb(selectedTab),
                        style = AuntieTheme.typography.bodySmall,
                        color = c.textDim,
                        modifier = Modifier.fillMaxWidth().padding(bottom = 10.dp),
                    )

                    // #13: aligned column header. The channel cells line up with each row below.
                    NotifMatrixHeaderRow()

                    // A row shown under tab T edits streams[T] (a per-stream overlay),
                    // never the flat fields, so a shared key can gate each audience's
                    // copy independently. Display state falls back field-by-field to
                    // the flat (legacy) values until a stream is touched.
                    val stream = selectedTab.stream
                    val shown = m.catalog.filter { selectedTab in it.notifAudiences() }
                    if (shown.isEmpty()) {
                        Text("No notifications in this tab.", style = AuntieTheme.typography.bodySmall, color = c.textDim)
                    }
                    // Rows grouped by workflow section (same taxonomy as My Notifications);
                    // unmatched categories fall into a trailing "Other" (never dropped).
                    sectionedNotifications(shown, selectedTab).forEach { (section, rows) ->
                        NotifSectionHeader(section.title)
                        rows.forEach { entry ->
                            NotifMatrixRow(
                                entry = entry,
                                matrix = m,
                                audience = selectedTab,
                                onToggleEnabled = { newEnabled ->
                                    persist(entry, currentOverride(m, entry).withStreamGate(stream) { it.copy(enabled = newEnabled) })
                                },
                                onToggleChannel = { channel, newVal ->
                                    persist(
                                        entry,
                                        currentOverride(m, entry).withStreamGate(stream) {
                                            it.copy(channels = it.channels + (channel to newVal))
                                        },
                                    )
                                },
                                onToggleEnabledLock = {
                                    persist(entry, toggledStreamEnabledLock(m, entry, stream))
                                },
                                onToggleChannelLock = { channel ->
                                    persist(entry, toggledStreamChannelLock(m, entry, stream, channel))
                                },
                                onSaveLockReason = { text ->
                                    // "" is the explicit wire signal to clear the reason.
                                    persist(entry, currentOverride(m, entry).copy(lockReason = text))
                                },
                            )
                        }
                    }
                }
            }
        }
    }
}

/**
 * #12: Flowbite-style "tabs with icons". An underline tab bar: the active tab carries
 * a 2dp accent indicator that sits on the row's hairline baseline; inactive tabs are
 * muted. Each tab is icon + label + a faint count. Matches the reference the operator
 * picked, rendered in the Den palette (accent = primary).
 */
@Composable
private fun NotifTabBar(
    catalog: List<NotificationCatalogEntry>,
    selected: NotifAudience,
    onSelect: (NotifAudience) -> Unit,
) {
    val c = AuntieTheme.colors
    val baseline = c.borderSoft
    Row(
        modifier = Modifier.fillMaxWidth().drawBehind {
            val y = size.height - 1.dp.toPx() / 2
            drawLine(baseline, Offset(0f, y), Offset(size.width, y), 1.dp.toPx())
        },
    ) {
        NotifAudience.entries.sortedBy { it.order }.forEach { tab ->
            val count = catalog.count { tab in it.notifAudiences() }
            val active = tab == selected
            val tint = if (active) c.primary else c.textDim
            Column(
                horizontalAlignment = Alignment.CenterHorizontally,
                modifier = Modifier
                    .clip(RoundedCornerShape(topStart = 8.dp, topEnd = 8.dp))
                    .clickable { onSelect(tab) },
            ) {
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                    modifier = Modifier.padding(horizontal = 18.dp, vertical = 12.dp),
                ) {
                    Icon(notifTabIcon(tab), contentDescription = null, tint = tint, modifier = Modifier.size(16.dp))
                    Text(tab.title, style = AuntieTheme.typography.labelMedium, color = tint)
                    Text(
                        count.toString(),
                        style = AuntieTheme.typography.labelSmall,
                        color = if (active) c.primary.copy(alpha = 0.7f) else c.textFaint,
                    )
                }
                Box(Modifier.fillMaxWidth().height(2.dp).background(if (active) c.primary else Color.Transparent))
            }
        }
    }
}

private fun notifTabIcon(tab: NotifAudience) = when (tab) {
    NotifAudience.Business -> Lucide.Building2
    NotifAudience.Staff -> Lucide.PawPrint
    NotifAudience.Kinfolk -> Lucide.Users
}

/** Plain-language explainer of what each audience tab governs (operator clarity). */
private fun notifAudienceBlurb(tab: NotifAudience): String = when (tab) {
    NotifAudience.Business ->
        "Your owner hat: bookings, invoices, payments, security, and ratings. What the business hears."
    NotifAudience.Staff ->
        "What your Aunties see day to day: visit notes, KinTale comments, pet updates, the schedule digest."
    NotifAudience.Kinfolk ->
        "What families receive: their own confirmations, arrivals, visit reports, and receipts."
}

// #13: the four notification columns, in a fixed order so header + rows align.
private val NOTIF_CHANNEL_COLS = listOf("email", "sms", "push")
private val NOTIF_CELL_WIDTH = 64.dp

@Composable
private fun NotifMatrixHeaderRow() {
    val c = AuntieTheme.colors
    Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth().padding(vertical = 4.dp)) {
        Spacer(Modifier.weight(1f))
        listOf("On/Off", "Email", "SMS", "Push").forEach { label ->
            Text(
                label,
                style = AuntieTheme.typography.labelSmall,
                color = c.textDim,
                modifier = Modifier.width(NOTIF_CELL_WIDTH),
                textAlign = TextAlign.Center,
            )
        }
    }
}

/** Subtle workflow-section header inside the matrix: small caps title over a hairline. */
@Composable
private fun NotifSectionHeader(title: String) {
    val c = AuntieTheme.colors
    Column(Modifier.fillMaxWidth().padding(top = 14.dp)) {
        Text(title.uppercase(), style = AuntieTheme.typography.labelSmall, color = c.textFaint)
        Spacer(Modifier.height(6.dp))
        Box(Modifier.fillMaxWidth().height(1.dp).background(c.borderSoft))
    }
}

@Composable
private fun NotifMatrixRow(
    entry: NotificationCatalogEntry,
    matrix: NotificationMatrix,
    audience: NotifAudience,
    onToggleEnabled: (Boolean) -> Unit,
    onToggleChannel: (String, Boolean) -> Unit,
    onToggleEnabledLock: () -> Unit,
    onToggleChannelLock: (String) -> Unit,
    onSaveLockReason: (String) -> Unit,
) {
    val c = AuntieTheme.colors
    val stream = audience.stream
    val enabled = streamEffectiveEnabled(matrix, entry.key, stream)
    val enabledLockOn = streamEffectiveLockedEnabled(matrix, entry.key, stream)
    val anyChannelLockOn = NOTIF_CHANNEL_COLS.any { streamEffectiveChannelLocked(matrix, entry.key, stream, it) }
    Column(Modifier.fillMaxWidth().padding(vertical = 8.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth()) {
            Column(Modifier.weight(1f).padding(end = 8.dp)) {
                Text(entry.displayTitle(), style = AuntieTheme.typography.bodyMedium, color = c.textPrimary)
                // Per-stream: a key can be always-on for kinfolk yet optional here.
                if (entry.alwaysEnabledFor(stream)) {
                    Text("Always on", style = AuntieTheme.typography.labelSmall, color = c.textFaint)
                }
                // Shared key: name the other audience's copy so the operator knows
                // this row only gates the copy for the tab they are on.
                sharedCopyCaption(entry, audience)?.let { caption ->
                    Text(caption, style = AuntieTheme.typography.labelSmall, color = c.textFaint)
                }
            }
            // On/Off cell.
            NotifCell(
                on = enabled,
                show = true,
                locked = enabledLockOn,
                onToggle = { onToggleEnabled(!enabled) },
                onToggleLock = onToggleEnabledLock,
            )
            // Channel cells, in the fixed column order. The gate offers all three
            // channels (Email / SMS / Push) for every notification, so each renders a
            // real Enable/Disable toggle plus a Lock control. Everything shown (and
            // saved) here is the CURRENT TAB's stream overlay, falling back to the
            // flat legacy values until touched.
            NOTIF_CHANNEL_COLS.forEach { channel ->
                val channelOn = streamEffectiveChannel(matrix, entry.key, stream, channel)
                NotifCell(
                    on = channelOn,
                    show = true,
                    // On/Off supersedes channels: the toggle greys out (inert) when
                    // the notification's master is off, but stays visible.
                    enabledToggle = enabled,
                    locked = streamEffectiveChannelLocked(matrix, entry.key, stream, channel),
                    onToggle = { onToggleChannel(channel, !channelOn) },
                    onToggleLock = { onToggleChannelLock(channel) },
                )
            }
        }
        // Any active lock in this stream view reveals the reason editor: locked rows
        // promise the recipient a "why", and this is where the operator writes it.
        if (enabledLockOn || anyChannelLockOn || entry.alwaysEnabledFor(stream)) {
            NotifLockReasonEditor(
                entryKey = entry.key,
                reason = lockReasonFor(matrix, entry.key),
                onSave = onSaveLockReason,
            )
        }
    }
}

private const val LOCK_REASON_MAX = 300

/**
 * Compact inline editor for the operator's lock reason, shown under a row whenever it
 * carries an active lock in the current stream view. Reuses the BottomBorderField
 * inline-edit pattern. Saving persists through saveBusinessNotificationOverride; an
 * empty save clears the reason (the wire treats "" as an explicit clear).
 */
@Composable
private fun NotifLockReasonEditor(
    entryKey: String,
    reason: String?,
    onSave: (String) -> Unit,
) {
    val c = AuntieTheme.colors
    var editing by remember(entryKey) { mutableStateOf(false) }
    var draft by remember(entryKey) { mutableStateOf(reason.orEmpty()) }
    if (!editing) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(6.dp),
            modifier = Modifier.fillMaxWidth().padding(top = 2.dp),
        ) {
            Text(
                reason ?: "Tell folks why this one stays on",
                style = AuntieTheme.typography.labelSmall,
                color = if (reason != null) c.textDim else c.textFaint,
            )
            Icon(
                imageVector = Lucide.Pencil,
                contentDescription = if (reason != null) "Edit the reason folks see" else "Add the reason folks see",
                tint = c.textFaint,
                modifier = Modifier
                    .clip(RoundedCornerShape(6.dp))
                    .clickable { draft = reason.orEmpty(); editing = true }
                    .padding(3.dp)
                    .size(13.dp),
            )
        }
    } else {
        val tooLong = draft.length > LOCK_REASON_MAX
        Row(
            verticalAlignment = Alignment.Bottom,
            horizontalArrangement = Arrangement.spacedBy(10.dp),
            modifier = Modifier.fillMaxWidth().padding(top = 4.dp),
        ) {
            BottomBorderField(
                value = draft,
                onValueChange = { draft = it },
                label = "Why it stays on",
                placeholder = "Tell folks why this one stays on",
                errorMessage = if (tooLong) "Keep it under 300 characters" else null,
                modifier = Modifier.weight(1f),
                onImeAction = { if (!tooLong) { onSave(draft.trim()); editing = false } },
            )
            PrimaryButton(
                label = "Save",
                enabled = !tooLong,
                onClick = { onSave(draft.trim()); editing = false },
            )
            GhostButton(label = "Cancel", onClick = { editing = false })
        }
    }
}

/** One aligned matrix cell: a toggle over a tiny lock chip. Empty when [show] is false. */
@Composable
private fun NotifCell(
    on: Boolean,
    show: Boolean,
    locked: Boolean,
    onToggle: () -> Unit,
    onToggleLock: () -> Unit,
    enabledToggle: Boolean = true,
) {
    val c = AuntieTheme.colors
    Column(
        modifier = Modifier.width(NOTIF_CELL_WIDTH),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(2.dp),
    ) {
        if (show) {
            AuntieToggle(checked = on, enabled = enabledToggle, onCheckedChange = { onToggle() })
            Icon(
                imageVector = if (locked) Lucide.Lock else Lucide.LockOpen,
                contentDescription = if (locked) "Locked on for this audience (tap to unlock)" else "Lock on for this audience",
                tint = if (locked) c.primary else c.textFaint,
                modifier = Modifier
                    .clip(RoundedCornerShape(6.dp))
                    .clickable { onToggleLock() }
                    .padding(3.dp)
                    .size(14.dp),
            )
        } else {
            Text("·", style = AuntieTheme.typography.bodySmall, color = c.textFaint)
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// KinCare types (serviceRates editor)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Phase 15, web KinCare-types editor. Edits BusinessSettings.serviceRates (the
 * service-type -> rate map that Schedule + the new-visit dialog read when booking).
 * Self-contained: edits a local copy, saves the whole BusinessSettings via the VM.
 * (Android manages services via its richer ServiceManagementScreen; the web booking
 * flow consumes this simpler serviceRates map, so this is the web-side editor.)
 */
@Composable
private fun KinCareTypesPanel(
    settingsData: BusinessSettings?,
    settingsLoaded: Boolean,
    vm: SettingsViewModel,
    scope: kotlinx.coroutines.CoroutineScope,
    saveError: String?,
) {
    val c = AuntieTheme.colors
    var rows by remember(settingsData) {
        mutableStateOf<List<Pair<String, String>>>(settingsData?.serviceRates?.map { it.key to it.value } ?: emptyList())
    }
    var newType by remember(settingsData) { mutableStateOf("") }
    var newRate by remember(settingsData) { mutableStateOf("") }
    var saving by remember { mutableStateOf(false) }

    val base = settingsData?.serviceRates ?: emptyMap()
    // Last row wins on duplicate type names; blank types dropped.
    val edited = rows.filter { it.first.isNotBlank() }.associate { it.first.trim() to it.second.trim() }
    val dirty = settingsLoaded && edited != base

    DenPanel(
        title = "KinCare types",
        subtitle = "The service types and rates kinfolk pick when booking. Used by Schedule and the new-visit dialog.",
    ) {
        Column(verticalArrangement = Arrangement.spacedBy(14.dp)) {
            if (!settingsLoaded) {
                Text("Loading…", style = AuntieTheme.typography.bodySmall, color = c.textDim)
            } else {
                if (rows.isEmpty()) {
                    Text("No KinCare types yet. Add one below.", style = AuntieTheme.typography.bodySmall, color = c.textDim)
                }
                rows.forEachIndexed { i, row ->
                    Row(
                        verticalAlignment = Alignment.Bottom,
                        horizontalArrangement = Arrangement.spacedBy(10.dp),
                        modifier = Modifier.fillMaxWidth(),
                    ) {
                        BottomBorderField(
                            value = row.first,
                            onValueChange = { v -> rows = rows.toMutableList().also { it[i] = v to it[i].second } },
                            label = "Type",
                            modifier = Modifier.weight(2f),
                        )
                        BottomBorderField(
                            value = row.second,
                            onValueChange = { v -> rows = rows.toMutableList().also { it[i] = it[i].first to v } },
                            label = "Rate",
                            placeholder = "0.00",
                            modifier = Modifier.weight(1f),
                        )
                        GhostButton(label = "Remove", onClick = { rows = rows.toMutableList().also { it.removeAt(i) } })
                    }
                }

                // Add-row
                Row(
                    verticalAlignment = Alignment.Bottom,
                    horizontalArrangement = Arrangement.spacedBy(10.dp),
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    BottomBorderField(value = newType, onValueChange = { newType = it }, label = "New type", placeholder = "e.g. Drop-in visit", modifier = Modifier.weight(2f))
                    BottomBorderField(value = newRate, onValueChange = { newRate = it }, label = "Rate", placeholder = "0.00", modifier = Modifier.weight(1f))
                    PrimaryButton(
                        label = "Add",
                        enabled = newType.isNotBlank(),
                        onClick = {
                            rows = rows + (newType.trim() to newRate.trim())
                            newType = ""; newRate = ""
                        },
                    )
                }

                saveError?.let { msg ->
                    AuntieBanner(tone = AuntieBannerTone.Error, title = "Save failed") {
                        Text(msg, style = AuntieTheme.typography.bodySmall, color = c.textDim)
                    }
                }

                AuntieSaveBar(
                    dirty = dirty,
                    saveEnabled = dirty && !saving && settingsData != null,
                    onCancel = { rows = settingsData?.serviceRates?.map { it.key to it.value } ?: emptyList() },
                    onSave = {
                        settingsData?.let { b ->
                            saving = true
                            scope.launch {
                                vm.saveSettings(b.copy(serviceRates = edited))
                                saving = false
                            }
                        }
                    },
                    dirtyLabel = "Unsaved KinCare types",
                    savedLabel = "KinCare types saved",
                )
            }
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Vet clinics (spec 29 item 8), shared vet_clinics catalog manager
// ─────────────────────────────────────────────────────────────────────────────

/** True when [draft]'s editable fields differ from [original] (ignores id/timestamps). Pure; tested. */
internal fun vetClinicFieldsChanged(original: VetClinic, draft: VetClinic): Boolean =
    original.name.trim()    != draft.name.trim() ||
    original.phone.trim()   != draft.phone.trim() ||
    original.address.trim() != draft.address.trim() ||
    original.website.trim() != draft.website.trim() ||
    original.isEmergency    != draft.isEmergency ||
    original.notes.trim()   != draft.notes.trim()

/** A clinic edit is saveable only with a non-blank name AND a real change. Pure; tested. */
internal fun vetClinicSaveEnabled(original: VetClinic, draft: VetClinic): Boolean =
    draft.name.isNotBlank() && vetClinicFieldsChanged(original, draft)

/** Case-insensitive match across name / phone / address. Blank query matches all. Pure; tested. */
internal fun vetClinicMatchesQuery(clinic: VetClinic, query: String): Boolean {
    val q = query.trim().lowercase()
    if (q.isEmpty()) return true
    return clinic.name.lowercase().contains(q) ||
        clinic.phone.lowercase().contains(q) ||
        clinic.address.lowercase().contains(q)
}

internal fun filterVetClinics(all: List<VetClinic>, query: String): List<VetClinic> =
    all.filter { vetClinicMatchesQuery(it, query) }

/** Pending = a kinfolk submission awaiting operator approval (explicit verified=false). Pure; tested. */
internal fun pendingVetClinics(all: List<VetClinic>): List<VetClinic> = all.filter { !it.verified }
/** Approved = everything visible to households (verified, incl. legacy defaults). Pure; tested. */
internal fun approvedVetClinics(all: List<VetClinic>): List<VetClinic> = all.filter { it.verified }

/**
 * #6: how many households (kinfolk) currently list this clinic. Kinfolk link to a
 * clinic by name (Kinfolk.vetClinicName), so the count matches case-insensitively
 * on the trimmed name. A blank clinic name never matches. Pure; tested.
 */
internal fun vetClinicHouseholdCount(clinic: VetClinic, allKinfolk: List<Kinfolk>): Int {
    val name = clinic.name.trim()
    if (name.isEmpty()) return 0
    return allKinfolk.count { it.vetClinicName.trim().equals(name, ignoreCase = true) }
}

/** #6: two-letter monogram for a clinic's logo avatar (first letters of up to two words). */
internal fun vetClinicMonogram(name: String): String {
    val words = name.trim().split(Regex("\\s+")).filter { it.isNotBlank() }
    return when {
        words.isEmpty() -> "?"
        words.size == 1 -> words[0].take(2).uppercase()
        else -> "${words[0].first()}${words[1].first()}".uppercase()
    }
}

@Composable
private fun VetClinicsPanel(vm: SettingsViewModel) {
    val c = AuntieTheme.colors
    val client = remember { FirestoreClient() }
    val state by remember { vm.vetClinicsStream() }.collectAsState(initial = FirestoreResult.Loading)
    val kinfolkState by remember { client.kinfolkStream() }.collectAsState(initial = FirestoreResult.Loading)
    val allKinfolk = (kinfolkState as? FirestoreResult.Data)?.value ?: emptyList()
    val writeError by vm.vetClinicError.collectAsState()
    var query by remember { mutableStateOf("") }

    DenPanel(
        title = "Vet clinics",
        subtitle = "The shared vet bank every household can pick from. Approve clinics kinfolk submit, then add, edit, or tidy any entry here.",
    ) {
        Column(verticalArrangement = Arrangement.spacedBy(16.dp)) {
            // #6: this is a shared admin surface; the count next to each clinic is how
            // many households currently list it.
            AuntieBanner(tone = AuntieBannerTone.Info, title = "Shared vet directory") {
                Text(
                    "Edits here apply to the bank every household picks from. The badge on each card shows how many households use that clinic.",
                    style = AuntieTheme.typography.bodySmall, color = c.textDim,
                )
            }
            // Fail loud: surface any add / save / delete / approve failure, never swallow it.
            writeError?.let { msg ->
                AuntieBanner(tone = AuntieBannerTone.Error, title = "Vet clinic action failed") {
                    Text(msg, style = AuntieTheme.typography.bodySmall, color = c.textDim)
                }
            }
            when (val s = state) {
                FirestoreResult.Loading ->
                    Text("Loading...", style = AuntieTheme.typography.bodySmall, color = c.textDim)

                is FirestoreResult.Error ->
                    AuntieBanner(tone = AuntieBannerTone.Error, title = "Couldn't load vet clinics") {
                        Text(s.message, style = AuntieTheme.typography.bodySmall, color = c.textDim)
                    }

                is FirestoreResult.Data -> {
                    val all = s.value
                    val pending = pendingVetClinics(all)
                    val approved = filterVetClinics(approvedVetClinics(all), query)

                    // Pending-approval queue: kinfolk submissions awaiting a verdict.
                    if (pending.isNotEmpty()) {
                        Text(
                            "Pending approval (${pending.size})",
                            style = AuntieTheme.typography.titleSmall,
                            color = c.textPrimary,
                        )
                        Text(
                            "A household submitted these. Approve to add them to the shared bank, or reject to discard.",
                            style = AuntieTheme.typography.bodySmall, color = c.textDim,
                        )
                        pending.forEach { clinic ->
                            PendingVetClinicCard(
                                clinic = clinic,
                                onApprove = { vm.approveVetClinic(clinic) },
                                onReject = { vm.rejectVetClinic(clinic._id, clinic.name) },
                            )
                        }
                    }

                    // Search + count over the approved catalog.
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(12.dp),
                        modifier = Modifier.fillMaxWidth(),
                    ) {
                        BottomBorderField(
                            value = query,
                            onValueChange = { query = it },
                            label = "Search clinics by name, phone, or address",
                            modifier = Modifier.weight(1f),
                        )
                        AuntieStatusPill(label = "${approved.size} clinics", tone = AuntieStatusTone.Muted, mono = true)
                    }

                    if (all.isEmpty()) {
                        Text("No vet clinics yet. Add the first one below.", style = AuntieTheme.typography.bodySmall, color = c.textDim)
                    } else if (approved.isEmpty() && query.isNotBlank()) {
                        Text("No clinics match \"$query\".", style = AuntieTheme.typography.bodySmall, color = c.textDim)
                    }
                    // #6: responsive card grid (2-up on wide), each with a logo avatar
                    // + household-count badge, matching the vet-clinics mock.
                    approved.chunked(2).forEach { pair ->
                        Row(
                            modifier = Modifier.fillMaxWidth(),
                            horizontalArrangement = Arrangement.spacedBy(16.dp),
                        ) {
                            pair.forEach { clinic ->
                                Box(modifier = Modifier.weight(1f)) {
                                    VetClinicCard(
                                        clinic = clinic,
                                        householdCount = vetClinicHouseholdCount(clinic, allKinfolk),
                                        onSave = { updated -> vm.saveVetClinic(updated) },
                                        onDelete = { vm.removeVetClinic(clinic._id, clinic.name) },
                                    )
                                }
                            }
                            if (pair.size == 1) Spacer(modifier = Modifier.weight(1f))
                        }
                    }
                    AddVetClinicForm(onCreate = { draft -> vm.addVetClinic(draft) })
                }
            }
        }
    }
}

/** Soft card surface matching the Den vet-clinics mock (rounded, hairline border). */
@Composable
private fun VetCardSurface(content: @Composable ColumnScope.() -> Unit) {
    val c = AuntieTheme.colors
    Column(
        verticalArrangement = Arrangement.spacedBy(8.dp),
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(16.dp))
            .border(AuntieTheme.dims.borderHairline, c.borderSoft, RoundedCornerShape(16.dp))
            .background(c.surface2)
            .padding(16.dp),
        content = content,
    )
}

/** One labelled detail line ("(512) 1-2345"), omitted entirely when [value] is blank. */
@Composable
private fun VetDetailLine(label: String, value: String) {
    if (value.isBlank()) return
    val c = AuntieTheme.colors
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Text("$label:", style = AuntieTheme.typography.bodySmall, color = c.textDim)
        Text(value, style = AuntieTheme.typography.bodySmall, color = c.textPrimary)
    }
}

@Composable
private fun PendingVetClinicCard(clinic: VetClinic, onApprove: () -> Unit, onReject: () -> Unit) {
    val c = AuntieTheme.colors
    var confirmingReject by remember(clinic) { mutableStateOf(false) }
    VetCardSurface {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            Text(clinic.name, style = AuntieTheme.typography.titleSmall, color = c.textPrimary, modifier = Modifier.weight(1f))
            AuntieStatusPill(label = "Pending", tone = AuntieStatusTone.Warning, showDot = true)
        }
        VetDetailLine("Phone", clinic.phone)
        VetDetailLine("Address", clinic.address)
        VetDetailLine("Website", clinic.website)
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically) {
            PrimaryButton(label = "Approve", onClick = onApprove)
            if (confirmingReject) {
                GhostButton(label = "Confirm reject", onClick = { confirmingReject = false; onReject() })
                GhostButton(label = "Cancel", onClick = { confirmingReject = false })
            } else {
                GhostButton(label = "Reject", onClick = { confirmingReject = true })
            }
        }
    }
}

@Composable
private fun VetClinicCard(clinic: VetClinic, householdCount: Int, onSave: (VetClinic) -> Unit, onDelete: () -> Unit) {
    val c = AuntieTheme.colors
    var editing by remember(clinic) { mutableStateOf(false) }
    var confirmingDelete by remember(clinic) { mutableStateOf(false) }

    VetCardSurface {
        // #6: logo avatar (monogram) + name + emergency pill.
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            AuntieAvatar(initials = vetClinicMonogram(clinic.name), size = 40.dp)
            Column(modifier = Modifier.weight(1f)) {
                Text(clinic.name, style = AuntieTheme.typography.titleSmall, color = c.textPrimary)
                Text("vet_clinics/${clinic._id}", style = AuntieTheme.typography.bodySmall, color = c.textDim)
            }
            if (clinic.isEmergency) AuntieStatusPill(label = "24hr / ER", tone = AuntieStatusTone.Orange)
        }
        // #6: households-linked badge (how many kinfolk list this clinic).
        AuntieStatusPill(
            label = if (householdCount == 1) "1 household" else "$householdCount households",
            tone = if (householdCount > 0) AuntieStatusTone.Teal else AuntieStatusTone.Muted,
            mono = true,
        )

        if (!editing) {
            VetDetailLine("Phone", clinic.phone)
            VetDetailLine("Address", clinic.address)
            VetDetailLine("Website", clinic.website)
            VetDetailLine("Notes", clinic.notes)
            // #6: icon actions (mock fidelity): Maps + Website deep-links + edit/delete.
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
                if (clinic.googleMapsUrl.isNotBlank()) {
                    AuntieIconButton(icon = Lucide.MapPin, contentDescription = "Open in Maps", onClick = { launchUri(clinic.googleMapsUrl) })
                }
                if (clinic.website.isNotBlank()) {
                    AuntieIconButton(icon = Lucide.ExternalLink, contentDescription = "Open website", onClick = { launchUri(clinic.website) })
                }
                AuntieIconButton(icon = Lucide.Pencil, contentDescription = "Edit clinic", onClick = { editing = true })
                if (confirmingDelete) {
                    GhostButton(label = "Confirm delete", onClick = { confirmingDelete = false; onDelete() })
                    GhostButton(label = "Cancel", onClick = { confirmingDelete = false })
                } else {
                    AuntieIconButton(icon = Lucide.Trash2, contentDescription = "Delete clinic", destructive = true, onClick = { confirmingDelete = true })
                }
            }
        } else {
            VetClinicEditFields(clinic = clinic, onSaved = { onSave(it); editing = false }, onCancel = { editing = false })
        }
    }
}

/** Inline editor for an existing clinic (name/phone/address/website/emergency/notes). */
@Composable
private fun VetClinicEditFields(clinic: VetClinic, onSaved: (VetClinic) -> Unit, onCancel: () -> Unit) {
    var name        by remember(clinic) { mutableStateOf(clinic.name) }
    var phone       by remember(clinic) { mutableStateOf(clinic.phone) }
    var address     by remember(clinic) { mutableStateOf(clinic.address) }
    var website     by remember(clinic) { mutableStateOf(clinic.website) }
    var notes       by remember(clinic) { mutableStateOf(clinic.notes) }
    var isEmergency by remember(clinic) { mutableStateOf(clinic.isEmergency) }

    val draft = clinic.copy(
        name = name, phone = phone, address = address,
        website = website, notes = notes, isEmergency = isEmergency,
    )
    val canSave = vetClinicSaveEnabled(clinic, draft)

    BottomBorderField(value = name, onValueChange = { name = it }, label = "Clinic name")
    Row(horizontalArrangement = Arrangement.spacedBy(10.dp), modifier = Modifier.fillMaxWidth()) {
        BottomBorderField(value = phone, onValueChange = { phone = it }, label = "Phone", modifier = Modifier.weight(1f))
        BottomBorderField(value = address, onValueChange = { address = it }, label = "Address", modifier = Modifier.weight(2f))
    }
    BottomBorderField(value = website, onValueChange = { website = it }, label = "Website")
    BottomBorderField(value = notes, onValueChange = { notes = it }, label = "Notes")
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        AuntieToggle(checked = isEmergency, onCheckedChange = { isEmergency = it })
        Text("24hr / emergency clinic", style = AuntieTheme.typography.bodySmall, color = AuntieTheme.colors.textPrimary)
    }
    Row(horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically) {
        PrimaryButton(label = "Save", enabled = canSave, onClick = { onSaved(draft.copy(name = name.trim(), phone = phone.trim(), address = address.trim(), website = website.trim(), notes = notes.trim())) })
        GhostButton(label = "Cancel", onClick = onCancel)
    }
}

@Composable
private fun AddVetClinicForm(onCreate: (VetClinic) -> Unit) {
    var name        by remember { mutableStateOf("") }
    var phone       by remember { mutableStateOf("") }
    var address     by remember { mutableStateOf("") }
    var website     by remember { mutableStateOf("") }
    var notes       by remember { mutableStateOf("") }
    var isEmergency by remember { mutableStateOf(false) }

    Column(verticalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.fillMaxWidth()) {
        Text("Add a clinic", style = AuntieTheme.typography.titleSmall, color = AuntieTheme.colors.textPrimary)
        BottomBorderField(value = name, onValueChange = { name = it }, label = "Clinic name", placeholder = "e.g. Creekside Animal Hospital")
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp), modifier = Modifier.fillMaxWidth()) {
            BottomBorderField(value = phone, onValueChange = { phone = it }, label = "Phone", modifier = Modifier.weight(1f))
            BottomBorderField(value = address, onValueChange = { address = it }, label = "Address", modifier = Modifier.weight(2f))
        }
        BottomBorderField(value = website, onValueChange = { website = it }, label = "Website")
        BottomBorderField(value = notes, onValueChange = { notes = it }, label = "Notes")
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            AuntieToggle(checked = isEmergency, onCheckedChange = { isEmergency = it })
            Text("24hr / emergency clinic", style = AuntieTheme.typography.bodySmall, color = AuntieTheme.colors.textPrimary)
        }
        PrimaryButton(
            label = "Add clinic",
            enabled = name.isNotBlank(),
            onClick = {
                // Admin-authored clinics are approved immediately (verified defaults true).
                onCreate(VetClinic(name = name.trim(), phone = phone.trim(), address = address.trim(), website = website.trim(), notes = notes.trim(), isEmergency = isEmergency))
                name = ""; phone = ""; address = ""; website = ""; notes = ""; isEmergency = false
            },
        )
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Integrations
// ─────────────────────────────────────────────────────────────────────────────

@Composable
private fun IntegrationsPanel(settingsResult: FirestoreResult<BusinessSettings>) {
    val c = AuntieTheme.colors
    val dims = AuntieTheme.dims
    // Firestore is the one channel this console can probe cheaply + truthfully:
    // its read path is exactly the settings load already in flight, so we derive
    // its health from that result (no extra round-trip). n8n / FCM / Twilio are
    // server-side managed - a client ping from the admin console isn't meaningful
    // (FCM delivers to the mobile apps, not here), so they read CONFIGURED.
    val firestoreState = integrationHealthFromResult(settingsResult)
    DenPanel(
        title = "Integrations",
        subtitle = "What powers the Den, plus optional add-ons. Firestore is checked live; the rest are managed server-side.",
        trailing = {
            AuntieStatusPill(
                label = integrationPillLabel(firestoreState),
                tone = integrationPillTone(firestoreState),
                mono = true,
                showDot = true,
                glow = firestoreState == IntegrationHealthState.CHECKING,
            )
        },
    ) {
        Column(verticalArrangement = Arrangement.spacedBy(dims.space2)) {
            // #8: app infrastructure (what the Den needs to run) - real / configured health.
            Text("SYSTEM SERVICES", style = AuntieTheme.typography.labelSmall, color = c.textFaint)
            IntegrationRow("Firestore", "Read / Write", firestoreState)
            IntegrationRow("n8n Webhooks", "Generate + Update Profiles", IntegrationHealthState.CONFIGURED)
            IntegrationRow("FCM", "Push Notifications", IntegrationHealthState.CONFIGURED)
            IntegrationRow("Twilio Studio", "Voice + SMS", IntegrationHealthState.CONFIGURED)

            Spacer(Modifier.height(dims.space3))

            // #8: Payments (Stripe Connect). This is the ONE integration that is a named
            // external-secret defer: connecting it needs YOUR Stripe Connect client ID +
            // secret, which only the operator can provide. Shown honestly as "Needs your
            // keys" (never faked as connected); Manage activates once the keys are added.
            Text("PAYMENTS", style = AuntieTheme.typography.labelSmall, color = c.textFaint)
            IntegrationNeedsKeysRow(
                name = "Stripe Connect",
                detail = "Online payments, invoices, and payouts",
                hint = "Connecting needs your Stripe Connect client ID + secret (operator-provided). Add them and Manage turns on here.",
            )

            Spacer(Modifier.height(dims.space3))

            // #8: optional third-party ADD-ONS (Zapier, to-do apps, etc.). None are built
            // yet - shown honestly as "Coming soon", never faked as connected. Each will get
            // connect + settings + links here once the connect flow ships.
            Text("ADD-ONS", style = AuntieTheme.typography.labelSmall, color = c.textFaint)
            AddOnComingSoon("Zapier", "Automate workflows across thousands of apps")
            AddOnComingSoon("Make", "Visual multi-step automations")
            AddOnComingSoon("Google Tasks", "Push KinCare to-dos to your task list")
            Text(
                "Add-ons aren't available yet: connecting one needs an OAuth / connect flow that does not exist yet. The system services above power the Den.",
                style = AuntieTheme.typography.bodySmall,
                color = c.textDim,
            )
        }
    }
}

/**
 * #8: a third-party add-on row, shown honestly as "Coming soon" (none are built; never
 * faked as connected). When the connect flow ships, this becomes connect + settings + link.
 */
/**
 * #8: an integration that is a NAMED external-secret defer (Stripe Connect). It is
 * honestly shown as "Needs your keys" with the exact secret named, never faked as
 * connected and never a dead "Manage" button. Manage activates once the operator
 * supplies the keys (per the dev rule: the only legitimate defer is an external
 * secret, and it must be named).
 */
@Composable
private fun IntegrationNeedsKeysRow(name: String, detail: String, hint: String) {
    val c = AuntieTheme.colors
    Column(modifier = Modifier.fillMaxWidth().padding(vertical = 4.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth()) {
            Column(modifier = Modifier.weight(1f)) {
                Text(name, style = AuntieTheme.typography.titleSmall, color = c.textPrimary)
                Text(detail, style = AuntieTheme.typography.bodySmall, color = c.textDim)
            }
            Box(
                modifier = Modifier
                    .clip(RoundedCornerShape(999.dp))
                    .border(AuntieTheme.dims.borderHairline, c.warning, RoundedCornerShape(999.dp))
                    .padding(horizontal = 10.dp, vertical = 4.dp),
            ) {
                Text("Needs your keys", style = AuntieTheme.typography.labelSmall, color = c.warning)
            }
        }
        Text(hint, style = AuntieTheme.typography.bodySmall, color = c.textDim, modifier = Modifier.padding(top = 2.dp))
    }
}

@Composable
private fun AddOnComingSoon(name: String, detail: String) {
    val c = AuntieTheme.colors
    Row(
        modifier = Modifier.fillMaxWidth().padding(vertical = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(modifier = Modifier.weight(1f)) {
            Text(name, style = AuntieTheme.typography.titleSmall, color = c.textPrimary)
            Text(detail, style = AuntieTheme.typography.bodySmall, color = c.textDim)
        }
        Box(
            modifier = Modifier
                .clip(RoundedCornerShape(999.dp))
                .border(AuntieTheme.dims.borderHairline, c.border, RoundedCornerShape(999.dp))
                .padding(horizontal = 10.dp, vertical = 4.dp),
        ) {
            Text("Coming soon", style = AuntieTheme.typography.labelSmall, color = c.textFaint)
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Scheduling
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The service account the admin must share the Google Calendar with. ADC resolves
 * this identity at runtime in the syncGoogleCalendarBusyEvents callable (exported
 * there as CALENDAR_SYNC_SA_EMAIL). Auth is service-account only: no OAuth, no
 * token entry. Kept in sync with the backend literal by hand.
 */
internal const val CALENDAR_SYNC_SA_EMAIL =
    "auntieos-admin-calendar-sync@auntieos-ttpc.iam.gserviceaccount.com"

/**
 * Save-bar enablement for the Google Calendar id field. The Calendar ID is dirty
 * when the trimmed edited value differs from what is loaded on BusinessSettings.
 * Pure; tested. Treats a null doc as an empty stored id.
 */
internal fun calendarSyncIdDirty(loaded: BusinessSettings?, edited: String): Boolean =
    edited.trim() != (loaded?.calendarSyncId ?: "").trim()

@Composable
private fun SchedulingPanel(
    settingsData: BusinessSettings?,
    settingsLoaded: Boolean,
    vm: SettingsViewModel,
    scope: kotlinx.coroutines.CoroutineScope,
    saveError: String?,
) {
    val c = AuntieTheme.colors
    val client = remember { FirestoreClient() }

    var syncing by remember { mutableStateOf(false) }
    var syncError by remember { mutableStateOf<String?>(null) }
    var importedCount by remember { mutableStateOf<Int?>(null) }

    // Calendar id the admin types in (saved onto BusinessSettings.calendarSyncId,
    // which the syncGoogleCalendarBusyEvents callable reads). Seeded from the loaded
    // doc; re-seeds when the doc changes.
    var calendarId by remember(settingsData) { mutableStateOf(settingsData?.calendarSyncId ?: "") }
    var savingCalendarId by remember { mutableStateOf(false) }
    val calendarIdDirty = calendarSyncIdDirty(settingsData, calendarId)

    DenPanel(
        title = "Scheduling",
        subtitle = "Behavior for the calendar and Google Calendar sync.",
        trailing = {
            AuntieStatusPill(label = "Server sync", tone = AuntieStatusTone.Orange, mono = true)
        },
    ) {
        Column {
            // Real, server-backed action. The callable reads the shared Google
            // Calendar via ADC (no key in the bundle) and imports Busy events
            // as private BLOCKED slots. We surface the raw server message on
            // failure so the not-shared / not-configured fix is unambiguous.
            Text(
                "Run a one-off import of your shared Google Calendar's busy events. They become private blocks on the booking schedule. Kinfolk only see unavailable time, never event details.",
                style = AuntieTheme.typography.bodySmall,
                color = c.textDim,
            )
            Spacer(Modifier.height(14.dp))

            // Google Calendar id (admin-entered). Persisted to
            // BusinessSettings.calendarSyncId; the sync callable reads it.
            BottomBorderField(
                value = calendarId,
                onValueChange = { calendarId = it },
                label = "Google Calendar ID",
                placeholder = "name@group.calendar.google.com",
                modifier = Modifier.fillMaxWidth(),
            )
            Spacer(Modifier.height(6.dp))
            Text(
                "Share the calendar with $CALENDAR_SYNC_SA_EMAIL at See only free/busy (hide details). The app imports busy blocks only, never event details.",
                style = AuntieTheme.typography.bodySmall,
                color = c.textDim,
            )
            Spacer(Modifier.height(10.dp))
            saveError?.let { msg ->
                AuntieBanner(tone = AuntieBannerTone.Error, title = "Save failed") {
                    Text(msg, style = AuntieTheme.typography.bodySmall, color = c.textDim)
                }
                Spacer(Modifier.height(10.dp))
            }
            AuntieSaveBar(
                dirty = calendarIdDirty,
                saveEnabled = calendarIdDirty && !savingCalendarId && settingsLoaded,
                onCancel = { calendarId = settingsData?.calendarSyncId ?: "" },
                onSave = {
                    savingCalendarId = true
                    scope.launch {
                        vm.saveSettings(
                            (settingsData ?: BusinessSettings()).copy(calendarSyncId = calendarId.trim()),
                        )
                        savingCalendarId = false
                    }
                },
                dirtyLabel = "Unsaved Calendar ID",
                savedLabel = "Calendar ID saved",
            )
            Spacer(Modifier.height(16.dp))

            syncError?.let { msg ->
                AuntieBanner(
                    tone = AuntieBannerTone.Error,
                    title = "Calendar sync failed",
                    body = {
                        Text(msg, style = AuntieTheme.typography.bodySmall, color = c.textDim)
                    },
                )
                Spacer(Modifier.height(12.dp))
            }
            importedCount?.let { n ->
                Text(
                    "Imported $n busy blocks.",
                    style = AuntieTheme.typography.bodySmall,
                    color = c.textPrimary,
                )
                Spacer(Modifier.height(12.dp))
            }
            PrimaryButton(
                label = "Run Sync",
                loading = syncing,
                enabled = !syncing,
                onClick = {
                    syncing = true
                    syncError = null
                    importedCount = null
                    scope.launch {
                        when (val r = client.syncGoogleCalendarBusyEvents()) {
                            is WriteResult.Ok -> importedCount = r.value
                            is WriteResult.Err -> syncError = r.message
                        }
                        syncing = false
                    }
                },
            )
            Spacer(Modifier.height(14.dp))
            SchedulingPlaceholderRow(
                title = "Sync Google Calendar busy events",
                description = "Show external commitments as read-only blocks on the schedule.",
                showDivider = true,
            )
            SchedulingPlaceholderRow(
                title = "Block bookings during busy events",
                description = "Stop new visits from landing on top of a Google Calendar block.",
                showDivider = true,
            )
            SchedulingPlaceholderRow(
                title = "Snap drag-to-reschedule to 15 min",
                description = "Visits align to quarter-hour slots when dragged.",
                showDivider = true,
            )
            SchedulingPlaceholderRow(
                title = "Auto-confirm repeat clients",
                description = "Trusted kinfolk bookings skip manual approval.",
                showDivider = false,
            )
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// #7 restructure: the old "Scheduling" section is split. Google Calendar sync +
// busy-block live under Business Hours (GcalSyncPanel); booking behavior
// (auto-confirm + snap) lives under the Booking section (BookingBehaviorPanel).
// ─────────────────────────────────────────────────────────────────────────────

@Composable
private fun GcalSyncPanel(
    settingsData: BusinessSettings?,
    settingsLoaded: Boolean,
    vm: SettingsViewModel,
    scope: kotlinx.coroutines.CoroutineScope,
    saveError: String?,
) {
    val c = AuntieTheme.colors
    val client = remember { FirestoreClient() }
    var syncing by remember { mutableStateOf(false) }
    var syncError by remember { mutableStateOf<String?>(null) }
    var importedCount by remember { mutableStateOf<Int?>(null) }
    var calendarId by remember(settingsData) { mutableStateOf(settingsData?.calendarSyncId ?: "") }
    var savingCalendarId by remember { mutableStateOf(false) }
    val calendarIdDirty = calendarSyncIdDirty(settingsData, calendarId)

    DenPanel(
        title = "Google Calendar sync",
        subtitle = "Import your shared calendar's busy events as private blocks on the schedule.",
        collapsible = true,
        initiallyExpanded = false,
        trailing = { AuntieStatusPill(label = "Server sync", tone = AuntieStatusTone.Orange, mono = true) },
    ) {
        Column {
            Text(
                "Run a one-off import of your shared Google Calendar's busy events. They become private blocks on the booking schedule. Kinfolk only see unavailable time, never event details.",
                style = AuntieTheme.typography.bodySmall,
                color = c.textDim,
            )
            Spacer(Modifier.height(14.dp))
            BottomBorderField(
                value = calendarId,
                onValueChange = { calendarId = it },
                label = "Google Calendar ID",
                placeholder = "name@group.calendar.google.com",
                modifier = Modifier.fillMaxWidth(),
            )
            Spacer(Modifier.height(6.dp))
            Text(
                "Share the calendar with $CALENDAR_SYNC_SA_EMAIL at See only free/busy (hide details). The app imports busy blocks only, never event details.",
                style = AuntieTheme.typography.bodySmall,
                color = c.textDim,
            )
            Spacer(Modifier.height(10.dp))
            saveError?.let { msg ->
                AuntieBanner(tone = AuntieBannerTone.Error, title = "Save failed") {
                    Text(msg, style = AuntieTheme.typography.bodySmall, color = c.textDim)
                }
                Spacer(Modifier.height(10.dp))
            }
            AuntieSaveBar(
                dirty = calendarIdDirty,
                saveEnabled = calendarIdDirty && !savingCalendarId && settingsLoaded,
                onCancel = { calendarId = settingsData?.calendarSyncId ?: "" },
                onSave = {
                    savingCalendarId = true
                    scope.launch {
                        vm.saveSettings(
                            (settingsData ?: BusinessSettings()).copy(calendarSyncId = calendarId.trim()),
                        )
                        savingCalendarId = false
                    }
                },
                dirtyLabel = "Unsaved Calendar ID",
                savedLabel = "Calendar ID saved",
            )
            Spacer(Modifier.height(16.dp))
            syncError?.let { msg ->
                AuntieBanner(
                    tone = AuntieBannerTone.Error,
                    title = "Calendar sync failed",
                    body = { Text(msg, style = AuntieTheme.typography.bodySmall, color = c.textDim) },
                )
                Spacer(Modifier.height(12.dp))
            }
            importedCount?.let { n ->
                Text(
                    "Imported $n busy blocks.",
                    style = AuntieTheme.typography.bodySmall,
                    color = c.textPrimary,
                )
                Spacer(Modifier.height(12.dp))
            }
            PrimaryButton(
                label = "Run Sync",
                loading = syncing,
                enabled = !syncing,
                onClick = {
                    syncing = true
                    syncError = null
                    importedCount = null
                    scope.launch {
                        when (val r = client.syncGoogleCalendarBusyEvents()) {
                            is WriteResult.Ok -> importedCount = r.value
                            is WriteResult.Err -> syncError = r.message
                        }
                        syncing = false
                    }
                },
            )
            Spacer(Modifier.height(14.dp))
            SchedulingPlaceholderRow(
                title = "Block bookings during busy events",
                description = "Stop new visits from landing on top of a Google Calendar block.",
                showDivider = false,
            )
        }
    }
}

@Composable
private fun BookingBehaviorPanel(
    settingsData: BusinessSettings?,
    settingsLoaded: Boolean,
    vm: SettingsViewModel,
) {
    val scope = rememberCoroutineScope()
    DenPanel(
        title = "Booking behavior",
        subtitle = "How new bookings are confirmed and adjusted.",
    ) {
        // #9 (2026-06-08): real persisted toggles. Each flip merges the change onto
        // the business_settings doc immediately (admin-writable; no callable). Disabled
        // until settings load so a flip can't clobber the doc with defaults.
        val s = settingsData
        Column {
            AuntieSettingRow(
                title = "Auto-confirm repeat kinfolk",
                description = "Kinfolk who have booked before skip the manual approval queue. New kinfolk still need approval.",
                leadingIcon = Lucide.CalendarClock,
                iconTone = AuntieStatusTone.Orange,
                showDivider = true,
                trailing = {
                    AuntieToggle(
                        checked = s?.autoConfirmRepeatKinfolk == true,
                        onCheckedChange = { next -> if (s != null) scope.launch { vm.saveSettings(s.copy(autoConfirmRepeatKinfolk = next)) } },
                        enabled = settingsLoaded,
                    )
                },
            )
            AuntieSettingRow(
                title = "Snap drag-to-reschedule to 15 min",
                description = "Visits align to quarter-hour slots when dragged on the schedule.",
                leadingIcon = Lucide.CalendarClock,
                iconTone = AuntieStatusTone.Orange,
                showDivider = false,
                trailing = {
                    AuntieToggle(
                        checked = s?.snapRescheduleTo15Min == true,
                        onCheckedChange = { next -> if (s != null) scope.launch { vm.saveSettings(s.copy(snapRescheduleTo15Min = next)) } },
                        enabled = settingsLoaded,
                    )
                },
            )
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Branding (17.2)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 17.2 Branding: operator-editable logo + app name/tagline + Home greeting.
 * All five fields live on the shared business_settings doc and persist through the
 * existing merge write (vm.saveSettings -> saveBusinessSettings); no backend. Each
 * field is blank-safe: an empty value keeps the shipped default, so the app reads
 * byte-identical until the operator customizes it. The logo reuses the proven
 * Cloudinary upload pipeline (admin-signed); the URL is staged in edit state and
 * committed by the Save bar together with the text fields. Fail-loud on both the
 * upload and the save.
 */
@Composable
private fun BrandingPanel(
    authUser: AuthUser,
    client: FirestoreClient,
    settingsData: BusinessSettings?,
    settingsLoaded: Boolean,
    vm: SettingsViewModel,
    scope: kotlinx.coroutines.CoroutineScope,
    saveError: String?,
) {
    val c = AuntieTheme.colors

    // Edit state seeded from the loaded doc; re-seeds whenever the stream re-emits
    // (e.g. after a successful save the new doc flows back and clears the dirty pip).
    var logoUrl by remember(settingsData) { mutableStateOf(settingsData?.logoUrl ?: "") }
    var wordmark by remember(settingsData) { mutableStateOf(settingsData?.brandWordmark ?: "") }
    var tagline by remember(settingsData) { mutableStateOf(settingsData?.brandTagline ?: "") }
    var greeting by remember(settingsData) { mutableStateOf(settingsData?.homeGreeting ?: "") }
    var accentTail by remember(settingsData) { mutableStateOf(settingsData?.homeAccentTail ?: "") }

    var uploading by remember { mutableStateOf(false) }
    var uploadError by remember { mutableStateOf<String?>(null) }
    var saving by remember { mutableStateOf(false) }

    val loaded = settingsData ?: BusinessSettings()
    val dirty = brandingDirty(loaded, loaded.withBranding(logoUrl, wordmark, tagline, greeting, accentTail))

    DenPanel(
        title = "Branding",
        subtitle = "Your logo, app name, and Home greeting. Leave any field blank to keep the default.",
        trailing = { AuntieStatusPill(label = "This workspace", tone = AuntieStatusTone.Teal, mono = true) },
    ) {
        Column {
            // Logo: live preview + upload/replace/remove. The preview falls back to
            // the PawPrint glyph (matching the nav rail) when no logo is set.
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(14.dp),
                modifier = Modifier.fillMaxWidth(),
            ) {
                AuntieAvatar(
                    imageUrl = logoUrl.ifBlank { null },
                    glyph = Lucide.PawPrint,
                    size = 56.dp,
                    shape = RoundedCornerShape(16.dp),
                    gradientSeed = "AuntieOS",
                )
                Column(modifier = Modifier.weight(1f)) {
                    GhostButton(
                        label = when {
                            uploading -> "Uploading logo"
                            logoUrl.isBlank() -> "Upload logo"
                            else -> "Replace logo"
                        },
                        enabled = !uploading,
                        onClick = {
                            uploading = true
                            uploadError = null
                            scope.launch {
                                when (val up = client.uploadMedia("business_settings", "BUSINESS", byteArrayOf(), "image/png")) {
                                    is WriteResult.Err -> uploadError = "Logo upload failed: ${up.message}"
                                    is WriteResult.Ok -> {
                                        val media = up.value
                                        // Blank id/url = the picker was cancelled. Never fake a success.
                                        if (media._id.isBlank() || media.storageUrl.isBlank()) {
                                            uploadError = "No logo selected"
                                        } else {
                                            logoUrl = media.storageUrl
                                        }
                                    }
                                }
                                uploading = false
                            }
                        },
                    )
                    if (logoUrl.isNotBlank()) {
                        Spacer(Modifier.height(8.dp))
                        GhostButton(label = "Remove logo", enabled = !uploading, onClick = { logoUrl = "" })
                    }
                }
            }
            uploadError?.let { msg ->
                Spacer(Modifier.height(10.dp))
                AuntieBanner(tone = AuntieBannerTone.Error, title = "Logo upload failed") {
                    Text(msg, style = AuntieTheme.typography.bodySmall, color = c.textDim)
                }
            }
            Spacer(Modifier.height(18.dp))

            BottomBorderField(
                value = wordmark,
                onValueChange = { wordmark = it },
                label = "App name",
                placeholder = DEFAULT_BRAND_WORDMARK,
                modifier = Modifier.fillMaxWidth(),
            )
            Spacer(Modifier.height(14.dp))
            BottomBorderField(
                value = tagline,
                onValueChange = { tagline = it },
                label = "Tagline",
                placeholder = DEFAULT_BRAND_TAGLINE,
                modifier = Modifier.fillMaxWidth(),
            )
            Spacer(Modifier.height(14.dp))
            BottomBorderField(
                value = greeting,
                onValueChange = { greeting = it },
                label = "Home greeting",
                placeholder = "Defaults to the time of day (Good Morning)",
                modifier = Modifier.fillMaxWidth(),
            )
            Spacer(Modifier.height(14.dp))
            BottomBorderField(
                value = accentTail,
                onValueChange = { accentTail = it },
                label = "Home accent word",
                placeholder = DEFAULT_HOME_ACCENT_TAIL,
                modifier = Modifier.fillMaxWidth(),
            )
            Spacer(Modifier.height(14.dp))

            saveError?.let { msg ->
                AuntieBanner(tone = AuntieBannerTone.Error, title = "Save failed") {
                    Text(msg, style = AuntieTheme.typography.bodySmall, color = c.textDim)
                }
                Spacer(Modifier.height(10.dp))
            }

            AuntieSaveBar(
                dirty = dirty,
                saveEnabled = dirty && !saving && settingsLoaded,
                onCancel = {
                    logoUrl = loaded.logoUrl
                    wordmark = loaded.brandWordmark
                    tagline = loaded.brandTagline
                    greeting = loaded.homeGreeting
                    accentTail = loaded.homeAccentTail
                    uploadError = null
                },
                onSave = {
                    saving = true
                    scope.launch {
                        // Recompute from live state at click time (not a stale closure)
                        // and overlay onto the freshly-loaded doc so the merge write
                        // never clobbers a sibling field.
                        val toSave = (settingsData ?: BusinessSettings())
                            .withBranding(logoUrl, wordmark, tagline, greeting, accentTail)
                        vm.saveSettings(toSave)
                        saving = false
                    }
                },
                dirtyLabel = "Unsaved branding",
                savedLabel = "Branding saved",
            )
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Appearance
// ─────────────────────────────────────────────────────────────────────────────

/** 17.1: the three personalization knobs + their fail-loud persist callbacks,
 *  bundled so the giant SectionPanel signature threads one value, not nine. */
class AppearanceControls(
    val personalization: ThemePersonalization,
    val onAccent: (AccentChoice) -> Unit,
    val onDensity: (DensityChoice) -> Unit,
    val onFontScale: (FontScaleChoice) -> Unit,
    val onThemePreset: (AuntieThemePreset) -> Unit,
    val error: String?,
    val dirty: Boolean,
    val saving: Boolean,
    val onSave: () -> Unit,
    val onDiscard: () -> Unit,
)

@Composable
private fun AppearancePanel(
    themeMode: ThemeMode,
    onThemeModeChange: (ThemeMode) -> Unit,
    themeError: String?,
    appearance: AppearanceControls,
) {
    val c = AuntieTheme.colors
    val dims = AuntieTheme.dims
    DenPanel(title = "Appearance", subtitle = "The look of your workspace. Your choices are saved to your profile and follow you back.") {
      Column(verticalArrangement = Arrangement.spacedBy(dims.space4)) {
        if (themeError != null) {
            AuntieBanner(tone = AuntieBannerTone.Error, title = "Theme not saved") {
                Text(themeError, style = AuntieTheme.typography.bodySmall, color = c.textDim)
            }
        }
        if (appearance.error != null) {
            AuntieBanner(tone = AuntieBannerTone.Error, title = "Appearance not saved") {
                Text(appearance.error, style = AuntieTheme.typography.bodySmall, color = c.textDim)
            }
        }
        // ── Theme mode (existing 0A) ──
        Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.SpaceBetween,
        ) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(dims.space3)) {
                AuntieIconTile(
                    icon = if (themeMode == ThemeMode.DARK) Lucide.Moon else Lucide.Sun,
                    tone = AuntieStatusTone.Orange,
                    size = 40.dp,
                )
                Column {
                    Text("Theme", style = AuntieTheme.typography.titleMedium, color = c.textPrimary)
                    Text(
                        text  = when (themeMode) {
                            ThemeMode.DARK   -> "Dark, Brand Navy base for late-night drafting"
                            ThemeMode.LIGHT  -> "Light, Brand Cream, the default day mode"
                            ThemeMode.SYSTEM -> "System, follows your OS setting"
                        },
                        style = AuntieTheme.typography.bodySmall,
                        color = c.textDim,
                    )
                }
            }
            SegmentedPicker(
                options  = listOf(ThemeMode.LIGHT, ThemeMode.DARK, ThemeMode.SYSTEM),
                selected = themeMode,
                onSelect = { onThemeModeChange(it) },
                label    = { it.name.lowercase().replaceFirstChar { ch -> ch.uppercaseChar() } },
            )
        }

        // ── Theme preset (named brand themes) ──
        Column(verticalArrangement = Arrangement.spacedBy(dims.space2)) {
            Text("Theme preset", style = AuntieTheme.typography.titleMedium, color = c.textPrimary)
            Text(
                "A full brand-tuned look for your workspace. Midnight is a dark theme; the rest follow your light/dark setting.",
                style = AuntieTheme.typography.bodySmall,
                color = c.textDim,
            )
            ThemePresetGrid(
                selected = appearance.personalization.themePreset,
                isDark = c.isDark,
                onSelect = { appearance.onThemePreset(it) },
            )
        }

        // ── Accent color (17.1) ──
        Column(verticalArrangement = Arrangement.spacedBy(dims.space2)) {
            Text("Accent color", style = AuntieTheme.typography.titleMedium, color = c.textPrimary)
            Text("Tints buttons, links, and brand highlights.", style = AuntieTheme.typography.bodySmall, color = c.textDim)
            Row(horizontalArrangement = Arrangement.spacedBy(dims.space3)) {
                AccentChoice.entries.forEach { choice ->
                    val selected = choice == appearance.personalization.accent
                    val grad = choice.gradientColors(c)
                    Box(
                        modifier = Modifier
                            .size(32.dp)
                            .clip(RoundedCornerShape(999.dp))
                            .then(
                                if (grad != null) Modifier.background(androidx.compose.ui.graphics.Brush.horizontalGradient(grad))
                                else Modifier.background(choice.colorFor(c.isDark)),
                            )
                            .border(
                                width = if (selected) 2.5.dp else dims.borderHairline,
                                color = if (selected) c.textPrimary else c.border,
                                shape = RoundedCornerShape(999.dp),
                            )
                            .clickable { appearance.onAccent(choice) },
                    )
                }
            }
        }

        // ── Density (17.1) ──
        Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.SpaceBetween,
        ) {
            Column(modifier = Modifier.weight(1f)) {
                Text("Density", style = AuntieTheme.typography.titleMedium, color = c.textPrimary)
                Text("How much breathing room between elements.", style = AuntieTheme.typography.bodySmall, color = c.textDim)
            }
            SegmentedPicker(
                options  = DensityChoice.entries.toList(),
                selected = appearance.personalization.density,
                onSelect = { appearance.onDensity(it) },
                label    = { it.label },
            )
        }

        // ── Text size (17.1) ──
        Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.SpaceBetween,
        ) {
            Column(modifier = Modifier.weight(1f)) {
                Text("Text size", style = AuntieTheme.typography.titleMedium, color = c.textPrimary)
                Text("Scales every label and body text.", style = AuntieTheme.typography.bodySmall, color = c.textDim)
            }
            SegmentedPicker(
                options  = FontScaleChoice.entries.toList(),
                selected = appearance.personalization.fontScale,
                onSelect = { appearance.onFontScale(it) },
                label    = { it.label },
            )
        }

        // ── Save / Discard (#10) ──
        // Knobs above update the live preview instantly; nothing is persisted until
        // Save. Discard reverts the preview to the last saved value.
        Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.SpaceBetween,
        ) {
            Text(
                text  = if (appearance.dirty) "Unsaved changes" else "All changes saved",
                style = AuntieTheme.typography.bodySmall,
                color = if (appearance.dirty) c.textPrimary else c.textDim,
            )
            Row(horizontalArrangement = Arrangement.spacedBy(dims.space3)) {
                GhostButton(
                    label   = "Discard",
                    enabled = appearance.dirty && !appearance.saving,
                    onClick = { appearance.onDiscard() },
                )
                PrimaryButton(
                    label   = if (appearance.saving) "Saving" else "Save appearance",
                    enabled = appearance.dirty && !appearance.saving,
                    onClick = { appearance.onSave() },
                )
            }
        }
      }
    }
}

/** The nine AuntieOS staff-UI theme presets as selectable swatch cards. Drives the
 *  Appearance section's preset choice (separate from the portal's themeId). */
@OptIn(androidx.compose.foundation.layout.ExperimentalLayoutApi::class)
@Composable
private fun ThemePresetGrid(
    selected: AuntieThemePreset,
    isDark: Boolean,
    onSelect: (AuntieThemePreset) -> Unit,
) {
    androidx.compose.foundation.layout.FlowRow(
        horizontalArrangement = Arrangement.spacedBy(10.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
        modifier = Modifier.fillMaxWidth(),
    ) {
        AuntieThemePreset.entries.forEach { preset ->
            val sw = preset.swatch(isDark)
            ThemeSwatchCard(
                label = preset.label,
                dominant = sw.dominant,
                accent = sw.accent,
                selected = preset == selected,
                blurb = preset.blurb,
                onClick = { onSelect(preset) },
            )
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Security
// ─────────────────────────────────────────────────────────────────────────────

@Composable
internal fun SecurityPanel(
    authUser: AuthUser,
    auth: AuthClient,
    scope: kotlinx.coroutines.CoroutineScope,
) {
    val c = AuntieTheme.colors
    val dims = AuntieTheme.dims
    val client = remember { FirestoreClient() }
    DenPanel(title = "Security", subtitle = "Keep your account safe.") {
        var toast by remember { mutableStateOf<Pair<String, ToastKind>?>(null) }

        // Login email (15.4): editable via verify-before-update. The email only
        // flips after the operator confirms via the link, so we never claim a fake
        // "changed" state.
        var newEmail by remember { mutableStateOf("") }
        var emailPw  by remember { mutableStateOf("") }
        var emailBusy by remember { mutableStateOf(false) }
        val emailLooksValid = newEmail.trim().let { it.contains("@") && it.substringAfterLast("@").contains(".") }
        val canChangeEmail = emailLooksValid && emailPw.isNotBlank() && !emailBusy && authUser.email != null

        // Change password in place (reauth with current password, then set new).
        var curPw     by remember { mutableStateOf("") }
        var newPw     by remember { mutableStateOf("") }
        var confirmPw by remember { mutableStateOf("") }
        var pwBusy    by remember { mutableStateOf(false) }
        val pwMismatch = newPw.isNotEmpty() && confirmPw.isNotEmpty() && newPw != confirmPw
        val canChangePw = curPw.isNotBlank() && newPw.length >= 6 && newPw == confirmPw && !pwBusy

        var resetSending by remember { mutableStateOf(false) }

        Column(verticalArrangement = Arrangement.spacedBy(dims.space2)) {
            Text("Login email", style = AuntieTheme.typography.titleMedium, color = c.textPrimary)
            Text(
                "Signed in as ${authUser.email ?: "(not signed in)"}. This is your account login, not your business contact email.",
                style = AuntieTheme.typography.bodySmall, color = c.textDim,
            )
            BottomBorderField(value = newEmail, onValueChange = { newEmail = it }, label = "New login email", placeholder = "you@example.com")
            AuntiePasswordField(value = emailPw, onValueChange = { emailPw = it }, label = "Current password")
            PrimaryButton(
                label = if (emailBusy) "Sending..." else "Send verification link",
                enabled = canChangeEmail,
                onClick = {
                    emailBusy = true
                    scope.launch {
                        when (val r = auth.updateLoginEmail(emailPw, newEmail.trim())) {
                            is AuthOpResult.Ok -> {
                                toast = "Verification link sent to ${newEmail.trim()}. Confirm there to finish the change." to ToastKind.Success
                                AuditLog.fire(scope, client, authUser.uid, "AUTH_EMAIL_CHANGE_REQUESTED", "Login email change requested to ${newEmail.trim()}")
                                newEmail = ""; emailPw = ""
                            }
                            is AuthOpResult.Failure -> toast = r.friendly to ToastKind.Error
                        }
                        emailBusy = false
                    }
                },
                modifier = Modifier.fillMaxWidth(),
            )

            Spacer(Modifier.height(dims.space3))
            Text("Change password", style = AuntieTheme.typography.titleMedium, color = c.textPrimary)
            AuntiePasswordField(value = curPw, onValueChange = { curPw = it }, label = "Current password")
            AuntiePasswordField(value = newPw, onValueChange = { newPw = it }, label = "New password")
            AuntiePasswordField(value = confirmPw, onValueChange = { confirmPw = it }, label = "Confirm new password")
            if (pwMismatch) Text("Passwords don't match.", style = AuntieTheme.typography.bodySmall, color = c.error)
            PrimaryButton(
                label = if (pwBusy) "Updating..." else "Update password",
                enabled = canChangePw,
                onClick = {
                    pwBusy = true
                    scope.launch {
                        when (val r = auth.updatePassword(curPw, newPw)) {
                            is AuthOpResult.Ok -> {
                                toast = "Password updated." to ToastKind.Success
                                AuditLog.fire(scope, client, authUser.uid, "AUTH_PASSWORD_CHANGED", "Login password changed")
                                curPw = ""; newPw = ""; confirmPw = ""
                            }
                            is AuthOpResult.Failure -> toast = r.friendly to ToastKind.Error
                        }
                        pwBusy = false
                    }
                },
                modifier = Modifier.fillMaxWidth(),
            )

            Spacer(Modifier.height(dims.space2))
            Text("Forgot your password?", style = AuntieTheme.typography.bodySmall, color = c.textDim)
            GhostButton(
                label = if (resetSending) "Sending" else "Send reset email",
                enabled = !resetSending && authUser.email != null,
                onClick = {
                    resetSending = true
                    scope.launch {
                        val ok = auth.sendPasswordReset(authUser.email!!)
                        resetSending = false
                        toast = (if (ok) "Reset email sent to ${authUser.email}" else "Failed to send reset email.") to
                            (if (ok) ToastKind.Success else ToastKind.Error)
                    }
                },
                modifier = Modifier.fillMaxWidth(),
            )

            toast?.let { (msg, kind) ->
                StatusToast(visible = true, message = msg, kind = kind, onDismiss = { toast = null })
            }
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Time Off
// ─────────────────────────────────────────────────────────────────────────────

@Composable
private fun TimeOffPanel(
    client: FirestoreClient,
    vm: SettingsViewModel,
    settingsData: BusinessSettings?,
    settingsLoaded: Boolean,
    scope: kotlinx.coroutines.CoroutineScope,
    businessName: String, businessEmail: String, businessPhone: String, businessAddress: String,
    businessHours: Map<String, String>,
    observedHolidays: Set<String>, onObservedHolidays: (Set<String>) -> Unit,
    companyHolidays: List<String>, onCompanyHolidays: (List<String>) -> Unit,
    newHolidayDate: String, onNewHolidayDate: (String) -> Unit,
    newHolidayName: String, onNewHolidayName: (String) -> Unit,
) {
    val c = AuntieTheme.colors
    val dims = AuntieTheme.dims
    // Special hours (15.5): modified operating hours for specific dates (short
    // days etc.), DISTINCT from full closures above. Self-contained local state
    // seeded from the real BusinessSettings.specialHours; folded into the Save
    // below. Other panels' saves preserve it (copy() leaves it untouched).
    var specialHours by remember(settingsData) {
        mutableStateOf<List<String>>(settingsData?.specialHours ?: emptyList())
    }
    var newSpecialDate  by remember(settingsData) { mutableStateOf("") }
    var newSpecialHours by remember(settingsData) { mutableStateOf("") }
    DenPanel(
        title = "Time Off",
        subtitle = "Holidays the Den observes and your own closures.",
        collapsible = true,
        initiallyExpanded = false,
    ) {
        Column(verticalArrangement = Arrangement.spacedBy(dims.space4)) {
            Text(
                "US Holidays Observed",
                style = AuntieTheme.typography.labelSmall,
                color = c.textDim,
            )
            Column {
                US_HOLIDAYS.forEachIndexed { idx, pair ->
                    val (id, name) = pair
                    val checked = id in observedHolidays
                    AuntieSettingRow(
                        title = name,
                        showDivider = idx < US_HOLIDAYS.lastIndex,
                        trailing = {
                            AuntieToggle(
                                checked = checked,
                                onCheckedChange = { on ->
                                    onObservedHolidays(if (on) observedHolidays + id else observedHolidays - id)
                                },
                            )
                        },
                    )
                }
            }
            Spacer(Modifier.height(dims.space1))
            Text(
                "Company Holidays",
                style = AuntieTheme.typography.labelSmall,
                color = c.textDim,
            )
            companyHolidays.forEachIndexed { idx, entry ->
                // Stored as "YYYY-MM-DD|Name". limit=2 keeps a pipe in the name intact.
                val parts = entry.split("|", limit = 2)
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(dims.space2),
                ) {
                    Column(Modifier.weight(1f)) {
                        Text(parts.getOrElse(1) { "Holiday" }, style = AuntieTheme.typography.bodyMedium, color = c.textPrimary)
                        Text(parts.getOrElse(0) { "" }, style = AuntieTheme.typography.bodySmall, color = c.textDim)
                    }
                    GhostButton(
                        label   = "Remove",
                        onClick = { onCompanyHolidays(companyHolidays.filterIndexed { i, _ -> i != idx }) },
                    )
                }
            }
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(dims.space2),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                BottomBorderField(
                    value = newHolidayDate,
                    onValueChange = onNewHolidayDate,
                    label = "Date (YYYY-MM-DD)",
                    modifier = Modifier.weight(1f),
                )
                BottomBorderField(
                    value = newHolidayName,
                    onValueChange = onNewHolidayName,
                    label = "Name",
                    modifier = Modifier.weight(1f),
                )
                GhostButton(
                    label   = "Add",
                    // Reject a pipe in the name so the "date|name" encoding stays parseable.
                    enabled = HOLIDAY_DATE_REGEX.matches(newHolidayDate) &&
                        newHolidayName.isNotBlank() && !newHolidayName.contains('|'),
                    onClick = {
                        onCompanyHolidays(companyHolidays + "$newHolidayDate|$newHolidayName")
                        onNewHolidayDate(""); onNewHolidayName("")
                    },
                )
            }

            // ── Special hours (15.5): modified hours on specific dates ──
            Spacer(Modifier.height(dims.space1))
            Text("Special Hours", style = AuntieTheme.typography.labelSmall, color = c.textDim)
            Text(
                "Modified operating hours for a specific date (a short day, late open). Not a full closure.",
                style = AuntieTheme.typography.bodySmall,
                color = c.textDim,
            )
            specialHours.forEachIndexed { idx, entry ->
                // Stored as "YYYY-MM-DD|hours". limit=2 keeps any pipe in hours intact.
                val parts = entry.split("|", limit = 2)
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(dims.space2),
                ) {
                    Column(Modifier.weight(1f)) {
                        Text(parts.getOrElse(1) { "Special hours" }, style = AuntieTheme.typography.bodyMedium, color = c.textPrimary)
                        Text(parts.getOrElse(0) { "" }, style = AuntieTheme.typography.bodySmall, color = c.textDim)
                    }
                    GhostButton(
                        label   = "Remove",
                        onClick = { specialHours = specialHours.filterIndexed { i, _ -> i != idx } },
                    )
                }
            }
            SpecialHoursEditorRow(
                date = newSpecialDate,
                onDate = { newSpecialDate = it },
                hours = newSpecialHours,
                onHours = { newSpecialHours = it },
                onAdd = {
                    specialHours = specialHours + "$newSpecialDate|$newSpecialHours"
                    newSpecialDate = ""; newSpecialHours = ""
                },
            )

            PrimaryButton(
                label   = if (settingsLoaded) "Save Time Off Settings" else "Loading settings…",
                enabled = settingsLoaded,
                onClick = {
                    scope.launch {
                        val updated = (settingsData ?: BusinessSettings()).copy(
                            businessName        = businessName,
                            businessEmail       = businessEmail,
                            businessPhone       = businessPhone,
                            businessAddress     = businessAddress,
                            businessHours       = businessHours,
                            observedUsHolidays  = observedHolidays.toList(),
                            companyHolidays     = companyHolidays,
                            specialHours        = specialHours,
                        )
                        vm.saveSettings(updated)
                    }
                },
                modifier = Modifier.fillMaxWidth(),
            )
        }
    }
}

private val HOLIDAY_DATE_REGEX = Regex("""^\d{4}-\d{2}-\d{2}$""")

/**
 * A special-hours entry (15.5) is addable only with a valid YYYY-MM-DD date AND
 * non-blank hours that contain no pipe (the "date|hours" encoding must stay
 * parseable). Pure; unit-tested.
 */
internal fun specialHoursAddEnabled(date: String, hours: String): Boolean =
    HOLIDAY_DATE_REGEX.matches(date) && hours.isNotBlank() && !hours.contains('|')

/**
 * The special-hours add row (15.5): two fields + an "Add" GhostButton gated by
 * [specialHoursAddEnabled]. Extracted to an internal composable so the real
 * widget + its enablement gate can be rendered directly by the desktop compose
 * UI test (behavior-neutral: same fields, same gate, same Add callback).
 */
@Composable
internal fun SpecialHoursEditorRow(
    date: String,
    onDate: (String) -> Unit,
    hours: String,
    onHours: (String) -> Unit,
    onAdd: () -> Unit,
) {
    val dims = AuntieTheme.dims
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(dims.space2),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        BottomBorderField(
            value = date,
            onValueChange = onDate,
            label = "Date (YYYY-MM-DD)",
            modifier = Modifier.weight(1f),
        )
        BottomBorderField(
            value = hours,
            onValueChange = onHours,
            label = "Hours (e.g. 08:00-12:00)",
            modifier = Modifier.weight(1f),
        )
        GhostButton(
            label   = "Add",
            enabled = specialHoursAddEnabled(date, hours),
            onClick = onAdd,
        )
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Small shared row + tile composables
// ─────────────────────────────────────────────────────────────────────────────

@Composable
private fun EmptyHintLine(text: String, color: androidx.compose.ui.graphics.Color) {
    Text(text, style = AuntieTheme.typography.bodySmall, color = color)
}

/**
 * Integration row. The status is STATIC configuration in source, not a live health
 * check, so it is labelled "Configured" with no live glow (fail-loud: never present
 * fake live health).
 */
@Composable
private fun IntegrationRow(
    name: String,
    description: String,
    state: IntegrationHealthState,
) {
    val iconTone = when (name) {
        "Firestore"     -> AuntieStatusTone.Teal
        "n8n Webhooks"  -> AuntieStatusTone.Orange
        "FCM"           -> AuntieStatusTone.Purple
        "Twilio Studio" -> AuntieStatusTone.Success
        else            -> AuntieStatusTone.Neutral
    }
    AuntieSettingRow(
        title = name,
        description = description,
        leadingIcon = Lucide.LayoutGrid,
        iconTone = iconTone,
        showDivider = true,
        trailing = {
            AuntieStatusPill(
                label = integrationPillLabel(state),
                tone = integrationPillTone(state),
                showDot = true,
                glow = state == IntegrationHealthState.CHECKING,
                mono = true,
            )
        },
    )
}

/**
 * Mockup-only Scheduling row. Read-only: the toggle is disabled because no backend
 * field exists yet (fail-loud, never faked).
 */
@Composable
private fun SchedulingPlaceholderRow(
    title: String,
    description: String,
    showDivider: Boolean,
) {
    AuntieSettingRow(
        title = title,
        description = description,
        leadingIcon = Lucide.CalendarClock,
        iconTone = AuntieStatusTone.Muted,
        showDivider = showDivider,
        trailing = {
            AuntieToggle(checked = false, onCheckedChange = {}, enabled = false)
        },
    )
}

/**
 * Profile avatar. Read-only until a real upload pipeline lands (flags.settingsProfilePicUpload).
 * The camera badge is a non-interactive hint, not a working upload button.
 */
@Composable
private fun ProfileAvatar(
    photoUrl: String,
    initials: String,
) {
    val c = AuntieTheme.colors
    Box(
        modifier = Modifier.size(88.dp),
        contentAlignment = Alignment.Center,
    ) {
        AuntieAvatar(
            imageUrl = photoUrl.takeIf { it.isNotBlank() },
            initials = initials.takeIf { it.isNotBlank() },
            glyph = if (initials.isBlank()) Lucide.User else null,
            size = 88.dp,
        )
        // Camera badge: visual affordance only (upload is gated, see ProfilePanel banner).
        Box(
            modifier = Modifier
                .align(Alignment.BottomEnd)
                .size(28.dp)
                .clip(RoundedCornerShape(999.dp))
                .background(c.surface2),
            contentAlignment = Alignment.Center,
        ) {
            Icon(
                imageVector = Lucide.Camera,
                contentDescription = "Picture upload not available",
                tint = c.textFaint,
                modifier = Modifier.size(14.dp),
            )
        }
    }
}

private val US_HOLIDAYS = listOf(
    "new_years"      to "New Year's Day",
    "mlk"            to "Martin Luther King Jr. Day",
    "presidents"     to "Presidents' Day",
    "memorial"       to "Memorial Day",
    "juneteenth"     to "Juneteenth",
    "independence"   to "Independence Day",
    "labor"          to "Labor Day",
    "columbus"       to "Columbus Day",
    "veterans"       to "Veterans Day",
    "thanksgiving"   to "Thanksgiving",
    "christmas"      to "Christmas Day",
)

private class FirestoreClientSettingsDataSource(
    private val client: FirestoreClient,
) : com.tribetails.auntieos.web.data.AuntieDataSource {
    override fun invoicesStream() = client.invoicesStream()
    override fun kinfolkStream()  = client.kinfolkStream()
    override fun sessionsStream() = client.sessionsStream()
    override fun paymentsStream() = client.paymentsStream()
    override suspend fun recordPayment(payment: com.tribetails.auntieos.web.data.Payment) = client.recordPayment(payment)
    override fun businessSettingsStream() = client.businessSettingsStream()
    override suspend fun saveBusinessSettings(settings: BusinessSettings) = client.saveBusinessSettings(settings)
    override suspend fun approveBooking(bookingId: String) = client.approveBooking(bookingId)
    override suspend fun rejectBooking(bookingId: String)  = client.rejectBooking(bookingId)
    override suspend fun createBooking(booking: com.tribetails.auntieos.web.data.KinCareSession) =
        client.createBookingRequest(booking)
    override fun mediaStream(entityId: String, entityType: String) = client.mediaStream(entityId, entityType)
    override suspend fun uploadMedia(entityId: String, entityType: String, bytes: ByteArray, mimeType: String) =
        client.uploadMedia(entityId, entityType, bytes, mimeType)
    override suspend fun deleteMedia(mediaId: String) = client.deleteMedia(mediaId)

    override fun reportForSessionStream(sessionId: String) = client.reportForSessionStream(sessionId)
    override suspend fun saveReport(report: com.tribetails.auntieos.web.data.KinCareReport) = client.saveReport(report)
    override suspend fun sendReport(report: com.tribetails.auntieos.web.data.KinCareReport, session: com.tribetails.auntieos.web.data.KinCareSession) = client.sendReport(report, session)
    override fun trainingDocsStream() = client.trainingDocsStream()
    override fun vetClinicsStream() = client.vetClinicsStream()
    override suspend fun createVetClinic(clinic: com.tribetails.auntieos.web.data.VetClinic) = client.createVetClinic(clinic)
    override suspend fun updateVetClinic(clinic: com.tribetails.auntieos.web.data.VetClinic) = client.updateVetClinic(clinic)
    override suspend fun deleteVetClinic(id: String) = client.deleteVetClinic(id)
    override suspend fun logActivity(entry: com.tribetails.auntieos.web.data.ActivityLogEntry) = client.logActivity(entry)
    override fun bookingNotesStream(kinfolkId: String, bookingId: String) =
        client.bookingNotesStream(kinfolkId, bookingId, internal = false)
    override fun bookingInternalNotesStream(kinfolkId: String, bookingId: String) =
        client.bookingNotesStream(kinfolkId, bookingId, internal = true)
    override suspend fun addBookingNote(kinfolkId: String, bookingId: String, body: String) =
        client.addBookingNote(kinfolkId, bookingId, body, internal = false)
    override suspend fun addInternalBookingNote(kinfolkId: String, bookingId: String, body: String) =
        client.addBookingNote(kinfolkId, bookingId, body, internal = true)
    override fun kinTaleCommentsStream(taleId: String, kinfolkId: String) =
        client.kinTaleCommentsStream(taleId, kinfolkId)
    override suspend fun addKinTaleComment(taleId: String, kinfolkId: String, body: String, parentCommentId: String?) =
        client.addKinTaleComment(taleId, kinfolkId, body, parentCommentId)
}
