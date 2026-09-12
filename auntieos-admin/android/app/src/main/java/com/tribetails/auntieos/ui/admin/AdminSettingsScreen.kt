package com.tribetails.auntieos.ui.admin

import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
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
import androidx.compose.material3.Icon
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.compose.foundation.layout.RowScope
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.sp
import com.composables.icons.lucide.CirclePlus
import com.composables.icons.lucide.Clock
import com.composables.icons.lucide.Globe
import com.composables.icons.lucide.Phone
import com.composables.icons.lucide.Plus
import com.composables.icons.lucide.Search
import com.composables.icons.lucide.StickyNote
import com.tribetails.auntieos.ui.components.AuntieSearchField
import com.tribetails.auntieos.ui.components.GlassSurface
import androidx.lifecycle.viewmodel.compose.viewModel
import com.composables.icons.lucide.Archive
import com.composables.icons.lucide.Bell
import com.composables.icons.lucide.BellOff
import com.composables.icons.lucide.Check
import com.composables.icons.lucide.CloudSun
import com.composables.icons.lucide.Wallet
import com.composables.icons.lucide.Building2
import com.composables.icons.lucide.Lock
import com.composables.icons.lucide.LockOpen
import com.composables.icons.lucide.Users
import com.composables.icons.lucide.X
import com.composables.icons.lucide.CalendarClock
import com.composables.icons.lucide.Camera
import com.composables.icons.lucide.ChevronLeft
import com.composables.icons.lucide.KeyRound
import com.composables.icons.lucide.LayoutGrid
import com.composables.icons.lucide.Lucide
import com.composables.icons.lucide.MapPin
import com.composables.icons.lucide.Pencil
import com.composables.icons.lucide.Trash2
import com.composables.icons.lucide.ExternalLink
import com.composables.icons.lucide.ArrowUp
import com.composables.icons.lucide.ArrowDown
import com.composables.icons.lucide.ClipboardList
import com.composables.icons.lucide.ListOrdered
import com.tribetails.auntieos.ui.components.AuntieIconButton
import com.composables.icons.lucide.PawPrint
import com.composables.icons.lucide.Plane
import com.composables.icons.lucide.RefreshCw
import com.composables.icons.lucide.AtSign
import com.composables.icons.lucide.ShieldCheck
import com.composables.icons.lucide.Stethoscope
import com.composables.icons.lucide.Tag
import com.composables.icons.lucide.Webhook
import com.tribetails.auntieos.data.model.TrackingAccuracy
import com.tribetails.auntieos.data.model.PortalHomeSection
import com.tribetails.auntieos.ui.NavigationSettingsPanel
import com.tribetails.auntieos.ui.branding.brandingDirty
import com.tribetails.auntieos.ui.branding.withBranding
import com.tribetails.auntieos.ui.branding.logoState
import com.tribetails.auntieos.ui.branding.LogoState
import com.tribetails.auntieos.ui.components.AuntieAvatar
import com.tribetails.auntieos.ui.components.AuntieBanner
import com.tribetails.auntieos.ui.components.AuntieBannerTone
import com.tribetails.auntieos.ui.components.AuntieDropdownField
import com.tribetails.auntieos.ui.components.AuntieField
import com.tribetails.auntieos.ui.components.AuntieFieldLabel
import com.tribetails.auntieos.ui.components.AuntieIconTile
import com.tribetails.auntieos.ui.components.AuntieModal
import com.tribetails.auntieos.ui.components.AuntieRadio
import com.tribetails.auntieos.ui.components.AuntieSaveBar
import com.tribetails.auntieos.ui.components.AuntieScreenScaffold
import com.tribetails.auntieos.ui.components.AuntieSettingRow
import com.tribetails.auntieos.ui.components.AuntieStatusPill
import com.tribetails.auntieos.ui.components.AuntieStatusTone
import com.tribetails.auntieos.ui.components.AuntieTextBtn
import com.tribetails.auntieos.ui.components.AuntieToggle
import com.tribetails.auntieos.ui.components.DenPanel
import com.tribetails.auntieos.ui.components.DenScreenHeading
import com.tribetails.auntieos.ui.components.EmptyHint
import com.tribetails.auntieos.ui.components.GhostButton
import androidx.compose.ui.graphics.Brush
import com.tribetails.auntieos.ui.theme.BrandCream
import com.tribetails.auntieos.ui.theme.TribeGradients
import com.tribetails.auntieos.ui.components.LoadingHint
import com.tribetails.auntieos.ui.components.PrimaryButton
import com.tribetails.auntieos.ui.components.StatusToast
import com.tribetails.auntieos.ui.components.ToastKind
import com.tribetails.auntieos.AuntieOSApp
import com.tribetails.auntieos.data.model.NotificationCatalogEntry
import com.tribetails.auntieos.data.model.NotifAudience
import com.tribetails.auntieos.data.model.inAudience
import com.tribetails.auntieos.data.model.sectionedNotifEntries
import com.tribetails.auntieos.data.model.sharedCopyCaption
import com.tribetails.auntieos.data.model.withStreamChannel
import com.tribetails.auntieos.data.model.withStreamChannelLock
import com.tribetails.auntieos.data.model.withStreamEnabled
import com.tribetails.auntieos.data.model.withStreamLockedEnabled
import com.tribetails.auntieos.data.model.NotificationMatrix
import com.tribetails.auntieos.data.model.NotificationDeliveryEvidence
import com.tribetails.auntieos.data.model.NotifBadgeTone
import com.tribetails.auntieos.data.model.NotifDeliveryTone
import com.tribetails.auntieos.data.model.BusinessAdminRoster
import com.tribetails.auntieos.data.model.businessAdminLines
import com.tribetails.auntieos.data.model.businessAdminSourceNote
import com.tribetails.auntieos.data.model.notifDeliveryPhrase
import com.tribetails.auntieos.data.model.notifReachesBusinessAdmins
import com.tribetails.auntieos.data.model.notifMergeFieldNames
import com.tribetails.auntieos.data.model.notifRecipientLines
import com.tribetails.auntieos.data.model.notifRowBadges
import com.tribetails.auntieos.data.model.notifTemplateLines
import com.tribetails.auntieos.data.model.VetClinic
import com.tribetails.auntieos.data.model.NotificationOverride
// Tags (2026-07-19): the vocabulary panel edits business_settings through the
// same pure helpers the profile assign fields use, so the two surfaces cannot
// disagree on the name shape, the caps, or the error copy.
import com.tribetails.auntieos.data.model.BusinessSettings
import com.tribetails.auntieos.data.model.DEFAULT_TAG_COLOR
import com.tribetails.auntieos.data.model.TAG_PALETTE
import com.tribetails.auntieos.data.model.TagColor
import com.tribetails.auntieos.data.model.TagDef
import com.tribetails.auntieos.data.model.TagScope
import com.tribetails.auntieos.data.model.addTag
import com.tribetails.auntieos.data.model.editTag
import com.tribetails.auntieos.data.model.normalizeTagName
import com.tribetails.auntieos.data.model.removeTag
import com.tribetails.auntieos.data.model.withHouseholdTagDefs
import com.tribetails.auntieos.data.model.withPetTagDefs
import com.tribetails.auntieos.data.model.withHomeSections
import com.tribetails.auntieos.ui.components.AuntieChip
import com.tribetails.auntieos.ui.components.TagChip
import com.tribetails.auntieos.ui.components.color
import com.tribetails.auntieos.ui.components.tagToneRole
import com.tribetails.auntieos.ui.theme.AuntieTheme
import kotlinx.coroutines.launch

/**
 * Admin Settings, rebuilt in the Den aesthetic by adapting the redesigned web
 * SettingsScreen while preserving the Android [AdminSettingsViewModel] contract.
 *
 * The screen keeps every existing piece of settings logic and save wiring intact
 * and only reskins it: a serif [DenScreenHeading] over stacked [DenPanel] sections
 * (Profile, Business operations, Business hours, Notifications, Scheduling,
 * Integrations, Security, Time off, Developer tools). Each section uses the Den
 * row vocabulary (AuntieSettingRow / AuntieToggle / AuntieFieldLabel).
 *
 * Fail-loud notes:
 *  - Google Calendar sync has a real backend (syncGoogleCalendarBusyEvents) and a
 *    real UI (SchedulingOptionsScreen's GoogleCalendarSyncCard). Selecting that
 *    section calls onNavigateToSchedule to open the real screen there, instead of
 *    an inline panel.
 *  - Unlike web, Android DOES have a real avatar upload pipeline (uploadAvatar),
 *    so the profile picture control stays LIVE here, not gated.
 *  - Integration verdicts come from `getIntegrationsHealth`, the same answer the
 *    React admin renders, so the two surfaces cannot disagree about whether a
 *    key is set. Only Firestore reachability and the FCM registration token are
 *    still decided on the device, because both are facts about this handset that
 *    no server can see. The two rows that used to be hard-coded pills ("n8n
 *    Webhooks", retired more than a year before, and "Twilio Studio", never
 *    checked) are gone: a server-side question answered from a literal is not a
 *    status, it is a decoration.
 */
/**
 * The Business Settings sections, one per detail panel. A phone can't take the
 * web admin's left rail, so this screen is a native list -> detail drill-down
 * instead of one endless scroll: this enum drives BOTH the tappable list
 * [AdminSettingsSectionNav] renders and the `when` in [AdminSettingsScreen] that
 * renders the matching panel. Order mirrors the web Settings section nav.
 *
 * [blurb] is no longer drawn (issue #755 pass): the settings mock's `.secnav`
 * is an icon and a label per row, and the operator's 2026-09-11 ruling on
 * explanatory copy (#752) applies to a row's sub line as it does to a panel's.
 * The field stays on the constructor so every entry, including ones added by
 * PRs in flight, keeps compiling; it is the one-line description a future
 * tooltip would carry.
 */
internal enum class SettingsSection(
    val title: String,
    val blurb: String,
    val icon: ImageVector,
) {
    Branding("Branding", "Logo, app name, and home greeting", Lucide.Pencil),
    Navigation("Navigation", "Rename and reorder your nav sections", Lucide.LayoutGrid),
    // ISSUE #519: the booking-configuration block, the business time zone and the
    // bookable time blocks had no control on any admin surface. They are their own
    // section rather than more rows on Business operations, because they answer a
    // different question: this is what a booking is ALLOWED to be, Business
    // operations is what happens once you are out on the visit. Panels live in
    // `BusinessRulesPanels.kt`.
    // ISSUE #755: the KinCare types rate card, `business_settings.serviceRates`
    // plus `serviceDurations`. Decoded, diffed and read by the schedule, the
    // booking wizard and the package builder, and until this section nothing
    // on the phone could edit it. Sits before Booking rules as it does on web
    // (KinCare Settings, then Booking rules). Panel lives in
    // `KinCareTypesPanel.kt`.
    KinCareTypes("KinCare types", "Names, lengths and prices the booking screen offers", Lucide.ListOrdered),
    BookingRules("Booking rules", "Time zone, booking modes, and bookable blocks", Lucide.CalendarClock),
    BusinessOperations("Business operations", "Booking modes, tracking, retention", Lucide.Building2),
    Payments("Payments", "Handles clients pay you through", Lucide.Wallet),
    WeatherArea("Weather area", "Coverage area for the weather widgets", Lucide.CloudSun),
    BusinessHours("Business hours", "When the Den is open for visits", Lucide.CalendarClock),
    CalendarSync("Google Calendar sync", "Import busy events as private blocks", Lucide.RefreshCw),
    TimeOff("Time off", "Holidays observed and Den closures", Lucide.Plane),
    Notifications("Notifications", "The per-notification channel gate", Lucide.Bell),
    // "Scheduling" is the settings mock's title for these three switches
    // (issue #755 pass); web's panel of the same name sits under Business
    // profile.
    BookingBehavior("Scheduling", "Auto-confirm and drag-to-snap", Lucide.Check),
    Integrations("Integrations", "Connected services and their status", Lucide.Webhook),
    Tags("Tags", "Household and pet tag banks", Lucide.Tag),
    // ISSUE #397 M10: the kinfolk PORTAL's Home layout (not this app's own
    // nav, which is the `Navigation` section above). Reorder, show/hide, and
    // cap each section on `business_settings.mytribePortal.home.sections` —
    // the array a kinfolk's Home screen actually renders.
    PortalHomeLayout("Home layout", "Reorder the kinfolk portal's Home sections", Lucide.ClipboardList),
    VetClinics("Vet clinics", "The shared vet clinic bank", Lucide.Stethoscope),
}

/**
 * The list <-> detail shell for Admin Settings. Deliberately ViewModel-free and
 * state-hoisted (like the web `SectionNav`), so the navigation itself is unit
 * testable without standing up the heavy [AdminSettingsViewModel]:
 *
 *  - [selected] null  -> the section LIST: an optional [listHeader] (the
 *    navigate-away buttons) above the mock's `.secnav`, a glass panel of one
 *    tappable icon-and-label row per section (issue #755 pass).
 *  - [selected] set   -> that section's DETAIL: an "All settings" affordance
 *    back to the list, then the caller's [detail] slot for that section. A
 *    [BackHandler] routes the system back gesture to the list too, so back never
 *    jumps straight out of Settings while a section is open.
 *
 * Only ONE section renders at a time, so there is no long scroll; each panel
 * keeps its own scroll for its own content.
 */
@Composable
internal fun AdminSettingsSectionNav(
    selected: SettingsSection?,
    onSelect: (SettingsSection) -> Unit,
    onBackToList: () -> Unit,
    detail: @Composable (SettingsSection) -> Unit,
    modifier: Modifier = Modifier,
    listHeader: @Composable ColumnScope.() -> Unit = {},
) {
    val dims = AuntieTheme.dims
    val colors = AuntieTheme.colors

    if (selected == null) {
        Column(
            modifier = modifier
                .fillMaxSize()
                .padding(dims.space4)
                .verticalScroll(rememberScrollState())
        ) {
            DenScreenHeading(
                kicker = "The Den · Settings",
                title = "How the Den",
                accentTail = "runs.",
                subtitle = "Pick a section to view and edit it. Each one saves on its own.",
            )
            Spacer(Modifier.height(dims.space5))

            listHeader()
            Spacer(Modifier.height(dims.space4))

            // The mock's `.secnav`: a glass panel one radius step under a
            // DenPanel, 10dp inside, each row a 17dp glyph and a 14sp label
            // at 10dp by 12dp on an 11dp corner. No sub line and no chevron:
            // the mock draws neither, and the row itself is the affordance.
            GlassSurface(cornerRadius = 18.dp, modifier = Modifier.fillMaxWidth()) {
                Column(Modifier.padding(10.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    SettingsSection.entries.forEach { section ->
                        Row(
                            modifier = Modifier
                                .fillMaxWidth()
                                .clip(RoundedCornerShape(11.dp))
                                .clickable { onSelect(section) }
                                .padding(horizontal = 12.dp, vertical = 10.dp),
                            horizontalArrangement = Arrangement.spacedBy(11.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Icon(
                                imageVector = section.icon,
                                contentDescription = null,
                                tint = colors.textDim,
                                modifier = Modifier.size(17.dp),
                            )
                            Text(
                                text = section.title,
                                style = AuntieTheme.typography.bodyMedium.copy(fontWeight = FontWeight.Medium),
                                color = colors.textDim,
                            )
                        }
                    }
                }
            }
        }
    } else {
        BackHandler { onBackToList() }
        Column(
            modifier = modifier
                .fillMaxSize()
                .padding(dims.space4)
                .verticalScroll(rememberScrollState())
        ) {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .clip(RoundedCornerShape(10.dp))
                    .clickable(onClick = onBackToList)
                    .padding(vertical = dims.space2),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Icon(
                    imageVector = Lucide.ChevronLeft,
                    contentDescription = null,
                    tint = colors.textDim,
                    modifier = Modifier.size(18.dp),
                )
                Spacer(Modifier.width(dims.space1))
                Text(
                    text = "All settings",
                    style = AuntieTheme.typography.labelMedium,
                    color = colors.textDim,
                )
            }
            Spacer(Modifier.height(dims.space3))

            detail(selected)
        }
    }
}

@Composable
fun AdminSettingsScreen(
    onBack: () -> Unit,
    onNavigateToAccount: () -> Unit = {},
    onNavigateToNotificationPrefs: () -> Unit = {},
    /**
     * Where the Google Calendar OAuth connect flow lives (Scheduling options).
     * Two callers inside this screen: the Calendar Sync entry and the
     * Integrations panel's Google Calendar row, both handing off rather than
     * growing a second copy of the flow.
     */
    onNavigateToSchedule: () -> Unit = {},
    viewModel: AdminSettingsViewModel = viewModel<AdminSettingsViewModel>()
) {
    val uiState by viewModel.uiState.collectAsState()
    val profile = uiState.profile
    val context = LocalContext.current
    val dims = AuntieTheme.dims

    val avatarPicker = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.PickVisualMedia()
    ) { uri ->
        if (uri != null) viewModel.uploadAvatar(context, uri)
    }

    // 17.2 Branding: separate picker for the workspace logo (persists to the
    // business_settings doc, not the user profile). Null uri = cancelled = no-op.
    val logoPicker = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.PickVisualMedia()
    ) { uri ->
        if (uri != null) viewModel.uploadLogo(context, uri)
    }

    var toastMessage by remember { mutableStateOf("") }
    var toastVisible by remember { mutableStateOf(false) }
    var toastKind by remember { mutableStateOf(ToastKind.Info) }

    LaunchedEffect(Unit) {
        viewModel.loadBusinessSettings()
        viewModel.loadBusinessHours()
        viewModel.loadUserProfile()
        viewModel.loadIntegrations()
    }

    LaunchedEffect(uiState.profileSaveSuccess) {
        if (uiState.profileSaveSuccess) {
            toastMessage = "Profile saved"
            toastKind = ToastKind.Success
            toastVisible = true
            viewModel.clearProfileSaveSuccess()
        }
    }

    LaunchedEffect(uiState.saveSuccess) {
        if (uiState.saveSuccess) {
            toastMessage = "Settings saved"
            toastKind = ToastKind.Success
            toastVisible = true
            viewModel.clearSaveSuccess()
        }
    }

    LaunchedEffect(uiState.passwordResetSent) {
        if (uiState.passwordResetSent) {
            toastMessage = "Password reset email sent"
            toastKind = ToastKind.Success
            toastVisible = true
            viewModel.clearPasswordResetSent()
        }
    }

    LaunchedEffect(uiState.error) {
        val err = uiState.error
        if (err != null) {
            toastMessage = err
            toastKind = ToastKind.Error
            toastVisible = true
            viewModel.clearError()
        }
    }

    // Which section is open. null = the section LIST; set = that section's
    // detail. Held here (not in the ViewModel) because it is pure view state;
    // the ViewModel-held businessSettings is untouched by switching sections, so
    // an edit in one section persists (each panel instant-saves) regardless of
    // where the operator navigates next.
    var selectedSection by remember { mutableStateOf<SettingsSection?>(null) }

    Box(modifier = Modifier.fillMaxSize()) {
        AuntieScreenScaffold(
            title = selectedSection?.title ?: "Admin Settings",
            // Back steps out of an open section to the list first; only from the
            // list itself does it leave Settings entirely.
            onBack = { if (selectedSection != null) selectedSection = null else onBack() },
            imePaddingEnabled = true,
        ) {
            AdminSettingsSectionNav(
                selected = selectedSection,
                onSelect = { section ->
                    // Google Calendar sync is a real, live screen of its own
                    // (SchedulingOptionsScreen), not an inline detail panel here.
                    if (section == SettingsSection.CalendarSync) {
                        onNavigateToSchedule()
                    } else {
                        selectedSection = section
                    }
                },
                onBackToList = { selectedSection = null },
                listHeader = {
                    // The operator's OWN account + receive-prefs each live on their
                    // own screen; kept at the top of the section list as global
                    // actions rather than as sections.
                    PrimaryButton(
                        label = "Your account: profile and login",
                        onClick = onNavigateToAccount,
                    )
                    Spacer(Modifier.height(dims.space3))
                    PrimaryButton(
                        label = "Your notifications: what you receive",
                        onClick = onNavigateToNotificationPrefs,
                    )
                },
                detail = { section ->
                    when (section) {
                        SettingsSection.Branding -> BrandingPanel(
                            settings = uiState.businessSettings,
                            stagedLogoUrl = uiState.stagedLogoUrl,
                            isUploadingLogo = uiState.isUploadingLogo,
                            isLoading = uiState.isLoading,
                            onPickLogo = {
                                logoPicker.launch(
                                    PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly)
                                )
                            },
                            onRemoveLogo = { viewModel.stageLogoRemoval() },
                            onSaveBranding = { wm, tag, greet, tail ->
                                viewModel.saveBranding(wm, tag, greet, tail)
                            },
                        )

                        SettingsSection.Navigation -> NavigationSettingsPanel(
                            navConfig = uiState.profile.navConfig,
                            canSave = uiState.profile.uid.isNotBlank(),
                            onSave = { viewModel.saveNavConfig(it) },
                        )

                        SettingsSection.KinCareTypes -> KinCareTypesPanel(
                            settings = uiState.businessSettings,
                            isLoading = uiState.isLoading,
                            onSettingsChange = { viewModel.updateBusinessSettings(it) },
                        )

                        SettingsSection.BookingRules -> BookingRulesPanel(
                            settings = uiState.businessSettings,
                            isLoading = uiState.isLoading,
                            onSettingsChange = { viewModel.updateBusinessSettings(it) },
                        )
                        // ISSUE #519 added the second panel: the four GPS/records
                        // fields with no control anywhere, plus the two option
                        // LISTS behind the dropdowns in the first one. Two panels
                        // rather than one longer one, because they save separately.
                        SettingsSection.BusinessOperations -> Column(
                            verticalArrangement = Arrangement.spacedBy(dims.space4),
                        ) {
                            BusinessOperationsPanel(
                                settings = uiState.businessSettings,
                                isLoading = uiState.isLoading,
                                onSettingsChange = { viewModel.updateBusinessSettings(it) },
                            )
                            VisitRecordsPanel(
                                settings = uiState.businessSettings,
                                isLoading = uiState.isLoading,
                                onSettingsChange = { viewModel.updateBusinessSettings(it) },
                            )
                        }

                        // A8 Payments: the peer-to-peer handles clients pay through;
                        // they render on the invoice "How to pay" section + the PDF.
                        SettingsSection.Payments -> PaymentOptionsPanel(
                            settings = uiState.businessSettings,
                            onSettingsChange = { viewModel.updateBusinessSettings(it) },
                        )

                        // A8 W16/W17: the weather widgets' coverage area (city/metro/
                        // ZIP, not a street address).
                        SettingsSection.WeatherArea -> WeatherAreaPanel(
                            settings = uiState.businessSettings,
                            onSettingsChange = { viewModel.updateBusinessSettings(it) },
                        )

                        SettingsSection.BusinessHours -> BusinessHoursPanel(
                            hours = uiState.businessHours,
                            onRowChange = viewModel::setBusinessHourRow,
                            onSave = { viewModel.updateBusinessHours(uiState.businessHours) },
                        )

                        // Unreachable: onSelect above routes this section to the real
                        // SchedulingOptionsScreen via onNavigateToSchedule instead of
                        // opening a detail panel. Kept so this `when` stays exhaustive.
                        SettingsSection.CalendarSync -> Unit

                        SettingsSection.TimeOff -> TimeOffPanel(
                            settings = uiState.businessSettings,
                            onSettingsChange = { updated ->
                                viewModel.updateBusinessSettings(
                                    uiState.businessSettings.copy(
                                        observedUsHolidays = updated.observedUsHolidays,
                                        companyHolidays = updated.companyHolidays,
                                        specialHours = updated.specialHours,
                                    )
                                )
                            },
                        )

                        // Per-notification matrix = the GATE. For every notification
                        // the operator picks, per channel, Enable / Disable / Lock.
                        // Enable makes a channel available in each recipient's own
                        // notification settings; Disable hides it; Lock forces it on.
                        SettingsSection.Notifications -> NotificationMatrixPanel()

                        SettingsSection.BookingBehavior -> BookingBehaviorPanel(
                            settings = uiState.businessSettings,
                            onSettingsChange = { viewModel.updateBusinessSettings(it) },
                        )

                        SettingsSection.Integrations -> IntegrationsPanel(
                            health = uiState.integrationsHealth,
                            loading = uiState.integrationsLoading,
                            error = uiState.integrationsError,
                            deviceProbes = uiState.deviceProbes,
                            onRetry = { viewModel.loadIntegrations() },
                            onOpenGoogleCalendar = onNavigateToSchedule,
                        )

                        // Tags: the two vocabularies (household + pet) the Den offers
                        // on a profile, shared banks the directory picks from.
                        SettingsSection.Tags -> TagVocabularyPanel(
                            settings = uiState.businessSettings,
                            isLoading = uiState.isLoading,
                            onSettingsChange = { viewModel.updateBusinessSettings(it) },
                            removeBusy = uiState.tagRemoveBusy,
                            removeMessage = uiState.tagRemoveMessage,
                            removeError = uiState.tagRemoveError,
                            onRemoveTag = { scope, name -> viewModel.removeBusinessTag(scope, name) },
                            onDismissRemoveFeedback = { viewModel.clearTagRemoveFeedback() },
                        )

                        // ISSUE #397 M10: the kinfolk portal's Home layout,
                        // sharing `updateBusinessSettings`'s diff-and-save with
                        // every other slice of this doc.
                        SettingsSection.PortalHomeLayout -> HomeLayoutPanel(
                            settings = uiState.businessSettings,
                            onSettingsChange = { viewModel.updateBusinessSettings(it) },
                        )

                        SettingsSection.VetClinics -> VetClinicsPanel()
                    }
                },
            )
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
// Branding (17.2) - editable logo + app name/tagline + Home greeting
// ─────────────────────────────────────────────────────────────────────────────

@Composable
private fun BrandingPanel(
    settings: com.tribetails.auntieos.data.model.BusinessSettings,
    stagedLogoUrl: String?,
    isUploadingLogo: Boolean,
    isLoading: Boolean,
    onPickLogo: () -> Unit,
    onRemoveLogo: () -> Unit,
    onSaveBranding: (wordmark: String, tagline: String, greeting: String, accentTail: String) -> Unit,
) {
    val c = AuntieTheme.colors
    val dims = AuntieTheme.dims

    // Local edit state for the text fields, re-seeded whenever the saved value
    // changes (after a Save the VM updates uiState and these re-seed - matches web).
    var wordmark by remember(settings.brandWordmark) { mutableStateOf(settings.brandWordmark) }
    var tagline by remember(settings.brandTagline) { mutableStateOf(settings.brandTagline) }
    var greeting by remember(settings.homeGreeting) { mutableStateOf(settings.homeGreeting) }
    var accentTail by remember(settings.homeAccentTail) { mutableStateOf(settings.homeAccentTail) }

    // Effective logo = the staged upload/removal if pending, else the saved value.
    // Logo and text both commit together on Save (stage-then-save, like web).
    val effectiveLogo = stagedLogoUrl ?: settings.logoUrl
    val gradientSeed = settings.brandWordmark.ifBlank { "AuntieOS" }
    val dirty = brandingDirty(
        settings,
        settings.withBranding(effectiveLogo, wordmark, tagline, greeting, accentTail),
    )

    DenPanel(
        title = "Branding",
        subtitle = "Your logo, app name, and Home greeting. Leave any field blank to keep the default.",
    ) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(dims.space4),
        ) {
            // Logo preview. AuntieAvatar shows the staged/saved image and, on a broken
            // URL, falls back to the PawPrint glyph (fail-visible, never an empty hole).
            AuntieAvatar(
                imageUrl = effectiveLogo.ifBlank { null },
                glyph = Lucide.PawPrint,
                size = 72.dp,
                shape = CircleShape,
                gradientSeed = gradientSeed,
            )
            Column(
                modifier = Modifier.weight(1f),
                verticalArrangement = Arrangement.spacedBy(dims.space2),
            ) {
                // Names WHICH empty state this is. A cleared logo and one that was
                // never set are both a blank url, so without this the operator who
                // just pressed Remove sees exactly what a fresh install shows.
                Text(
                    when (logoState(effectiveLogo, settings.logoRemovedAt)) {
                        LogoState.SET -> "Logo set"
                        LogoState.REMOVED -> "Logo removed"
                        LogoState.NEVER_SET -> "No logo set yet"
                    },
                    color = c.textDim,
                )
                AuntieTextBtn(onClick = onPickLogo, enabled = !isUploadingLogo) {
                    AuntieIconTile(icon = Lucide.Camera, tone = AuntieStatusTone.Orange, size = 22.dp)
                    Spacer(Modifier.width(dims.space2))
                    Text(
                        when {
                            isUploadingLogo -> "Uploading…"
                            effectiveLogo.isBlank() -> "Upload logo"
                            else -> "Replace logo"
                        }
                    )
                }
                if (effectiveLogo.isNotBlank()) {
                    AuntieTextBtn(onClick = onRemoveLogo, enabled = !isUploadingLogo) {
                        Text("Remove logo", color = c.textDim)
                    }
                }
            }
        }

        Spacer(Modifier.height(dims.space4))

        AuntieField(
            value = wordmark,
            onValueChange = { wordmark = it },
            label = "App name (blank = AuntieOS)",
            modifier = Modifier.fillMaxWidth(),
        )
        Spacer(Modifier.height(dims.space3))
        AuntieField(
            value = tagline,
            onValueChange = { tagline = it },
            label = "Tagline (blank = Tribe Tails Care)",
            modifier = Modifier.fillMaxWidth(),
        )
        Spacer(Modifier.height(dims.space3))
        AuntieField(
            value = greeting,
            onValueChange = { greeting = it },
            label = "Home greeting (blank = time of day)",
            modifier = Modifier.fillMaxWidth(),
        )
        Spacer(Modifier.height(dims.space3))
        AuntieField(
            value = accentTail,
            onValueChange = { accentTail = it },
            label = "Home accent word (blank = Auntie.)",
            modifier = Modifier.fillMaxWidth(),
        )

        Spacer(Modifier.height(dims.space4))

        PrimaryButton(
            label = if (isUploadingLogo) "Uploading logo…" else "Save Branding",
            onClick = { onSaveBranding(wordmark, tagline, greeting, accentTail) },
            modifier = Modifier.fillMaxWidth(),
            enabled = dirty && !isLoading && !isUploadingLogo,
        )
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Business operations (GPS / liability / ETA / draft retention)
// ─────────────────────────────────────────────────────────────────────────────

@Composable
private fun BusinessOperationsPanel(
    settings: com.tribetails.auntieos.data.model.BusinessSettings,
    isLoading: Boolean,
    onSettingsChange: (com.tribetails.auntieos.data.model.BusinessSettings) -> Unit,
) {
    val c = AuntieTheme.colors
    val dims = AuntieTheme.dims
    DenPanel(
        title = "Business operations",
        subtitle = "GPS tracking, liability protection, and visit defaults.",
    ) {
        Column {
            AuntieSettingRow(
                title = "Enable GPS Tracking for All Visits",
                description = "Your operational standard for liability protection and client transparency.",
                leadingIcon = Lucide.MapPin,
                iconTone = AuntieStatusTone.Teal,
                showDivider = true,
                trailing = {
                    AuntieToggle(
                        checked = settings.enableGPSTrackingForAllVisits,
                        onCheckedChange = { enabled ->
                            onSettingsChange(settings.copy(enableGPSTrackingForAllVisits = enabled))
                        },
                    )
                },
            )
            AuntieSettingRow(
                title = "Auto-Start Tracking on Visit Start",
                description = "Automatically begin GPS tracking when visits start.",
                leadingIcon = Lucide.MapPin,
                iconTone = AuntieStatusTone.Teal,
                showDivider = true,
                trailing = {
                    AuntieToggle(
                        checked = settings.autoStartTrackingOnVisitStart,
                        onCheckedChange = { enabled ->
                            onSettingsChange(settings.copy(autoStartTrackingOnVisitStart = enabled))
                        },
                        enabled = settings.enableGPSTrackingForAllVisits,
                    )
                },
            )

            Spacer(Modifier.height(dims.space4))

            AuntieFieldLabel(text = "Tracking Accuracy")
            Text(
                "Higher accuracy provides better liability protection but uses more battery.",
                style = AuntieTheme.typography.bodySmall,
                color = c.textDim,
                modifier = Modifier.padding(bottom = dims.space2),
            )
            TrackingAccuracy.values().forEach { accuracy ->
                Row(modifier = Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                    AuntieRadio(
                        selected = settings.trackingAccuracy == accuracy,
                        onClick = { onSettingsChange(settings.copy(trackingAccuracy = accuracy)) },
                        enabled = settings.enableGPSTrackingForAllVisits,
                    )
                    Text(text = accuracy.name, modifier = Modifier.padding(start = dims.space2))
                }
            }

            Spacer(Modifier.height(dims.space4))

            AuntieFieldLabel(text = "On My Way Default ETA")
            Text(
                "Pre-filled when you tap On My Way on a visit card.",
                style = AuntieTheme.typography.bodySmall,
                color = c.textDim,
                modifier = Modifier.padding(bottom = dims.space2),
            )
            AuntieDropdownField(
                value = settings.defaultEtaMinutes,
                options = settings.etaMinuteOptions,
                onSelect = { mins -> onSettingsChange(settings.copy(defaultEtaMinutes = mins)) },
                displayText = { "$it min" },
                modifier = Modifier.fillMaxWidth(),
            )

            Spacer(Modifier.height(dims.space4))

            AuntieFieldLabel(text = "KinTale Draft Retention")
            Text(
                // ISSUE #519. This line has now been wrong in both directions, so
                // it is worth writing down which one it is. It first read "Unsent
                // drafts auto-purge after this many days" while nothing purged
                // anything; it was corrected to say so; and then `purgeOldDrafts`
                // was built, which made the correction false in the more dangerous
                // direction, telling an operator their drafts were safe while a
                // nightly cron deleted them. It now describes the job that exists.
                "How long to keep an unsent draft. Drafts older than this are deleted nightly, " +
                    "counted from your last edit. Anything already sent is never touched.",
                style = AuntieTheme.typography.bodySmall,
                color = c.textDim,
                modifier = Modifier.padding(bottom = dims.space2),
            )
            AuntieDropdownField(
                value = settings.draftRetentionDays,
                options = settings.draftRetentionOptions,
                onSelect = { days -> onSettingsChange(settings.copy(draftRetentionDays = days)) },
                displayText = { "$it days" },
                modifier = Modifier.fillMaxWidth(),
            )

            Spacer(Modifier.height(dims.space4))

            PrimaryButton(
                label = "Save Business Settings",
                onClick = { onSettingsChange(settings) },
                modifier = Modifier.fillMaxWidth(),
                enabled = !isLoading,
            )
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Business hours
// ─────────────────────────────────────────────────────────────────────────────

private val DAY_LABELS = listOf("Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun")

@Composable
private fun BusinessHoursPanel(
    hours: List<com.tribetails.auntieos.data.model.BusinessHours>,
    onRowChange: (com.tribetails.auntieos.data.model.BusinessHours) -> Unit,
    onSave: () -> Unit,
) {
    val c = AuntieTheme.colors
    val dims = AuntieTheme.dims
    DenPanel(
        title = "Business hours",
        subtitle = "When the Den is open for visits. Use 24h times like 09:00 to 17:00.",
    ) {
        Column(verticalArrangement = Arrangement.spacedBy(dims.space2)) {
            hours.forEach { row ->
                val label = DAY_LABELS.getOrElse(row.dayOfWeek - 1) { row.dayOfWeek.toString() }
                val rangeError = row.isOpen && !isValidTimeRange(row.openTime, row.closeTime)

                Row(
                    modifier = Modifier.fillMaxWidth(),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(dims.space2),
                ) {
                    Text(
                        label,
                        style = AuntieTheme.typography.labelMedium,
                        color = c.textPrimary,
                        modifier = Modifier.width(40.dp),
                    )
                    AuntieToggle(
                        checked = row.isOpen,
                        onCheckedChange = { onRowChange(row.copy(isOpen = it)) },
                    )
                    AuntieField(
                        value = row.openTime,
                        onValueChange = { onRowChange(row.copy(openTime = it)) },
                        placeholder = "09:00",
                        enabled = row.isOpen,
                        isError = rangeError,
                        modifier = Modifier.weight(1f),
                    )
                    Text("to", style = AuntieTheme.typography.bodySmall, color = c.textDim)
                    AuntieField(
                        value = row.closeTime,
                        onValueChange = { onRowChange(row.copy(closeTime = it)) },
                        placeholder = "17:00",
                        enabled = row.isOpen,
                        isError = rangeError,
                        modifier = Modifier.weight(1f),
                    )
                }
                if (rangeError) {
                    Text(
                        "Open time must be before close time (HH:mm)",
                        style = AuntieTheme.typography.labelSmall,
                        color = c.error,
                    )
                }
            }

            Spacer(Modifier.height(dims.space1))
            PrimaryButton(
                label = "Save Business Hours",
                onClick = onSave,
                modifier = Modifier.fillMaxWidth(),
                enabled = hours.all { !it.isOpen || isValidTimeRange(it.openTime, it.closeTime) },
            )
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Notifications
// ─────────────────────────────────────────────────────────────────────────────

@Composable
private fun PaymentOptionsPanel(
    settings: com.tribetails.auntieos.data.model.BusinessSettings,
    onSettingsChange: (com.tribetails.auntieos.data.model.BusinessSettings) -> Unit,
) {
    var venmo by remember(settings.venmoHandle) { mutableStateOf(settings.venmoHandle) }
    var paypal by remember(settings.paypalHandle) { mutableStateOf(settings.paypalHandle) }
    var cashapp by remember(settings.cashappHandle) { mutableStateOf(settings.cashappHandle) }
    DenPanel(
        title = "Payment options",
        subtitle = "Handles clients pay you through. Shown on invoices and the invoice PDF. Leave a field blank to hide that method.",
    ) {
        Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
            AuntieField(value = venmo, onValueChange = { venmo = it }, label = "Venmo handle", placeholder = "@your-venmo")
            AuntieField(value = paypal, onValueChange = { paypal = it }, label = "PayPal handle or email", placeholder = "you@example.com")
            AuntieField(value = cashapp, onValueChange = { cashapp = it }, label = "Cash App \$cashtag", placeholder = "\$yourcashtag")
            PrimaryButton(
                label = "Save payment handles",
                onClick = {
                    onSettingsChange(
                        settings.copy(
                            venmoHandle = venmo.trim(),
                            paypalHandle = paypal.trim(),
                            cashappHandle = cashapp.trim(),
                        )
                    )
                },
                modifier = Modifier.fillMaxWidth(),
            )
        }
    }
}

@Composable
private fun WeatherAreaPanel(
    settings: com.tribetails.auntieos.data.model.BusinessSettings,
    onSettingsChange: (com.tribetails.auntieos.data.model.BusinessSettings) -> Unit,
) {
    var area by remember(settings.weatherLocation) { mutableStateOf(settings.weatherLocation) }
    DenPanel(
        title = "Weather area",
        subtitle = "Where the Home weather widgets forecast for. A city, metro, or ZIP (e.g. \"Austin, TX\"), not your street address. For a metro the centre point covers the whole area.",
    ) {
        Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
            AuntieField(value = area, onValueChange = { area = it }, label = "City, metro, or ZIP", placeholder = "Austin, TX")
            PrimaryButton(
                label = "Save weather area",
                onClick = { onSettingsChange(settings.copy(weatherLocation = area.trim())) },
                modifier = Modifier.fillMaxWidth(),
            )
        }
    }
}

/**
 * Per-notification type x channel matrix = the GATE (Android mirror of the web
 * NotificationMatrixPanel). Self-contained: loads catalog + overrides, renders an
 * On/Off master plus all three channels (Email / SMS / Push) for every row, each an
 * Enable/Disable toggle with a Lock control, persists each change immediately
 * (optimistic, reverts on failure). alwaysEnabled types + catalog-required channels
 * render locked. Fail-loud on load/save errors.
 *
 * Revamp: the three tabs are the notification STREAMS ([NotifAudience]: business =
 * owner hat, staff = Auntie hat, kinfolk = the families' copies), driven by the
 * catalog's `audiences` set. Rows show the STREAM-effective state (streams[T] with
 * field-level fallback onto the flat override) and every edit saves into streams[T],
 * never the flat fields. Rows with an active lock grow a compact "why it's locked"
 * line editing the flat lockReason.
 */
@Composable
private fun NotificationMatrixPanel() {
    val c = AuntieTheme.colors
    val dims = AuntieTheme.dims
    val repo = remember { AuntieOSApp.instance.repository }
    val scope = rememberCoroutineScope()
    var matrix by remember { mutableStateOf<NotificationMatrix?>(null) }
    var loading by remember { mutableStateOf(true) }
    var loadError by remember { mutableStateOf<String?>(null) }
    var saveError by remember { mutableStateOf<String?>(null) }

    suspend fun reload() {
        loading = true
        repo.getBusinessNotificationOverrides()
            .onSuccess { matrix = it; loadError = null }
            .onFailure { loadError = it.message ?: "Couldn't load notification settings" }
        loading = false
    }
    LaunchedEffect(Unit) { reload() }

    var selectedTab by remember { mutableStateOf(NotifAudience.Business) }

    fun persist(entry: NotificationCatalogEntry, override: NotificationOverride) {
        val m = matrix ?: return
        matrix = m.copy(overrides = m.overrides + (entry.key to override)) // optimistic
        scope.launch {
            repo.saveBusinessNotificationOverride(entry.key, override)
                .onSuccess { saveError = null }
                .onFailure { saveError = it.message ?: "Save failed"; reload() } // revert to server truth
        }
    }
    // Seed the editable override from the flat effective state (all three channels, not
    // just the catalog's allowedChannels, so the gate always controls Email + SMS + Push).
    // Per-tab edits then overlay ONLY that audience's stream gate, never the flat fields.
    fun currentOverride(m: NotificationMatrix, entry: NotificationCatalogEntry): NotificationOverride =
        m.overrides[entry.key] ?: NotificationOverride(
            enabled = m.effectiveEnabled(entry.key),
            channels = NOTIF_CHANNEL_COLS.associateWith { m.effectiveChannel(entry.key, it) },
        )

    DenPanel(
        title = "Per-notification settings (the gate)",
        subtitle = "For each notification, switch a channel On to make it available in the recipient's own " +
            "notification settings, or Off to hide it. Lock forces a channel on so they can't change it. " +
            "Off across all channels hides the notification entirely. Pick the audience with the tabs below.",
    ) {
        Column {
            when {
                loading -> Text("Loading notification settings…", style = AuntieTheme.typography.bodySmall, color = c.textDim)
                loadError != null -> Text("Couldn't load notification settings: $loadError", style = AuntieTheme.typography.bodySmall, color = c.error)
                else -> {
                    val m = matrix!!
                    if (saveError != null) {
                        Text("Save failed: $saveError", style = AuntieTheme.typography.bodySmall, color = c.error)
                        Spacer(Modifier.height(8.dp))
                    }
                    if (m.catalog.isEmpty()) {
                        Text("No notification types in the catalog yet.", style = AuntieTheme.typography.bodySmall, color = c.textDim)
                    }
                    // #12: Flowbite-style underline tabs with icons.
                    NotifTabBar(catalog = m.catalog, selected = selectedTab, onSelect = { selectedTab = it })
                    Spacer(Modifier.height(6.dp))
                    // Plain-language explainer of what the selected audience tab governs.
                    Text(
                        notifTabBlurb(selectedTab),
                        style = AuntieTheme.typography.bodySmall,
                        color = c.textDim,
                        modifier = Modifier.fillMaxWidth().padding(bottom = 10.dp),
                    )
                    // #13: aligned column header so channel cells line up across rows.
                    NotifMatrixHeaderRow()
                    val shown = m.catalog.filter { it.inAudience(selectedTab) }
                    if (shown.isEmpty()) {
                        Text("No notifications in this tab.", style = AuntieTheme.typography.bodySmall, color = c.textDim)
                    }
                    val stream = selectedTab.streamKey
                    // Rows grouped under workflow sections (unmatched categories land
                    // in a trailing "Other" section so nothing disappears).
                    // ISSUE #708 mark 42 (web): "give more spacing between
                    // sections damn." The gap above a section heading was
                    // barely more than the gap between the rows inside it, so
                    // a new section did not read as a break. Ported here for
                    // the same defect.
                    sectionedNotifEntries(shown, stream).forEach { (sectionTitle, rows) ->
                        Text(
                            sectionTitle,
                            style = AuntieTheme.typography.labelMedium,
                            color = c.textPrimary,
                            modifier = Modifier.fillMaxWidth().padding(top = dims.space6, bottom = dims.space1),
                        )
                        rows.forEach { entry ->
                            NotifMatrixRow(
                                entry = entry,
                                matrix = m,
                                audience = selectedTab,
                                onToggleEnabled = { newEnabled ->
                                    persist(entry, currentOverride(m, entry).withStreamEnabled(stream, newEnabled))
                                },
                                onToggleChannel = { channel, newVal ->
                                    persist(entry, currentOverride(m, entry).withStreamChannel(stream, channel, newVal))
                                },
                                onToggleEnabledLock = {
                                    val locked = m.streamEffectiveLockedEnabled(entry.key, stream)
                                    persist(
                                        entry,
                                        currentOverride(m, entry)
                                            .withStreamLockedEnabled(stream, !locked, entry.audiences),
                                    )
                                },
                                onToggleChannelLock = { channel ->
                                    val locked = m.streamEffectiveChannelLocked(entry.key, stream, channel)
                                    persist(
                                        entry,
                                        currentOverride(m, entry)
                                            .withStreamChannelLock(stream, channel, !locked, entry.audiences),
                                    )
                                },
                                onSaveLockReason = { reason ->
                                    // Flat, per-notification: one reason no matter the tab.
                                    persist(entry, currentOverride(m, entry).copy(lockReason = reason))
                                },
                            )
                        }
                    }
                    // #396: a screen titled "every notification, with a switch"
                    // reads as a complete inventory of outbound mail, and it is
                    // not one. Invites, account recovery and the error digest
                    // go straight out from a template with no catalog row and
                    // no gate. Leaving them off is the same blindness.
                    NotifUngatedList(m)
                }
            }
        }
    }
}

/**
 * #12: Flowbite-style "tabs with icons" (Android mirror). Underline tab bar: the
 * active tab carries a 2dp accent indicator on the row's hairline baseline; inactive
 * tabs are muted. Icon + label + faint count.
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
            val count = catalog.count { it.inAudience(tab) }
            val active = tab == selected
            val tint = if (active) c.kinfolkOrange else c.textDim
            Column(
                horizontalAlignment = Alignment.CenterHorizontally,
                modifier = Modifier
                    .clip(RoundedCornerShape(topStart = 8.dp, topEnd = 8.dp))
                    .clickable { onSelect(tab) },
            ) {
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                    modifier = Modifier.padding(horizontal = 16.dp, vertical = 12.dp),
                ) {
                    Icon(notifTabIcon(tab), contentDescription = null, tint = tint, modifier = Modifier.size(16.dp))
                    Text(tab.title, style = AuntieTheme.typography.labelMedium, color = tint)
                    Text(
                        count.toString(),
                        style = AuntieTheme.typography.labelSmall,
                        color = if (active) c.kinfolkOrange.copy(alpha = 0.7f) else c.textFaint,
                    )
                }
                Box(Modifier.fillMaxWidth().height(2.dp).background(if (active) c.kinfolkOrange else Color.Transparent))
            }
        }
    }
}

/**
 * The mail the gate does NOT govern (#396). Server-supplied, so #386 folding
 * broadcast into the catalog changes nothing here.
 */
@Composable
private fun NotifUngatedList(matrix: NotificationMatrix) {
    if (matrix.ungated.isEmpty()) return
    val c = AuntieTheme.colors
    Column(
        Modifier.fillMaxWidth().padding(top = 16.dp),
        verticalArrangement = Arrangement.spacedBy(2.dp),
    ) {
        Text("ALSO SENT, BUT NOT GATED HERE", style = AuntieTheme.typography.labelMedium, color = c.textPrimary)
        Text(
            "These emails go straight out from a template, with no catalog row and no channel " +
                "resolution. Nothing on this screen turns them off.",
            style = AuntieTheme.typography.bodySmall,
            color = c.textFaint,
        )
        matrix.ungated.forEach { send ->
            Text(
                "emailTemplates/${send.templateId}, sent when: ${send.trigger}  ${send.source}",
                style = AuntieTheme.typography.bodySmall,
                color = c.textDim,
            )
        }
    }
}
private fun notifTabIcon(tab: NotifAudience) = when (tab) {
    NotifAudience.Business -> Lucide.Building2
    NotifAudience.Staff -> Lucide.PawPrint
    NotifAudience.Kinfolk -> Lucide.Users
}

/** Plain-language explainer of what each audience tab governs (operator clarity). */
private fun notifTabBlurb(tab: NotifAudience): String = when (tab) {
    NotifAudience.Business ->
        "Your owner hat: bookings, invoices, payments, security, and ratings."
    NotifAudience.Staff ->
        "Your Auntie hat: visit notes, KinTale comments, pet updates, and the schedule digest."
    NotifAudience.Kinfolk ->
        "The families' copies: confirmations, arrivals, reports, and receipts."
}

// #13: the four notification columns, fixed order so header + rows align.
private val NOTIF_CHANNEL_COLS = listOf("email", "sms", "push")
private val NOTIF_CELL_WIDTH = 60.dp

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
                textAlign = TextAlign.Center,
                modifier = Modifier.width(NOTIF_CELL_WIDTH),
            )
        }
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
    val stream = audience.streamKey
    val enabled = matrix.streamEffectiveEnabled(entry.key, stream)
    var showDetail by remember(entry.key) { mutableStateOf(false) }
    Column(Modifier.fillMaxWidth().padding(vertical = 8.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth()) {
            Column(Modifier.weight(1f).padding(end = 8.dp)) {
                Text(entry.displayTitle(), style = AuntieTheme.typography.bodyMedium, color = c.textPrimary)
                // This line used to read "Always on", and it was not true: nothing
                // enforces `alwaysEnabled` at send time (ruling #7,
                // warn-but-allow-off). `notifRowBadges` replaces it with a risk
                // marker that escalates to a warning once the row is actually off.
                // See data/model/NotificationProvenance.kt for the full why.
                notifRowBadges(entry, stream, enabled).forEach { badge ->
                    Text(
                        badge.label,
                        style = AuntieTheme.typography.labelSmall,
                        color = if (badge.tone == NotifBadgeTone.Warn) c.warning else c.textFaint,
                    )
                }
                // Shared keys: name the other copy so nobody hunts for a "missing" row.
                sharedCopyCaption(entry.audiences, audience)?.let { caption ->
                    Text(caption, style = AuntieTheme.typography.labelSmall, color = c.textFaint)
                }
                AuntieTextBtn(onClick = { showDetail = !showDetail }) {
                    Text(
                        if (showDetail) "Hide details" else "Who gets this, and what fires it",
                        style = AuntieTheme.typography.labelSmall,
                    )
                }
            }
            // On/Off master for the whole notification, on THIS audience's stream.
            NotifCell(
                on = enabled,
                locked = matrix.streamEffectiveLockedEnabled(entry.key, stream),
                onToggle = { onToggleEnabled(!enabled) },
                onToggleLock = onToggleEnabledLock,
            )
            // Every notification shows all three channels as real Enable/Disable toggles,
            // no hidden or N/A cells. A channel greys out (but stays visible) when the
            // On/Off master is off.
            NOTIF_CHANNEL_COLS.forEach { channel ->
                NotifCell(
                    on = matrix.streamEffectiveChannel(entry.key, stream, channel),
                    locked = matrix.streamEffectiveChannelLocked(entry.key, stream, channel),
                    enabledToggle = enabled,
                    onToggle = { onToggleChannel(channel, !matrix.streamEffectiveChannel(entry.key, stream, channel)) },
                    onToggleLock = { onToggleChannelLock(channel) },
                )
            }
        }
        NotifLockReasonLine(
            entry = entry,
            matrix = matrix,
            audience = audience,
            onSaveLockReason = onSaveLockReason,
        )
        if (showDetail) {
            NotifRowDetail(entry = entry, matrix = matrix)
        }
    }
}
/**
 * The answer half of the gate row (#396): who receives it, what fires it, which
 * template writes each channel, what the body can carry, and what the last real
 * sends actually did.
 *
 * Every sentence here is server-authored (see
 * mytribe/functions/src/notifications/provenance.ts). This composable arranges
 * them; it does not write them, so web and Android cannot drift into telling
 * the operator two different stories about the same notification.
 */
@Composable
private fun NotifRowDetail(
    entry: NotificationCatalogEntry,
    matrix: NotificationMatrix,
) {
    val c = AuntieTheme.colors
    Column(
        Modifier.fillMaxWidth().padding(top = 8.dp, start = 4.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        NotifDetailBlock(
            title = "WHO RECEIVES IT",
            lines = notifRecipientLines(entry, matrix.businessAdminCount, matrix.businessAdminRosterPath),
            empty = "The server sent no recipient rule for this row. Update MyTribe functions to see it.",
        )
        if (notifReachesBusinessAdmins(entry)) {
            NotifBusinessAdminRosterBlock()
        }
        NotifDetailBlock(
            title = "WHAT FIRES IT",
            lines = entry.emitters.map { "${it.trigger}  ${it.source}" },
            empty = "Nothing in the platform dispatches this notification, so nothing sets it off. " +
                "The toggles on this row change what nobody receives.",
        )
        // Reporting, not editing: Template Assignments (#439) owns the routing
        // table and both screens read the same bindings.
        NotifDetailBlock(
            title = "WHICH TEMPLATE WRITES IT (REPOINT ON TEMPLATE ASSIGNMENTS)",
            lines = notifTemplateLines(entry).map { line ->
                val suffix = when {
                    line.missing -> " (this channel is offered with nothing to render it)"
                    line.retargetedFrom != null ->
                        " (retargeted; the catalog default is ${line.retargetedFrom})"
                    else -> ""
                }
                "${line.channel}: ${line.path}$suffix"
            },
            empty = "This row offers no channels at all.",
        )
        val fields = notifMergeFieldNames(entry)
        NotifDetailBlock(
            title = "WHAT THE BODY CAN CARRY",
            lines = if (fields.isEmpty()) emptyList() else listOf(
                "Anything here can appear in the message, and so reach whoever the recipient rule " +
                    "above resolves to: " + fields.joinToString(", "),
            ) + entry.emitters.mapNotNull { it.dataNote },
            empty = "No merge fields are recorded for this row.",
        )
        NotifDeliveryEvidenceBlock(notificationKey = entry.key)
    }
}
/**
 * WHO "every business admin" is, by name (issue #450).
 *
 * The line above this block could say "every business admin on the roster, that
 * is 4 people today" and name a Firestore document. Every other audience on
 * this screen resolves to a person; for this one the operator was told to go
 * and read the document themselves, which is the "look it up yourself" #396 was
 * filed against.
 *
 * Loaded on demand per opened row, like the delivery evidence below it, and
 * only for a row that actually reaches business admins.
 *
 * READ ONLY: `listBusinessAdmins` walks the server's recipient order without
 * the dispatch path's self-heal write, so opening this cannot change who
 * receives business mail. Editing the roster is `setBusinessAdmins`.
 */
@Composable
private fun NotifBusinessAdminRosterBlock() {
    val c = AuntieTheme.colors
    val repo = remember { AuntieOSApp.instance.repository }
    var roster by remember { mutableStateOf<BusinessAdminRoster?>(null) }
    var loading by remember { mutableStateOf(true) }
    var error by remember { mutableStateOf<String?>(null) }
    var attempt by remember { mutableStateOf(0) }
    LaunchedEffect(attempt) {
        loading = true
        repo.listBusinessAdmins()
            .onSuccess { roster = it; error = null }
            .onFailure { error = it.message ?: "Couldn't read the business admin roster" }
        loading = false
    }
    Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
        val current = roster
        when {
            loading -> Text(
                "Reading the business admin roster…",
                style = AuntieTheme.typography.bodySmall,
                color = c.textFaint,
            )
            error != null -> {
                Text(
                    "Couldn't read the business admin roster: $error",
                    style = AuntieTheme.typography.bodySmall,
                    color = c.error,
                )
                Text(
                    "Retry",
                    style = AuntieTheme.typography.bodySmall,
                    color = c.accent,
                    modifier = Modifier.clickable { attempt += 1 },
                )
            }
            current == null || current.members.isEmpty() -> Text(
                current?.reason
                    ?: "Nobody is on the business admin roster, so this notification currently reaches nobody.",
                style = AuntieTheme.typography.bodySmall,
                color = c.textFaint,
            )
            else -> {
                Text(
                    "By name:",
                    style = AuntieTheme.typography.bodySmall,
                    color = c.textFaint,
                )
                businessAdminSourceNote(current)?.let { note ->
                    Text(note, style = AuntieTheme.typography.bodySmall, color = c.textFaint)
                }
                businessAdminLines(current).forEach { line ->
                    Text(line, style = AuntieTheme.typography.bodySmall, color = c.textDim)
                }
            }
        }
    }
}
@Composable
private fun NotifDetailBlock(title: String, lines: List<String>, empty: String) {
    val c = AuntieTheme.colors
    Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
        Text(title, style = AuntieTheme.typography.labelSmall, color = c.textFaint)
        if (lines.isEmpty()) {
            Text(empty, style = AuntieTheme.typography.bodySmall, color = c.textFaint)
        } else {
            lines.forEach { line ->
                Text(line, style = AuntieTheme.typography.bodySmall, color = c.textDim)
            }
        }
    }
}
/**
 * The last few real sends of one catalog key, loaded on demand.
 *
 * Loaded per opened row rather than up front: the operator asking "what could
 * go out" asks about one notification, and prefetching 44 keys' dispatch
 * history would be a lot of reads for a question nobody asked.
 */
@Composable
private fun NotifDeliveryEvidenceBlock(notificationKey: String) {
    val c = AuntieTheme.colors
    val repo = remember { AuntieOSApp.instance.repository }
    var evidence by remember(notificationKey) { mutableStateOf<NotificationDeliveryEvidence?>(null) }
    var loading by remember(notificationKey) { mutableStateOf(true) }
    var error by remember(notificationKey) { mutableStateOf<String?>(null) }
    LaunchedEffect(notificationKey) {
        loading = true
        repo.listNotificationDeliveries(key = notificationKey, limit = 10)
            .onSuccess { evidence = it; error = null }
            .onFailure { error = it.message ?: "Couldn't read the delivery log" }
        loading = false
    }
    Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
        Text("WHETHER IT GOT OUT", style = AuntieTheme.typography.labelSmall, color = c.textFaint)
        val ev = evidence
        when {
            loading -> Text("Reading the delivery log…", style = AuntieTheme.typography.bodySmall, color = c.textFaint)
            error != null -> Text(
                "Couldn't read the delivery log: $error",
                style = AuntieTheme.typography.bodySmall,
                color = c.error,
            )
            ev == null || ev.deliveries.isEmpty() -> Text(
                "This notification has not been dispatched yet, so there is nothing to show. " +
                    "An empty log is not evidence it failed.",
                style = AuntieTheme.typography.bodySmall,
                color = c.textFaint,
            )
            else -> {
                // The server's own ceiling on what "sent" proves. Rendered rather
                // than paraphrased, so the two clients cannot soften it differently.
                Text(ev.sentMeaning, style = AuntieTheme.typography.bodySmall, color = c.textFaint)
                ev.deliveries.forEach { row ->
                    val recipient = row.recipientUid.ifBlank { "unknown recipient" }
                    Text(
                        "to $recipient",
                        style = AuntieTheme.typography.bodySmall,
                        color = c.textDim,
                    )
                    row.attempts.forEach { attempt ->
                        val phrase = notifDeliveryPhrase(attempt.status, attempt.skipReason, attempt.errorMessage)
                        Text(
                            "  ${attempt.channel}: ${phrase.label}. ${phrase.detail}" +
                                (attempt.providerMessageId?.let { " Provider id $it." } ?: "") +
                                (if (attempt.attempts > 1) " Tried ${attempt.attempts} times." else ""),
                            style = AuntieTheme.typography.bodySmall,
                            color = when (phrase.tone) {
                                NotifDeliveryTone.Bad -> c.error
                                NotifDeliveryTone.Warn -> c.warning
                                NotifDeliveryTone.Neutral -> c.textFaint
                                NotifDeliveryTone.Good -> c.textDim
                            },
                        )
                    }
                }
            }
        }
    }
}

/**
 * Compact "why it's locked" line + inline single-line editor, shown while any lock is
 * active on the current stream view (lockedEnabled, a locked channel, or catalog
 * alwaysEnabled scoped to this stream). Saves the FLAT lockReason: one reason per
 * notification, all tabs.
 * Saving an empty field clears the reason (the callable treats "" as clear).
 */
@Composable
private fun NotifLockReasonLine(
    entry: NotificationCatalogEntry,
    matrix: NotificationMatrix,
    audience: NotifAudience,
    onSaveLockReason: (String) -> Unit,
) {
    val c = AuntieTheme.colors
    val stream = audience.streamKey
    val anyLockActive = entry.alwaysEnabledFor(stream) ||
        matrix.streamEffectiveLockedEnabled(entry.key, stream) ||
        NOTIF_CHANNEL_COLS.any { matrix.streamEffectiveChannelLocked(entry.key, stream, it) }
    if (!anyLockActive) return
    val reason = matrix.lockReasonFor(entry.key)
    var editing by remember(entry.key) { mutableStateOf(false) }
    var draft by remember(entry.key, reason) { mutableStateOf(reason ?: "") }
    Spacer(Modifier.height(4.dp))
    if (editing) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(6.dp),
            modifier = Modifier.fillMaxWidth(),
        ) {
            AuntieField(
                value = draft,
                onValueChange = { draft = it.take(300) },
                placeholder = "Tell folks why this one stays on",
                modifier = Modifier.weight(1f),
            )
            AuntieIconButton(
                icon = Lucide.Check,
                contentDescription = "Save lock reason",
                size = 32.dp,
                onClick = {
                    onSaveLockReason(draft.trim())
                    editing = false
                },
            )
            AuntieIconButton(
                icon = Lucide.X,
                contentDescription = "Cancel lock reason edit",
                size = 32.dp,
                onClick = {
                    draft = reason ?: ""
                    editing = false
                },
            )
        }
    } else {
        Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth()) {
            Text(
                reason?.let { "Why it's locked: $it" } ?: "Locked on. Tap the pencil to tell folks why.",
                style = AuntieTheme.typography.labelSmall,
                color = c.textFaint,
                modifier = Modifier.weight(1f),
            )
            Icon(
                imageVector = Lucide.Pencil,
                contentDescription = "Edit lock reason",
                tint = c.textFaint,
                modifier = Modifier
                    .clip(RoundedCornerShape(6.dp))
                    .clickable { editing = true }
                    .padding(3.dp)
                    .size(14.dp),
            )
        }
    }
}

/** One aligned matrix cell: an Enable/Disable toggle over a tiny lock chip. */
@Composable
private fun NotifCell(
    on: Boolean,
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
        AuntieToggle(checked = on, enabled = enabledToggle, onCheckedChange = { onToggle() })
        Icon(
            imageVector = if (locked) Lucide.Lock else Lucide.LockOpen,
            contentDescription = if (locked) "Locked on for the recipient (tap to unlock)" else "Lock on for the recipient",
            tint = if (locked) c.kinfolkOrange else c.textFaint,
            modifier = Modifier
                .clip(RoundedCornerShape(6.dp))
                .clickable { onToggleLock() }
                .padding(3.dp)
                .size(14.dp),
        )
    }
}

@Composable
private fun BookingBehaviorPanel(
    settings: com.tribetails.auntieos.data.model.BusinessSettings,
    onSettingsChange: (com.tribetails.auntieos.data.model.BusinessSettings) -> Unit,
) {
    // The settings mock's "Scheduling" panel (issue #755 pass): its `.trow`
    // rows in its order, each a bold label with the mock's one-line note
    // under it and the switch at the right, no leading icon. The mock's
    // fourth row, "Sync Google Calendar busy events", is the free/busy
    // import, which lives on the Scheduling options screen (#715 on web).
    DenPanel(
        title = "Scheduling",
        subtitle = "How new bookings are confirmed and adjusted. Each switch saves the moment it is flipped.",
    ) {
        // #9 (2026-06-08): real persisted toggles (parity with web). Each flip merges
        // the change onto the business_settings doc via updateBusinessSettings.
        Column {
            // #517: parity with web. Writes enableConflictDetection, the field
            // EnhancedSchedulingViewModel already gates its availability check on
            // and that guardBookingBusyConflict now reads server-side before every
            // booking write. Defaults ON, so the switch starts where the model does.
            AuntieSettingRow(
                title = "Block bookings during busy events",
                description = "Stop new visits from landing on top of a Google Calendar block.",
                showDivider = true,
                trailing = {
                    AuntieToggle(
                        checked = settings.enableConflictDetection,
                        onCheckedChange = { next -> onSettingsChange(settings.copy(enableConflictDetection = next)) },
                    )
                },
            )
            AuntieSettingRow(
                title = "Snap drag-to-reschedule to 15 min",
                description = "Visits align to quarter-hour slots when dragged.",
                showDivider = true,
                trailing = {
                    AuntieToggle(
                        checked = settings.snapRescheduleTo15Min,
                        onCheckedChange = { next -> onSettingsChange(settings.copy(snapRescheduleTo15Min = next)) },
                    )
                },
            )
            AuntieSettingRow(
                title = "Auto-confirm repeat kinfolk",
                description = "Trusted kinfolk bookings skip manual approval.",
                showDivider = false,
                trailing = {
                    AuntieToggle(
                        checked = settings.autoConfirmRepeatKinfolk,
                        onCheckedChange = { next -> onSettingsChange(settings.copy(autoConfirmRepeatKinfolk = next)) },
                    )
                },
            )
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Home layout (issue #397 M10)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The kinfolk portal's Home layout: reorder, show/hide, and cap each of the
 * five fixed sections (`HOME_SECTION_CATALOG`). A DEDICATED Save/Cancel bar,
 * not `onSettingsChange` fired per keystroke/per-toggle like
 * [BookingBehaviorPanel] above — a reorder is several quick taps in a row, and
 * a network round trip per tap would make the arrows feel laggy for no
 * benefit, since nothing here needs to be seen by another surface mid-edit.
 * `onSettingsChange` (=`viewModel.updateBusinessSettings`) is called exactly
 * once, on Save, with the WHOLE edited [BusinessSettings]; the diff mechanism
 * in `BusinessSettingsDiff.kt` is what turns that into a single-field write.
 *
 * DIFF, NOT REBUILD: the write goes through `settings.withHomeSections(...)`,
 * which patches only `mytribePortal.home.sections` and carries every sibling
 * key (`logoUrl`, `themeId`, `banner`, `chat`) forward unread and unchanged
 * (see `withHomeSections` in LocationModels.kt). This panel never constructs
 * a `BusinessSettings` from scratch.
 *
 * ONE-WAY-DOOR GUARD (issue #397 M10 follow-up). [rows] holds the RAW draft
 * (starts as `settings.homeSections()`, the STORED value, never the
 * materialized one) — `effectiveHomeSections(rows)` is computed fresh on
 * every recomposition purely to decide what [displayRows] to draw, and is
 * never itself assigned into [rows]. That split is what makes opening this
 * panel and pressing Save with nothing touched a genuine no-op: [dirty]
 * compares [rows] against [baseline], both the untouched stored value, so
 * `AuntieSaveBar` never enables Save until a row handler below actually
 * reassigns [rows]. A real edit reassigns [rows] to the fully materialized,
 * patched [displayRows] (order is holistic — there is no smaller diff of a
 * reordered array), and "Reset to default layout" reassigns it to
 * [RESET_HOME_SECTIONS] (`[]`) — the same empty list the portal reads as its
 * own implicit default, not a canonical list that merely looks the same.
 */
@Composable
private fun HomeLayoutPanel(
    settings: com.tribetails.auntieos.data.model.BusinessSettings,
    onSettingsChange: (com.tribetails.auntieos.data.model.BusinessSettings) -> Unit,
) {
    val dims = AuntieTheme.dims
    val baseline = remember(settings) { settings.homeSections() }
    var rows by remember(settings) { mutableStateOf(baseline) }
    var saving by remember { mutableStateOf(false) }
    val dirty = rows != baseline
    val displayRows = effectiveHomeSections(rows)
    val isDefault = rows.isEmpty()

    DenPanel(
        title = "Home layout",
        subtitle = "Reorder, show or hide, and cap how many items each Home section lists for kinfolk. A limit of 0 is unlimited.",
    ) {
        Column {
            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.SpaceBetween,
            ) {
                AuntieStatusPill(
                    label = homeLayoutModeLabel(rows),
                    tone = if (isDefault) AuntieStatusTone.Muted else AuntieStatusTone.Orange,
                )
                GhostButton(
                    label = "Reset to default layout",
                    onClick = { rows = RESET_HOME_SECTIONS },
                    enabled = !isDefault,
                )
            }
            Spacer(Modifier.height(dims.space3))

            displayRows.forEachIndexed { index, row ->
                val label = homeSectionLabel(row.id)
                Row(
                    modifier = Modifier.fillMaxWidth().padding(vertical = 4.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(dims.space2),
                ) {
                    AuntieIconButton(
                        icon = Lucide.ArrowUp,
                        contentDescription = "Move $label up",
                        onClick = { rows = moveHomeSectionUp(displayRows, index) },
                        enabled = index > 0,
                        size = 32.dp,
                    )
                    AuntieIconButton(
                        icon = Lucide.ArrowDown,
                        contentDescription = "Move $label down",
                        onClick = { rows = moveHomeSectionDown(displayRows, index) },
                        enabled = index < displayRows.lastIndex,
                        size = 32.dp,
                    )
                    Text(label, modifier = Modifier.weight(1f), style = AuntieTheme.typography.bodyMedium)
                    AuntieField(
                        value = row.limit.toString(),
                        onValueChange = { text ->
                            val n = parseWholeNumber(text, 0, 999) ?: 0
                            rows = displayRows.replacedAt(index, row.copy(limit = n))
                        },
                        label = "Limit",
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                        modifier = Modifier.width(84.dp),
                    )
                    AuntieToggle(
                        checked = row.enabled,
                        onCheckedChange = { next -> rows = displayRows.replacedAt(index, row.copy(enabled = next)) },
                    )
                }
            }

            Spacer(Modifier.height(dims.space4))
            AuntieSaveBar(
                dirty = dirty,
                saveEnabled = dirty && !saving,
                onCancel = { rows = baseline },
                onSave = {
                    saving = true
                    onSettingsChange(settings.withHomeSections(rows))
                    saving = false
                },
                dirtyLabel = "Unsaved Home layout",
                savedLabel = "Home layout saved",
            )
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Integrations
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Every outside service, as the SERVER sees it, plus the two things only this
 * handset can answer.
 *
 * WHAT CHANGED AND WHY. This panel used to render four rows the ViewModel held
 * as literals, two of them with a fixed pill: "n8n Webhooks: CONFIGURED" stayed
 * on screen for more than a year after n8n was retired, and "Twilio Studio:
 * CONFIGURED" asserted a state nothing had ever checked. A phone cannot read a
 * Cloud Functions secret, so every server-side claim it made was a guess wearing
 * a status pill. The verdicts now come from `getIntegrationsHealth`, the same
 * answer the React admin renders, so the two surfaces cannot tell an operator
 * different things about the same key.
 *
 * WHAT STAYED, AND WHY IT IS NOT AN EXCEPTION. Firestore and push notifications
 * are still probed here, because both questions are about THIS DEVICE: can it
 * reach Firestore, does it hold an FCM registration token. A server answer would
 * be about a different machine. They are labelled so nobody reads them as a
 * claim about the business.
 *
 * A FAILED READ SHOWS AS A FAILED READ. No server row is drawn when the call did
 * not come back, because a row of reassuring pills over an unanswered question
 * is how an operator stops looking for the reason invoices are not sending.
 */
@Composable
private fun IntegrationsPanel(
    health: IntegrationsHealth?,
    loading: Boolean,
    error: String?,
    deviceProbes: List<IntegrationHealth>,
    onRetry: () -> Unit,
    onOpenGoogleCalendar: () -> Unit,
) {
    val c = AuntieTheme.colors
    val dims = AuntieTheme.dims
    // The header carries what is about the whole report: WHEN it was made (a
    // value, so `detail`) and the control that makes it again (`trailing`).
    // Both wait for an answer; a failed read offers Try again on its banner
    // instead, so there is never a second button beside it. Mirrors web.
    DenPanel(
        title = "Integrations",
        subtitle = "The outside services this business runs on, checked on the server. The rows under This phone are about this handset.",
        detail = health?.let { integrationsCheckedLabel(it.checkedAt) },
        trailing = if (health != null) {
            {
                GhostButton(
                    label = if (loading) "Checking..." else "Check again",
                    onClick = onRetry,
                    enabled = !loading,
                )
            }
        } else {
            null
        },
    ) {
        Column(verticalArrangement = Arrangement.spacedBy(13.dp)) {
            Text("OUTSIDE SERVICES", style = AuntieTheme.typography.labelSmall, color = c.textFaint)

            when {
                error != null -> {
                    AuntieBanner(
                        tone = AuntieBannerTone.Error,
                        title = "Could not check the integrations",
                        body = {
                            Column {
                                // The server's own words: they name the missing
                                // secret and the command that sets it.
                                Text(error, style = AuntieTheme.typography.bodySmall, color = c.textDim)
                                Spacer(Modifier.height(dims.space2))
                                Text(
                                    "Nothing about Stripe, Twilio, email, photos, maps, calendar or error reporting " +
                                        "is shown below, because none of it was answered.",
                                    style = AuntieTheme.typography.bodySmall,
                                    color = c.textDim,
                                )
                            }
                        },
                        trailing = { GhostButton(label = "Try again", onClick = onRetry) },
                    )
                }

                health == null -> {
                    // Issue #714: getIntegrationsHealth cold-starts at up to 8.9s.
                    // A spinner is the only cue that this line is still waiting
                    // on the server rather than reporting a check that never ran.
                    if (loading) {
                        LoadingHint("Checking integrations...")
                    } else {
                        Text(
                            "The integrations check has not run yet.",
                            style = AuntieTheme.typography.bodySmall,
                            color = c.textDim,
                        )
                    }
                }

                else -> {
                    if (!health.declaredKnown) {
                        AuntieBanner(
                            tone = AuntieBannerTone.Warning,
                            title = "Part of this check could not run",
                            body = {
                                Text(
                                    "The server could not read which secrets the deployed functions declare, so that " +
                                        "line is left off every row below. Everything else here still stands. " +
                                        health.declaredError,
                                    style = AuntieTheme.typography.bodySmall,
                                    color = c.textDim,
                                )
                            },
                        )
                    }
                    health.integrations.forEach { row ->
                        ServerIntegrationCard(
                            row = row,
                            declaredKnown = health.declaredKnown,
                            onOpenGoogleCalendar = onOpenGoogleCalendar,
                        )
                    }
                }
            }

            // The two facts a server genuinely cannot see, kept for that reason
            // and labelled so they are never read as claims about the business.
            Text("THIS PHONE", style = AuntieTheme.typography.labelSmall, color = c.textFaint)
            deviceProbes.forEach { row -> DeviceProbeCard(row) }

            // Stripe CONNECT, which is not the same thing as the Stripe row
            // above: that one is card payments on an invoice, this is paying a
            // connected account out. Connecting needs a client ID and secret no
            // code in this repo holds, so it is named rather than staged behind
            // a button that could not work.
            Text("PAYOUTS", style = AuntieTheme.typography.labelSmall, color = c.textFaint)
            IntegrationCard(
                name = "Stripe Connect",
                purpose = "Paying out to a connected account, separate from card payments on an invoice",
                stateLabel = "Needs your keys",
                stateTone = AuntieStatusTone.Warning,
                report = {
                    Text(
                        "Connecting needs your Stripe Connect client ID and secret from dashboard.stripe.com/settings/connect. Card payments on invoices work without it.",
                        style = AuntieTheme.typography.bodySmall,
                        color = c.textDim,
                    )
                },
            )

            // #8: optional third-party ADD-ONS (Zapier, to-do apps, etc.). None are built
            // yet: shown honestly as "Coming soon", never faked as connected. The
            // operator's 2026-08-29 ruling keeps these three rows visible as
            // reminders of planned work; building the connect flows waits until
            // the apps are fully functional in everything else.
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
 * The settings mock's `.int` card (issue #755 pass), the Android twin of the
 * web `.integrations__card`: a 40dp brand-gradient tile carrying the
 * service's monogram, the name, what it is for, the caller's [report], and
 * last the mock's `.foot`: the state as an LED with its words, beside the
 * one [control] a row can have. On the raised surface, a hairline at 15dp,
 * 15dp inside.
 */
@Composable
private fun IntegrationCard(
    name: String,
    purpose: String,
    stateLabel: String,
    stateTone: AuntieStatusTone,
    stateGlow: Boolean = false,
    control: (@Composable () -> Unit)? = null,
    report: (@Composable ColumnScope.() -> Unit)? = null,
) {
    val c = AuntieTheme.colors
    val dims = AuntieTheme.dims
    val shape = RoundedCornerShape(15.dp)
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clip(shape)
            .background(c.surface2)
            .border(dims.borderHairline, c.border, shape)
            .padding(15.dp),
        horizontalArrangement = Arrangement.spacedBy(13.dp),
        verticalAlignment = Alignment.Top,
    ) {
        IntegrationMonogramTile(name)
        Column(Modifier.weight(1f)) {
            Text(
                name,
                style = AuntieTheme.typography.bodyMedium.copy(fontSize = 14.5.sp, fontWeight = FontWeight.SemiBold),
                color = c.textPrimary,
            )
            Spacer(Modifier.height(3.dp))
            Text(purpose, style = AuntieTheme.typography.bodySmall, color = c.textDim)
            if (report != null) {
                Spacer(Modifier.height(dims.space2))
                Column(verticalArrangement = Arrangement.spacedBy(dims.space2)) { report() }
            }
            Spacer(Modifier.height(11.dp))
            Row(verticalAlignment = Alignment.CenterVertically) {
                IntegrationStateLine(stateLabel, stateTone, stateGlow, Modifier.weight(1f))
                control?.invoke()
            }
        }
    }
}

/**
 * The mock's `.logo`: the service's first letter in the serif, cream, on a
 * brand gradient picked by the name so the same service always reads with
 * the same colour signature (the web card seeds `gradientForSeed` the same
 * way). Decorative: the name beside it is the accessible text.
 */
@Composable
private fun IntegrationMonogramTile(name: String) {
    val gradients = listOf(TribeGradients.orangeToPink(), TribeGradients.tealToPurple(), TribeGradients.tribe())
    val brush: Brush = gradients[integrationGradientIndex(name, gradients.size)]
    Box(
        modifier = Modifier
            .size(40.dp)
            .clip(RoundedCornerShape(11.dp))
            .background(brush),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            integrationMonogram(name),
            style = AuntieTheme.typography.headlineSmall.copy(fontSize = 17.sp, fontWeight = FontWeight.Bold),
            color = BrandCream,
        )
    }
}

/**
 * The mock's `.conn`: a 7dp LED and the state in mono caps, both in the
 * tone. The words come with the colour, never colour alone: whoever is on
 * call reads this on whatever screen they have.
 */
@Composable
private fun IntegrationStateLine(
    label: String,
    tone: AuntieStatusTone,
    glow: Boolean,
    modifier: Modifier = Modifier,
) {
    val c = AuntieTheme.colors
    Row(modifier = modifier, verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        AuntieStatusPill(label = label, tone = tone, dotOnly = true, glow = glow)
        Text(
            label.uppercase(),
            style = AuntieTheme.typography.mono.copy(fontSize = 9.5.sp, fontWeight = FontWeight.SemiBold, letterSpacing = 0.7.sp),
            color = tone.color(c),
        )
    }
}

/**
 * #8: a third-party add-on row, shown honestly as "Coming soon" (none are built;
 * never faked as connected). The #397 audit flagged these as invented scope and
 * recommended deleting them; the operator OVERRULED that on 2026-08-26 ("these
 * a[re] soon to be implementations") and again on 2026-08-29: they stay, as a
 * ruled, planned backlog item, not an unexplained placeholder. When the connect
 * flow ships, this becomes connect + settings + link. Drawn as the same card as
 * a live service, with no Connect button: a button that could not work is the
 * fake the ruling forbids.
 */
@Composable
private fun AddOnComingSoon(name: String, detail: String) {
    IntegrationCard(
        name = name,
        purpose = detail,
        stateLabel = "Coming soon",
        stateTone = AuntieStatusTone.Muted,
    )
}

/**
 * One outside service, exactly as the server described it.
 *
 * NOTHING IS DECIDED HERE. The status, the one-line summary and the remediation
 * all arrive settled; this composable chooses a tone and prints the rest. The
 * remediation in particular is shown VERBATIM in mono, because it is a command
 * to paste, and a friendlier paraphrase would delete the only text on the
 * screen that says what to do next.
 */
@Composable
private fun ServerIntegrationCard(
    row: ServerIntegration,
    declaredKnown: Boolean,
    onOpenGoogleCalendar: () -> Unit,
) {
    val c = AuntieTheme.colors
    val dims = AuntieTheme.dims
    val tone = when (row.status) {
        IntegrationStatus.WORKING -> AuntieStatusTone.Success
        IntegrationStatus.CONFIGURED -> AuntieStatusTone.Orange
        IntegrationStatus.MISSING -> AuntieStatusTone.Error
        // Never Muted: a check that could not be made must not sit quietly
        // beside checks that passed.
        IntegrationStatus.UNKNOWN -> AuntieStatusTone.Warning
    }
    IntegrationCard(
        name = row.name,
        purpose = row.purpose,
        stateLabel = integrationStatusLabel(row.status),
        stateTone = tone,
        // The connect flow already exists, on the Scheduling options screen.
        // This card reports and hands off; a second copy of the OAuth flow here
        // would be two places for one connection to drift. ANY non-empty
        // `ownedBySection` opens it, never a specific string: the server sends
        // `calendar` today and sent `googleCalendar` before #715, and this card
        // only asks "does something own this row," never "what."
        control = if (row.ownedBySection.isNotBlank()) {
            { GhostButton(label = "Open Google Calendar setup", onClick = onOpenGoogleCalendar) }
        } else {
            null
        },
        report = {
            Text(row.summary, style = AuntieTheme.typography.bodySmall, color = c.textPrimary)
            row.secrets.forEach { secret ->
                Text(
                    integrationSecretLine(secret, declaredKnown),
                    style = AuntieTheme.typography.labelSmall,
                    color = if (secret.resolves) c.textDim else c.error,
                )
            }
            if (row.remediation.isNotBlank()) {
                Column {
                    Text("WHAT TO DO", style = AuntieTheme.typography.labelSmall, color = c.textFaint)
                    Text(
                        row.remediation,
                        style = AuntieTheme.typography.labelSmall,
                        color = c.textPrimary,
                        modifier = Modifier
                            .fillMaxWidth()
                            .clip(RoundedCornerShape(8.dp))
                            .background(c.surfaceGlass)
                            .padding(dims.space2),
                    )
                }
            }
            if (row.externalStep.isNotBlank()) {
                Text(row.externalStep, style = AuntieTheme.typography.bodySmall, color = c.textDim)
            }
        },
    )
}

/**
 * One thing THIS PHONE checked about itself. Kept client-side because no server
 * can answer either question: they are about the handset, not the business.
 */
@Composable
private fun DeviceProbeCard(row: IntegrationHealth) {
    val tone = when (row.state) {
        IntegrationHealthState.HEALTHY -> AuntieStatusTone.Success
        IntegrationHealthState.CONFIGURED -> AuntieStatusTone.Orange
        IntegrationHealthState.DISCONNECTED -> AuntieStatusTone.Error
        IntegrationHealthState.CHECKING -> AuntieStatusTone.Neutral
        IntegrationHealthState.UNKNOWN -> AuntieStatusTone.Muted
    }
    IntegrationCard(
        name = row.name,
        purpose = row.description,
        stateLabel = integrationPillLabel(row.state),
        stateTone = tone,
        stateGlow = row.state == IntegrationHealthState.CHECKING,
    )
}

// ─────────────────────────────────────────────────────────────────────────────
// Time off
// ─────────────────────────────────────────────────────────────────────────────

private val US_HOLIDAYS = listOf(
    "new_years" to "New Year's Day",
    "mlk" to "Martin Luther King Jr. Day",
    "presidents" to "Presidents' Day",
    "memorial" to "Memorial Day",
    "juneteenth" to "Juneteenth",
    "independence" to "Independence Day",
    "labor" to "Labor Day",
    "columbus" to "Columbus Day",
    "veterans" to "Veterans Day",
    "thanksgiving" to "Thanksgiving",
    "christmas" to "Christmas Day",
)

/** Full month names for the closure-recurrence pickers below (index 0 = January). */
private val CLOSURE_MONTH_NAMES = listOf(
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
)

/** Index 0 = ISO weekday 1 (Monday), matching [ClosureEntry.weekday]'s convention. */
private val CLOSURE_WEEKDAY_NAMES =
    listOf("Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday")

private val CLOSURE_NTH_LABELS = listOf("1st", "2nd", "3rd", "4th")

private data class RecurrenceOption(val kind: ClosureRecurrenceKind, val label: String)

/** Order matches the web `RECURRENCE_OPTIONS` in `TimeOffEditor.tsx`. */
private val CLOSURE_RECURRENCE_OPTIONS = listOf(
    RecurrenceOption(ClosureRecurrenceKind.ONCE, "One time (pick a date)"),
    RecurrenceOption(ClosureRecurrenceKind.YEARLY_FIXED, "Every year, same date"),
    RecurrenceOption(ClosureRecurrenceKind.YEARLY_NTH_WEEKDAY, "Every year, same week and day (e.g. 4th Thursday)"),
    RecurrenceOption(ClosureRecurrenceKind.YEARLY_LAST_WEEKDAY, "Every year, last weekday of the month (e.g. last Monday)"),
)

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun TimeOffPanel(
    settings: com.tribetails.auntieos.data.model.BusinessSettings,
    onSettingsChange: (com.tribetails.auntieos.data.model.BusinessSettings) -> Unit,
) {
    val c = AuntieTheme.colors
    val dims = AuntieTheme.dims
    val observed = settings.observedUsHolidays.toSet()

    // The company-holiday add-row. `newHolidayRecurrence` gates which fields
    // below are shown/required: ONCE uses `newHolidayDate` (unchanged); every
    // YEARLY_* kind uses `newHolidayMonth` plus whichever of day/weekday/nth its
    // shape needs, and NEVER a year -- the entire point of the 2026-07-31
    // ruling this panel answers. `null` means "not yet picked".
    var newHolidayRecurrence by remember { mutableStateOf(ClosureRecurrenceKind.ONCE) }
    var newHolidayDate by remember { mutableStateOf("") }
    var newHolidayName by remember { mutableStateOf("") }
    var newHolidayMonth by remember { mutableStateOf<Int?>(null) }
    var newHolidayDay by remember { mutableStateOf<Int?>(null) }
    var newHolidayWeekday by remember { mutableStateOf<Int?>(null) }
    var newHolidayNth by remember { mutableStateOf<Int?>(null) }

    var newSpecialDate by remember { mutableStateOf("") }
    var newSpecialHours by remember { mutableStateOf("") }

    val holidayAddEnabled = companyHolidayAddEnabled(
        recurrence = newHolidayRecurrence,
        name = newHolidayName,
        date = newHolidayDate,
        month = newHolidayMonth,
        day = newHolidayDay,
        weekday = newHolidayWeekday,
        nth = newHolidayNth,
    )

    DenPanel(
        title = "Time Off",
        subtitle = "Holidays the Den observes and your own closures.",
        collapsible = true,
        initiallyExpanded = false,
    ) {
        Column(verticalArrangement = Arrangement.spacedBy(dims.space4)) {
            AuntieFieldLabel(text = "US Holidays Observed")
            Column {
                US_HOLIDAYS.forEachIndexed { idx, (id, name) ->
                    AuntieSettingRow(
                        title = name,
                        showDivider = idx < US_HOLIDAYS.lastIndex,
                        trailing = {
                            AuntieToggle(
                                checked = id in observed,
                                onCheckedChange = { on ->
                                    val next = if (on) observed + id else observed - id
                                    onSettingsChange(settings.copy(observedUsHolidays = next.toList()))
                                },
                            )
                        },
                    )
                }
            }

            AuntieFieldLabel(text = "Company Holidays")
            Text(
                "Dates this business is closed: one-time, or repeating every year (e.g. a US national holiday).",
                style = AuntieTheme.typography.bodySmall,
                color = c.textDim,
            )

            settings.companyHolidays.forEachIndexed { idx, entry ->
                val parsed = parseClosureEntry(entry)
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.SpaceBetween,
                ) {
                    Column(modifier = Modifier.weight(1f)) {
                        Text(parsed.name.ifBlank { "Holiday" }, style = AuntieTheme.typography.bodyMedium, color = c.textPrimary)
                        Text(describeClosureRecurrence(parsed), style = AuntieTheme.typography.bodySmall, color = c.textDim)
                    }
                    GhostButton(
                        label = "Remove",
                        onClick = {
                            onSettingsChange(
                                settings.copy(
                                    companyHolidays = settings.companyHolidays.filterIndexed { i, _ -> i != idx }
                                )
                            )
                        },
                    )
                }
            }

            Text(
                "Add a US holiday with one click. It already repeats every year.",
                style = AuntieTheme.typography.bodySmall,
                color = c.textDim,
            )
            FlowRow(horizontalArrangement = Arrangement.spacedBy(dims.space2), verticalArrangement = Arrangement.spacedBy(dims.space2)) {
                US_HOLIDAY_PRESETS.forEach { preset ->
                    val wire = formatClosureEntry(closureEntryFromPreset(preset))
                    GhostButton(
                        label = preset.name,
                        onClick = { onSettingsChange(settings.copy(companyHolidays = settings.companyHolidays + wire)) },
                        enabled = wire !in settings.companyHolidays,
                    )
                }
            }

            AuntieDropdownField(
                value = CLOSURE_RECURRENCE_OPTIONS.first { it.kind == newHolidayRecurrence },
                options = CLOSURE_RECURRENCE_OPTIONS,
                onSelect = { newHolidayRecurrence = it.kind },
                displayText = { it.label },
                label = "Recurrence",
                modifier = Modifier.fillMaxWidth(),
            )

            if (newHolidayRecurrence == ClosureRecurrenceKind.ONCE) {
                AuntieField(
                    value = newHolidayDate,
                    onValueChange = { newHolidayDate = it },
                    label = "Date (YYYY-MM-DD)",
                    modifier = Modifier.fillMaxWidth(),
                )
            } else {
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(dims.space2),
                ) {
                    AuntieDropdownField(
                        value = newHolidayMonth,
                        options = (1..12).toList(),
                        onSelect = { newHolidayMonth = it },
                        displayText = { CLOSURE_MONTH_NAMES[it - 1] },
                        label = "Month",
                        placeholder = "Pick a month",
                        modifier = Modifier.weight(1f),
                    )
                    if (newHolidayRecurrence == ClosureRecurrenceKind.YEARLY_FIXED) {
                        AuntieDropdownField(
                            value = newHolidayDay,
                            options = (1..31).toList(),
                            onSelect = { newHolidayDay = it },
                            displayText = { it.toString() },
                            label = "Day",
                            placeholder = "Pick a day",
                            modifier = Modifier.weight(1f),
                        )
                    } else {
                        AuntieDropdownField(
                            value = newHolidayWeekday,
                            options = (1..7).toList(),
                            onSelect = { newHolidayWeekday = it },
                            displayText = { CLOSURE_WEEKDAY_NAMES[it - 1] },
                            label = "Weekday",
                            placeholder = "Pick a weekday",
                            modifier = Modifier.weight(1f),
                        )
                        if (newHolidayRecurrence == ClosureRecurrenceKind.YEARLY_NTH_WEEKDAY) {
                            AuntieDropdownField(
                                value = newHolidayNth,
                                options = (1..4).toList(),
                                onSelect = { newHolidayNth = it },
                                displayText = { CLOSURE_NTH_LABELS[it - 1] },
                                label = "Occurrence",
                                placeholder = "Pick",
                                modifier = Modifier.weight(1f),
                            )
                        }
                    }
                }
            }

            AuntieField(
                value = newHolidayName,
                onValueChange = { newHolidayName = it },
                label = "Name",
                modifier = Modifier.fillMaxWidth(),
            )
            PrimaryButton(
                label = "Add Company Holiday",
                onClick = {
                    if (holidayAddEnabled) {
                        val wire = formatClosureEntry(
                            ClosureEntry(
                                recurrence = newHolidayRecurrence,
                                name = newHolidayName,
                                date = newHolidayDate,
                                month = newHolidayMonth ?: 0,
                                day = newHolidayDay ?: 0,
                                weekday = newHolidayWeekday ?: 0,
                                nth = newHolidayNth ?: 0,
                            )
                        )
                        onSettingsChange(settings.copy(companyHolidays = settings.companyHolidays + wire))
                        newHolidayRecurrence = ClosureRecurrenceKind.ONCE
                        newHolidayDate = ""
                        newHolidayName = ""
                        newHolidayMonth = null
                        newHolidayDay = null
                        newHolidayWeekday = null
                        newHolidayNth = null
                    }
                },
                enabled = holidayAddEnabled,
                modifier = Modifier.fillMaxWidth(),
            )

            // ── Special hours (15.5): modified hours on specific dates ──
            AuntieFieldLabel(text = "Special Hours")
            Text(
                "Modified operating hours for a specific date (a short day, late open). Not a full closure.",
                style = AuntieTheme.typography.bodySmall,
                color = c.textDim,
            )
            settings.specialHours.forEachIndexed { idx, entry ->
                val parts = entry.split("|", limit = 2)
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.SpaceBetween,
                ) {
                    Column(modifier = Modifier.weight(1f)) {
                        Text(parts.getOrElse(1) { "Special hours" }, style = AuntieTheme.typography.bodyMedium, color = c.textPrimary)
                        Text(parts.getOrElse(0) { entry }, style = AuntieTheme.typography.bodySmall, color = c.textDim)
                    }
                    GhostButton(
                        label = "Remove",
                        onClick = {
                            onSettingsChange(
                                settings.copy(specialHours = settings.specialHours.filterIndexed { i, _ -> i != idx })
                            )
                        },
                    )
                }
            }
            SpecialHoursEditor(
                date = newSpecialDate,
                onDate = { newSpecialDate = it },
                hours = newSpecialHours,
                onHours = { newSpecialHours = it },
                onAdd = {
                    onSettingsChange(
                        settings.copy(specialHours = settings.specialHours + "$newSpecialDate|$newSpecialHours")
                    )
                    newSpecialDate = ""
                    newSpecialHours = ""
                },
            )
        }
    }
}

/**
 * The special-hours add editor (15.5): two fields + an "Add Special Hours" button
 * gated by [specialHoursAddEnabled]. Extracted to an internal composable so the real
 * widget + its enablement gate can be rendered directly by the Robolectric compose
 * UI test (behavior-neutral: same fields, same gate, same Add callback that fires
 * only when enabled).
 */
@Composable
internal fun SpecialHoursEditor(
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
        verticalAlignment = Alignment.Bottom,
    ) {
        AuntieField(
            value = date,
            onValueChange = onDate,
            label = "Date (YYYY-MM-DD)",
            modifier = Modifier.weight(1f),
        )
        AuntieField(
            value = hours,
            onValueChange = onHours,
            label = "Hours (e.g. 08:00-12:00)",
            modifier = Modifier.weight(1f),
        )
    }
    PrimaryButton(
        label = "Add Special Hours",
        onClick = { if (specialHoursAddEnabled(date, hours)) onAdd() },
        enabled = specialHoursAddEnabled(date, hours),
        modifier = Modifier.fillMaxWidth(),
    )
}

/**
 * A special-hours entry (15.5) is addable only with a valid YYYY-MM-DD date AND
 * non-blank hours containing no pipe (the "date|hours" encoding must stay
 * parseable). Mirrors the web specialHoursAddEnabled. Pure; unit-tested.
 */
internal fun specialHoursAddEnabled(date: String, hours: String): Boolean =
    Regex("""^\d{4}-\d{2}-\d{2}$""").matches(date) && hours.isNotBlank() && !hours.contains('|')

// ─────────────────────────────────────────────────────────────────────────────
// Developer tools
// ─────────────────────────────────────────────────────────────────────────────

// DeveloperToolsPanel + the "Rebuild Database from JSON" button were removed
// 2026-07-16. That button called performJsonToFirestoreMigration (util/Migration.kt,
// also deleted), which WIPED the live kinfolk/kin/dossiers/the_411 collections and
// re-uploaded a bundled April snapshot. It shipped in the release APK behind a
// single confirm dialog, one mis-tap from deleting months of production client
// data. The migration was a one-time April task; its bundled asset also put real
// client dossiers inside every APK. Owner ruling 2026-07-16: remove all three. The
// real data is preserved as an untracked backup, not shipped.

// ─────────────────────────────────────────────────────────────────────────────
// Tags (2026-07-19 Tags port), the two vocabularies the Den puts on households
// and pets. Ported from the React admin's TagsEditor screen
// (auntieos-admin src/screens/TagsEditor.tsx); this is the Den's authoring
// surface for the same two business_settings fields, so the caps, the palette,
// the emoji set, and the error copy are pinned to React's, not re-invented.
// ─────────────────────────────────────────────────────────────────────────────

/** Accessible swatch labels, matching React's COLOR_LABELS. Unknown token -> the raw token. */
private val TAG_COLOR_LABELS: Map<String, String> = mapOf(
    "teal" to "Teal",
    "orange" to "Orange",
    "pink" to "Pink",
    "purple" to "Purple",
    "coral" to "Coral",
    "gold" to "Gold",
    "green" to "Green",
)

/** Label for a palette swatch. Falls back to the raw token so a new token still reads. Pure; tested. */
internal fun tagColorLabel(token: String): String = TAG_COLOR_LABELS[token] ?: token

/**
 * A small curated emoji set (no picker dependency); the field beside it takes any
 * other emoji the operator types or pastes. Same fourteen, same order, as React.
 */
internal val CURATED_TAG_EMOJI: List<String> =
    listOf("⭐", "🐾", "❤️", "🔥", "🦴", "🏠", "🚩", "💊", "🍗", "⚠️", "✅", "💤", "🌙", "📌")

/** The custom-emoji field cap, matching React's maxLength. Pure; tested. */
internal const val MAX_TAG_EMOJI_LENGTH: Int = 8

/** Clamp a typed icon to the emoji field's cap. Pure; tested. */
internal fun clampTagEmoji(raw: String): String = raw.take(MAX_TAG_EMOJI_LENGTH)

/** The vocabulary for a scope, decoded through the drop rules. Never throws. Pure; tested. */
internal fun tagVocabFor(settings: BusinessSettings, scope: TagScope): List<TagDef> = when (scope) {
    TagScope.HOUSEHOLD -> settings.householdTagDefs()
    TagScope.PET -> settings.petTagDefs()
}

/**
 * Put a vocabulary back on the settings for one scope, leaving the other scope's
 * list untouched. The color `css` string goes out exactly as it came in: React
 * paints its chips from that string, so rewriting it would blank the React admin.
 * Pure; tested.
 */
internal fun settingsWithTagVocab(
    settings: BusinessSettings,
    scope: TagScope,
    defs: List<TagDef>,
): BusinessSettings = when (scope) {
    TagScope.HOUSEHOLD -> settings.withHouseholdTagDefs(defs)
    TagScope.PET -> settings.withPetTagDefs(defs)
}

/**
 * The reason [name] cannot be added to [vocab], or null when it can. Runs the
 * add for real and reports its message rather than re-deriving the rules, so the
 * Den can never drift from [addTag] on the checks OR on the user-facing copy.
 * Pure; tested.
 */
internal fun tagVocabAddError(vocab: List<TagDef>, name: String): String? =
    runCatching { addTag(vocab, TagDef(name = name, color = DEFAULT_TAG_COLOR, icon = "")) }
        .exceptionOrNull()
        ?.message

/** The Add button lights only for a non-blank normalized name. Pure; tested. */
internal fun tagVocabAddEnabled(name: String): Boolean = normalizeTagName(name) != ""

/** True when the draft vocabulary differs from what was loaded (name, color, or order). Pure; tested. */
internal fun tagVocabDirty(baseline: List<TagDef>, draft: List<TagDef>): Boolean = baseline != draft

/** Empty-state copy for a vocabulary, e.g. "No household tags yet. Add one below." Pure; tested. */
internal fun emptyTagVocabHint(scopeNoun: String): String = "No $scopeNoun tags yet. Add one below."

/**
 * Drop one tag from ONE scope's vocabulary, leaving the other scope alone.
 *
 * #713: the same name may legitimately sit in both lists ("Meds Needed" on a
 * household and on a pet), so a household delete must never reach into the pet
 * vocabulary. Pure; tested.
 */
internal fun withTagRemoved(
    settings: BusinessSettings,
    scope: TagScope,
    name: String,
): BusinessSettings = settingsWithTagVocab(settings, scope, removeTag(tagVocabFor(settings, scope), name))

/**
 * What the delete actually did, in the operator's terms. The count is the
 * server's, because this screen reads business_settings alone and has no
 * directory roster to count against. Pure; tested.
 */
internal fun tagRemovedSummary(scope: TagScope, name: String, recordsTouched: Int): String {
    val one = if (scope == TagScope.HOUSEHOLD) "household" else "Kin"
    val many = if (scope == TagScope.HOUSEHOLD) "households" else "Kin"
    return when (recordsTouched) {
        0 -> "\"$name\" is gone. No $many were carrying it."
        1 -> "\"$name\" is gone. It came off 1 $one."
        else -> "\"$name\" is gone. It came off $recordsTouched $many."
    }
}

/** The confirm prompt shown before a delete runs. Pure; tested. */
internal fun tagRemoveConfirmBody(scope: TagScope, name: String): String =
    if (scope == TagScope.HOUSEHOLD) {
        "This takes \"$name\" off the household tag list and off every household carrying it. " +
            "It happens right away, without waiting for Save, and it cannot be undone."
    } else {
        "This takes \"$name\" off the Kin tag list and off every Kin carrying it. " +
            "It happens right away, without waiting for Save, and it cannot be undone."
    }

/**
 * The seven palette swatches. Selection is by TOKEN, which is exact and
 * case-sensitive, unlike a name. Painting goes through the shared [tagToneRole],
 * the same resolver the chips use, so the swatch an operator picks here and the
 * chip it produces on a profile can never drift apart. The stored `css` string is
 * a CSS variable reference React paints with: it is round-tripped, never parsed.
 */
@Composable
private fun TagColorPicker(value: TagColor, enabled: Boolean, onChange: (TagColor) -> Unit) {
    val c = AuntieTheme.colors
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        TAG_PALETTE.forEach { swatch ->
            val selected = swatch.token == value.token
            val tone = tagToneRole(swatch.token).color(c)
            Box(
                modifier = Modifier
                    .size(26.dp)
                    .clip(CircleShape)
                    .background(tone)
                    .border(
                        width = if (selected) 2.dp else 1.dp,
                        color = if (selected) c.textPrimary else c.border,
                        shape = CircleShape,
                    )
                    .clickable(enabled = enabled) { onChange(swatch) },
                contentAlignment = Alignment.Center,
            ) {
                if (selected) {
                    Icon(
                        Lucide.Check,
                        contentDescription = tagColorLabel(swatch.token),
                        tint = c.background,
                        modifier = Modifier.size(14.dp),
                    )
                }
            }
        }
    }
}

/**
 * The curated emoji row plus a free-text field for anything else. "None" sets the
 * icon to "" (a real value meaning no icon), never null: React drops any row
 * whose icon is not a string, so a null here would make the row vanish there.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun TagEmojiPicker(value: String, enabled: Boolean, onChange: (String) -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        FlowRow(
            horizontalArrangement = Arrangement.spacedBy(6.dp),
            verticalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            AuntieChip(
                selected = value == "",
                onClick = { if (enabled) onChange("") },
                label = "None",
            )
            CURATED_TAG_EMOJI.forEach { emoji ->
                AuntieChip(
                    selected = value == emoji,
                    onClick = { if (enabled) onChange(emoji) },
                    label = emoji,
                )
            }
        }
        AuntieField(
            value = value,
            onValueChange = { onChange(clampTagEmoji(it)) },
            label = "Custom emoji",
            placeholder = "or type one",
            enabled = enabled,
            modifier = Modifier.fillMaxWidth(),
        )
    }
}

/**
 * One vocabulary (household or pet): the existing rows with their color/emoji
 * controls and a Remove, plus the add form. Every edit goes through the pure
 * helpers in TagModels.kt, so a name is normalized once and duplicates are caught
 * case-insensitively ("vip" never lands beside "VIP").
 *
 * Remove is the exception (#713): it does not hand back a shortened list, it
 * asks the panel to run the server-side delete. See [TagVocabularyPanel].
 */
@Composable
private fun TagVocabSection(
    title: String,
    subtitle: String,
    scopeNoun: String,
    tags: List<TagDef>,
    enabled: Boolean,
    onChange: (List<TagDef>) -> Unit,
    onRequestRemove: (String) -> Unit,
) {
    val c = AuntieTheme.colors
    var newName by remember { mutableStateOf("") }
    var newColor by remember { mutableStateOf(DEFAULT_TAG_COLOR) }
    var newIcon by remember { mutableStateOf("") }
    var addError by remember { mutableStateOf<String?>(null) }

    DenPanel(
        title = title,
        subtitle = subtitle,
    ) {
        Column(verticalArrangement = Arrangement.spacedBy(16.dp)) {
            if (tags.isEmpty()) {
                EmptyHint(emptyTagVocabHint(scopeNoun))
            } else {
                tags.forEach { def ->
                    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        Row(
                            modifier = Modifier.fillMaxWidth(),
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.SpaceBetween,
                        ) {
                            // The chip resolved against this very vocabulary, so the
                            // operator sees exactly what a profile will show.
                            TagChip(name = def.name, vocab = tags)
                            GhostButton(
                                label = "Remove",
                                enabled = enabled,
                                onClick = { onRequestRemove(def.name) },
                            )
                        }
                        TagColorPicker(
                            value = def.color,
                            enabled = enabled,
                            onChange = { onChange(editTag(tags, def.name, color = it)) },
                        )
                        TagEmojiPicker(
                            value = def.icon,
                            enabled = enabled,
                            onChange = { onChange(editTag(tags, def.name, icon = it)) },
                        )
                    }
                }
            }

            // Fail loud: the add rules are user-facing copy, shown verbatim.
            addError?.let { msg ->
                AuntieBanner(
                    tone = AuntieBannerTone.Error,
                    title = "Couldn't add tag",
                    onDismiss = { addError = null },
                ) {
                    Text(msg, style = AuntieTheme.typography.bodySmall, color = c.textDim)
                }
            }

            AuntieField(
                value = newName,
                onValueChange = { newName = it },
                label = "New $scopeNoun tag name",
                placeholder = "e.g. VIP",
                enabled = enabled,
                modifier = Modifier.fillMaxWidth(),
            )
            TagColorPicker(value = newColor, enabled = enabled, onChange = { newColor = it })
            TagEmojiPicker(value = newIcon, enabled = enabled, onChange = { newIcon = it })
            PrimaryButton(
                label = "Add tag",
                enabled = enabled && tagVocabAddEnabled(newName),
                onClick = {
                    val why = tagVocabAddError(tags, newName)
                    if (why != null) {
                        addError = why
                    } else {
                        onChange(addTag(tags, TagDef(name = newName, color = newColor, icon = newIcon)))
                        newName = ""
                        newColor = DEFAULT_TAG_COLOR
                        newIcon = ""
                        addError = null
                    }
                },
                modifier = Modifier.fillMaxWidth(),
            )
        }
    }
}

/**
 * The Den's Tags vocabulary editor: both vocabularies, edited locally and saved
 * together. React's editor sends `{ householdTags, petTags }` in one write, so
 * this does the same through a single [BusinessSettings] save; the two lists are
 * only written independently from a profile's inline promotion, not here.
 *
 * REMOVE IS THE ONE EDIT THAT DOES NOT WAIT FOR SAVE (#713). It used to filter
 * the local list like the others, which left every household and pet still
 * carrying the deleted name. Operator ruling: "IF THE TAG IS DELETED THEN IT
 * GOES AWAY COMPLETELY." Remove now confirms, then goes through
 * `removeBusinessTag`, which drops the vocabulary row AND strips the name off
 * every `kinfolk` or `kin` doc in one server-side pass, and reports the count.
 */
@Composable
private fun TagVocabularyPanel(
    settings: BusinessSettings,
    isLoading: Boolean,
    onSettingsChange: (BusinessSettings) -> Unit,
    removeBusy: Boolean,
    removeMessage: String?,
    removeError: String?,
    onRemoveTag: (TagScope, String) -> Unit,
    onDismissRemoveFeedback: () -> Unit,
) {
    val c = AuntieTheme.colors
    val baselineHousehold = remember(settings) { tagVocabFor(settings, TagScope.HOUSEHOLD) }
    val baselinePet = remember(settings) { tagVocabFor(settings, TagScope.PET) }
    // Re-seeded whenever a load or a save lands a new vocabulary on the settings.
    var household by remember(baselineHousehold) { mutableStateOf(baselineHousehold) }
    var pet by remember(baselinePet) { mutableStateOf(baselinePet) }
    val dirty = tagVocabDirty(baselineHousehold, household) || tagVocabDirty(baselinePet, pet)
    // The tag Remove was pressed on, held until the operator confirms the cascade.
    var pendingRemove by remember { mutableStateOf<Pair<TagScope, String>?>(null) }

    Column(verticalArrangement = Arrangement.spacedBy(20.dp)) {
        AuntieBanner(tone = AuntieBannerTone.Info, dashed = true, pillLabel = "Heads up") {
            Text(
                "Removing a tag deletes it everywhere. It comes off the list here and off every household or Kin carrying it, as soon as you confirm. Adding the same name back later starts it with nobody on it.",
                style = AuntieTheme.typography.bodySmall,
                color = c.textDim,
            )
        }

        removeError?.let { msg ->
            AuntieBanner(
                tone = AuntieBannerTone.Error,
                title = "Remove failed",
                onDismiss = onDismissRemoveFeedback,
            ) {
                Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Text(msg, style = AuntieTheme.typography.bodySmall, color = c.textDim)
                    Text(
                        "The tag is still on the list, so you can try again.",
                        style = AuntieTheme.typography.bodySmall,
                        color = c.textDim,
                    )
                }
            }
        }

        removeMessage?.let { msg ->
            AuntieBanner(
                tone = AuntieBannerTone.Success,
                title = "Tag removed",
                onDismiss = onDismissRemoveFeedback,
            ) {
                Text(msg, style = AuntieTheme.typography.bodySmall, color = c.textDim)
            }
        }

        TagVocabSection(
            title = "Household tags",
            subtitle = "Label a household (a kinfolk), e.g. VIP or Slow pay. Used by broadcasts and KinTale rules.",
            scopeNoun = "household",
            tags = household,
            enabled = !isLoading && !removeBusy,
            onChange = { household = it },
            onRequestRemove = { pendingRemove = TagScope.HOUSEHOLD to it },
        )

        TagVocabSection(
            title = "Pet tags",
            subtitle = "Label a pet (a kin), e.g. Reactive or On meds.",
            scopeNoun = "pet",
            tags = pet,
            enabled = !isLoading && !removeBusy,
            onChange = { pet = it },
            onRequestRemove = { pendingRemove = TagScope.PET to it },
        )

        PrimaryButton(
            label = "Save tags",
            enabled = dirty && !isLoading && !removeBusy,
            onClick = {
                onSettingsChange(
                    settingsWithTagVocab(
                        settingsWithTagVocab(settings, TagScope.HOUSEHOLD, household),
                        TagScope.PET,
                        pet,
                    )
                )
            },
            modifier = Modifier.fillMaxWidth(),
        )
    }

    pendingRemove?.let { (scope, name) ->
        androidx.compose.material3.AlertDialog(
            onDismissRequest = { if (!removeBusy) pendingRemove = null },
            title = { Text("Remove \"$name\"?") },
            text = {
                Text(
                    tagRemoveConfirmBody(scope, name),
                    style = AuntieTheme.typography.bodySmall,
                    color = c.textDim,
                )
            },
            confirmButton = {
                PrimaryButton(
                    label = if (removeBusy) "Removing…" else "Remove everywhere",
                    enabled = !removeBusy,
                    onClick = {
                        onRemoveTag(scope, name)
                        pendingRemove = null
                    },
                )
            },
            dismissButton = {
                GhostButton(
                    label = "Cancel",
                    enabled = !removeBusy,
                    onClick = { pendingRemove = null },
                )
            },
        )
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Vet clinics (spec 29 item 8), shared vet_clinics catalog manager. Mirrors web.
// ─────────────────────────────────────────────────────────────────────────────

/** True when [draft]'s editable fields differ from [original] (ignores id/timestamps). Pure; tested. */
internal fun vetClinicFieldsChanged(original: VetClinic, draft: VetClinic): Boolean =
    original.name.trim()    != draft.name.trim() ||
    original.phone.trim()   != draft.phone.trim() ||
    original.address.trim() != draft.address.trim() ||
    original.website.trim() != draft.website.trim() ||
    original.hours.trim()   != draft.hours.trim() ||
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

/** Pending = a LIVE kinfolk submission awaiting approval. A rejected one is retired, so it is not work. Pure; tested. */
internal fun pendingVetClinics(all: List<VetClinic>): List<VetClinic> = all.filter { !it.verified && !it.archived }
/** Approved = everything visible to households (verified, incl. legacy defaults). Pure; tested. */
internal fun approvedVetClinics(all: List<VetClinic>): List<VetClinic> = all.filter { it.verified }
/** Live catalog rows: approved AND not retired. Pure; tested. */
internal fun activeVetClinics(all: List<VetClinic>): List<VetClinic> = all.filter { it.verified && !it.archived }
/** Retired rows, kept so the households pointing at them still resolve. Pure; tested. */
internal fun archivedVetClinics(all: List<VetClinic>): List<VetClinic> = all.filter { it.archived }

/** The vet slots one household holds, for the clinic usage count. */
data class VetClinicHouseholdRef(
    val vetClinicId: String = "",
    val vetClinicName: String = "",
    val emergencyVetClinicId: String = "",
    val emergencyVetClinicName: String = "",
)

/** [linked] = reachable by a correction; [unlinked] = same name, no id, unreachable. */
data class VetClinicUsage(val linked: Int = 0, val unlinked: Int = 0)

/**
 * How many households read this clinic's number, split by whether a correction
 * can actually reach them. Pure; tested.
 *
 * [VetClinicUsage.linked] households carry the clinic's document id, so
 * `updateVetClinic`'s fan-out rewrites their stored name, phone and address.
 * [VetClinicUsage.unlinked] households merely have the same clinic NAME typed
 * in with an empty id, which every household written before 2026-07-25 does.
 * Nothing can find those from the catalog, so a correction never reaches them.
 *
 * The two are reported separately rather than summed. Telling the operator
 * "5 households" when only 2 will receive the corrected phone number overstates
 * the repair, on the one screen where that number matters most. This replaces
 * `vetClinicHouseholdCount`, which matched on name alone and so counted both
 * kinds as the same thing.
 */
/**
 * Case and whitespace insensitive, matching `submitVetClinic`'s dedupe rule and
 * the React `normClinicName`. Collapsing runs of whitespace is the part that
 * matters: a household holding "Riverside  Animal Hospital" is on the same
 * practice as the catalog's "Riverside Animal Hospital", and a plain `equals`
 * would count it as neither linked nor name-matched, so the operator would be
 * told nobody uses a clinic that somebody does.
 */
private fun normVetClinicName(s: String): String =
    s.lowercase().replace(Regex("\\s+"), " ").trim()

internal fun vetClinicUsage(clinic: VetClinic, households: List<VetClinicHouseholdRef>): VetClinicUsage {
    val id = clinic.id
    val name = normVetClinicName(clinic.name)
    var linked = 0
    var unlinked = 0
    for (h in households) {
        val idHit = id.isNotBlank() && (h.vetClinicId == id || h.emergencyVetClinicId == id)
        if (idHit) {
            linked++
            continue
        }
        if (name.isEmpty()) continue
        // Only a name match in a slot holding NO id. A household linked to a
        // different clinic that happens to share a name is not this clinic's.
        val looseRegular = h.vetClinicId.isBlank() && normVetClinicName(h.vetClinicName) == name
        val looseEmergency = h.emergencyVetClinicId.isBlank() &&
            normVetClinicName(h.emergencyVetClinicName) == name
        if (looseRegular || looseEmergency) unlinked++
    }
    return VetClinicUsage(linked = linked, unlinked = unlinked)
}

/**
 * The Vet clinics section, matched to `ui-ideas/auntieos-vet-clinics-2026-05-27.html`
 * (issue #755) and to the web screen: the kit hero with Add clinic in its
 * trailing slot, a controls row of search field and count pill, then the bank as
 * cards straight on the ground. The mock draws one section; the approval queue
 * and the retired rows are not in it and sit in kit panels above and below the
 * bank, so the queue reads as work and the archive as an archive while the bank
 * stays the mock's bare grid.
 *
 * The section's explanation is the hero's info tooltip, never a banner: the
 * concept's "New admin surface" banner was a note about where the mock came
 * from (annotated there), and the shared-bank paragraph that stood here was
 * explanatory copy of the kind the 2026-09-11 subtitle ruling moved behind the
 * "i". The error, notice and near-match banners stay: those are state.
 */
@Composable
private fun VetClinicsPanel(
    vm: VetClinicsViewModel = viewModel { VetClinicsViewModel(AuntieOSApp.instance.repository) },
) {
    val dims = AuntieTheme.dims
    val clinics by vm.clinics.collectAsState()
    val error by vm.error.collectAsState()
    val notice by vm.notice.collectAsState()
    // Null until the household read lands. Rendered as "checking", never as
    // zero: the control beside the badge retires the clinic, so "nobody uses
    // this" must not look like "we have not been able to check".
    val households by vm.households.collectAsState()
    val choice by vm.pendingChoice.collectAsState()
    var query by remember { mutableStateOf("") }
    var adding by remember { mutableStateOf(false) }

    val pending = pendingVetClinics(clinics)
    val bank = activeVetClinics(clinics)
    val approved = filterVetClinics(bank, query)
    val retired = filterVetClinics(archivedVetClinics(clinics), query)

    Column(verticalArrangement = Arrangement.spacedBy(dims.space5)) {
        DenScreenHeading(
            kicker = "The Den · Directory",
            title = "Vet",
            accentTail = "clinics",
            subtitle = "The shared bank every household and the kinfolk portal pick from. " +
                "Correcting a clinic here rewrites the copy stored on every household linked to it, " +
                "so the number on file at a doorstep changes with it.",
            trailing = {
                PrimaryButton(
                    label = "Add clinic",
                    enabled = !adding,
                    onClick = { adding = true },
                    leading = { Icon(Lucide.Plus, contentDescription = null, modifier = Modifier.size(16.dp)) },
                )
            },
        )

        // Fail loud: surface any add / save / retire / approve failure, never swallow it.
        error?.let { msg ->
            AuntieBanner(tone = AuntieBannerTone.Error, title = "Vet clinic action failed") {
                Text(msg, style = AuntieTheme.typography.bodySmall, color = AuntieTheme.colors.textDim)
            }
        }
        // A landed write says how far it reached, never only that it landed.
        notice?.let { msg ->
            AuntieBanner(tone = AuntieBannerTone.Success, title = "Done") {
                Text(msg, style = AuntieTheme.typography.bodySmall, color = AuntieTheme.colors.textDim)
            }
        }

        // The queue sits above the bank: it is work, and the mock's banner slot
        // is where anything that wants attention before the controls row goes.
        if (pending.isNotEmpty()) {
            DenPanel(
                title = "Pending approval",
                subtitle = "A household added these from its own record. Approving publishes a clinic " +
                    "to the shared bank. Rejecting retires it, which keeps who submitted it on file " +
                    "rather than discarding the evidence.",
                meta = "${pending.size} submitted",
            ) {
                Column(verticalArrangement = Arrangement.spacedBy(dims.space4)) {
                    pending.forEach { clinic ->
                        PendingVetClinicCard(
                            clinic = clinic,
                            usage = households?.let { vetClinicUsage(clinic, it) },
                            onApprove = { vm.approve(clinic) },
                            onReject = { vm.reject(clinic.id, clinic.name) },
                        )
                    }
                }
            }
        }

        // The mock's `.controls`: the search field and the count pill in one row.
        Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(dims.space3),
            modifier = Modifier.fillMaxWidth(),
        ) {
            AuntieSearchField(
                value = query,
                onValueChange = { query = it },
                placeholder = "Search clinics by name, phone, or address",
                leadingIcon = Lucide.Search,
                onClear = { query = "" },
                modifier = Modifier.weight(1f),
            )
            VetCatalogCount(shown = approved.size, total = bank.size, filtering = query.isNotBlank())
        }

        if (adding) {
            AddVetClinicCard(
                onCreate = { draft -> vm.add(draft); adding = false },
                onCancel = { adding = false },
            )
        }
        // THE CHOICE. The bank already holds something that looks like the
        // clinic just typed, and nothing was written. Using an existing
        // record is listed first; creating a second one is the deliberate
        // fallback (operator ruling 2026-08-01).
        if (choice.isNotEmpty()) {
            AuntieBanner(tone = AuntieBannerTone.Warning, title = "A clinic like that is already in the bank") {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(
                        "Nothing was added. Use one of these, or say yours is a separate practice.",
                        style = AuntieTheme.typography.bodySmall, color = AuntieTheme.colors.textDim,
                    )
                    choice.forEach { cand ->
                        Text(
                            listOf(cand.name, cand.address, cand.phone)
                                .filter { it.isNotBlank() }.joinToString(" · ") +
                                if (!cand.verified) " · waiting for approval" else "",
                            style = AuntieTheme.typography.bodySmall, color = AuntieTheme.colors.textPrimary,
                        )
                    }
                    Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                        GhostButton(label = "Add mine as a different clinic", onClick = { vm.addAnyway() })
                        GhostButton(label = "Cancel", onClick = { vm.clearPendingChoice() })
                    }
                }
            }
        }

        when {
            clinics.isEmpty() && !adding -> EmptyHint(
                "The bank is empty. Add the first clinic, or one will be created the next time a " +
                    "household types a vet into its record.",
            )
            approved.isEmpty() && !adding -> EmptyHint("No clinic matches that search.")
        }
        approved.forEach { clinic ->
            VetClinicRow(
                clinic = clinic,
                usage = households?.let { vetClinicUsage(clinic, it) },
                onSave = { updated -> vm.save(updated) },
                onRetire = { vm.retire(clinic.id, clinic.name) },
            )
        }

        if (retired.isNotEmpty()) {
            DenPanel(
                title = "Retired",
                subtitle = "Retired clinics are hidden from every picker and from the kinfolk portal. " +
                    "They are kept, not deleted: a household already on one still reads the name, " +
                    "phone and address it always did, and restoring one puts it back in the bank.",
                meta = "${retired.size} out of the bank",
            ) {
                Column(verticalArrangement = Arrangement.spacedBy(dims.space4)) {
                    retired.forEach { clinic ->
                        VetClinicRow(
                            clinic = clinic,
                            usage = households?.let { vetClinicUsage(clinic, it) },
                            onSave = { updated -> vm.save(updated) },
                            onRetire = { vm.retire(clinic.id, clinic.name) },
                            retired = true,
                            onRestore = { vm.restore(clinic.id, clinic.name) },
                        )
                    }
                }
            }
        }
    }
}

/**
 * The mock's `.countpill`, beside the search field and in the same capsule:
 * "CATALOG" in mono, then the count. Text, never a control: it states what the
 * grid below holds, and while a search is typed it says how much of the bank
 * is showing.
 */
@Composable
internal fun VetCatalogCount(shown: Int, total: Int, filtering: Boolean) {
    val c = AuntieTheme.colors
    val noun = if (total == 1) "clinic" else "clinics"
    val count = if (filtering) "$shown of $total $noun" else "$total $noun"
    Row(
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        modifier = Modifier
            .height(42.dp)
            .clip(RoundedCornerShape(999.dp))
            .background(c.surfaceGlass)
            .border(AuntieTheme.dims.borderHairline, c.border, RoundedCornerShape(999.dp))
            .padding(horizontal = 14.dp),
    ) {
        Text("CATALOG", style = AuntieTheme.typography.labelSmall, color = c.textDim)
        Text(count, style = AuntieTheme.typography.titleMedium, color = c.textPrimary)
    }
}

/**
 * The mock's `.vcard`: the kit's glass gradient on a hairline at 20dp, 18dp
 * inside. Retired rows wear the same surface: a household is still reading
 * this clinic's number off its own record, so it is not greyed into
 * unreadability.
 */
@Composable
private fun VetCardSurface(content: @Composable ColumnScope.() -> Unit) {
    GlassSurface(cornerRadius = 20.dp, modifier = Modifier.fillMaxWidth()) {
        Column(
            verticalArrangement = Arrangement.spacedBy(12.dp),
            modifier = Modifier.padding(18.dp),
            content = content,
        )
    }
}

/**
 * The mock's `.vtop`: a 50dp tile on a gradient that differs card to card with
 * the same glyph on each (the kit avatar's seeded gradient is that variation;
 * the seed is the id so a rename keeps its colour), the name in serif, the
 * document path in mono under it, and the emergency flag as a compact kit pill.
 */
@Composable
private fun VetCardHeader(clinic: VetClinic) {
    val c = AuntieTheme.colors
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(13.dp)) {
        AuntieAvatar(
            glyph = Lucide.CirclePlus,
            size = 50.dp,
            shape = RoundedCornerShape(15.dp),
            ring = false,
            gradientSeed = clinic.id.ifBlank { clinic.name },
        )
        Column(modifier = Modifier.weight(1f)) {
            Text(
                clinic.name.ifBlank { "Unnamed clinic" },
                style = AuntieTheme.typography.headlineSmall,
                color = c.textPrimary,
            )
            if (clinic.id.isNotBlank()) {
                Text(
                    "vet_clinics/${clinic.id}",
                    style = AuntieTheme.typography.labelSmall,
                    color = c.textDim,
                    modifier = Modifier.padding(top = 3.dp),
                )
            }
        }
        if (clinic.isEmergency) AuntieStatusPill(label = "24 hour", tone = AuntieStatusTone.Orange, compact = true)
    }
}

/**
 * The mock's `.vmeta` row: a teal glyph then the value. Phone, address and
 * hours are always drawn and a blank one reads "Not set", the same as web:
 * this is a record whose gaps are content. Website and notes show only when
 * set. The label reaches TalkBack through the glyph's description, since a
 * phone glyph is not a word.
 */
@Composable
private fun VetDetailLine(label: String, icon: ImageVector, value: String, always: Boolean = true) {
    val shown = value.trim()
    if (shown.isEmpty() && !always) return
    val c = AuntieTheme.colors
    Row(horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.Top) {
        Icon(icon, contentDescription = label, tint = c.kinTeal, modifier = Modifier.size(15.dp))
        Text(
            if (shown.isEmpty()) "Not set" else shown,
            style = AuntieTheme.typography.bodyMedium,
            color = if (shown.isEmpty()) c.textFaint else c.textPrimary,
        )
    }
}

/** The detail rows, in the mock's order, then the two this screen adds. */
@Composable
private fun VetCardDetails(clinic: VetClinic) {
    Column(verticalArrangement = Arrangement.spacedBy(9.dp)) {
        VetDetailLine("Phone", Lucide.Phone, clinic.phone)
        VetDetailLine("Address", Lucide.MapPin, clinic.address)
        // Hours live on the CLINIC: every household using this practice
        // shares them, so there is one copy rather than one per household.
        VetDetailLine("Hours", Lucide.Clock, clinic.hours)
        VetDetailLine("Website", Lucide.Globe, clinic.website, always = false)
        VetDetailLine("Notes", Lucide.StickyNote, clinic.notes, always = false)
    }
}

/**
 * The mock's `.linked`: a teal lock, then the count in mono uppercase with the
 * number in teal bold. `linked` households are the ones a correction actually
 * reaches; `by name only` ones carry the clinic's name with no id, so nothing
 * can find them from the catalog. Summing them would overstate what a save
 * does, on the screen where that matters most. Null usage is "we have not
 * been able to check", never zero.
 */
@Composable
private fun VetUsageLine(usage: VetClinicUsage?) {
    val c = AuntieTheme.colors
    val number = SpanStyle(color = c.kinTeal, fontWeight = FontWeight.Bold, fontSize = 13.sp)
    val text = buildAnnotatedString {
        when {
            usage == null -> append("HOUSEHOLDS: CHECKING")
            usage.linked == 0 && usage.unlinked == 0 -> append("NO HOUSEHOLDS")
            else -> {
                if (usage.linked > 0) {
                    withStyle(number) { append("${usage.linked}") }
                    append(" LINKED")
                }
                if (usage.unlinked > 0) {
                    if (usage.linked > 0) append(" · ")
                    withStyle(number) { append("${usage.unlinked}") }
                    append(" BY NAME ONLY")
                }
            }
        }
    }
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(7.dp)) {
            Icon(Lucide.Lock, contentDescription = null, tint = c.kinTeal, modifier = Modifier.size(14.dp))
            Text(text, style = AuntieTheme.typography.labelSmall, color = if (usage == null) c.textFaint else c.textDim)
        }
        if (usage != null && usage.unlinked > 0) {
            Text(
                "Name-only households are not updated by a save: they carry no clinic id to match on.",
                style = AuntieTheme.typography.bodySmall, color = c.textFaint,
            )
        }
    }
}

@Composable
private fun PendingVetClinicCard(
    clinic: VetClinic,
    usage: VetClinicUsage?,
    onApprove: () -> Unit,
    onReject: () -> Unit,
) {
    var confirmingReject by remember(clinic) { mutableStateOf(false) }
    VetCardSurface {
        VetCardHeader(clinic)
        VetCardDetails(clinic)
        VetCardBase(usage) {
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

/** The mock's `.vbase`: a hairline above, the count left, the actions right. */
@Composable
private fun VetCardBase(usage: VetClinicUsage?, actions: @Composable RowScope.() -> Unit) {
    val c = AuntieTheme.colors
    Column(
        verticalArrangement = Arrangement.spacedBy(10.dp),
        modifier = Modifier
            .fillMaxWidth()
            .drawBehind { drawLine(c.border, Offset.Zero, Offset(size.width, 0f), 1f) }
            .padding(top = 13.dp),
    ) {
        VetUsageLine(usage)
        Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(7.dp),
            content = actions,
        )
    }
}

@Composable
internal fun VetClinicRow(
    clinic: VetClinic,
    /** Null while the household read is in flight. Never rendered as zero. */
    usage: VetClinicUsage?,
    onSave: (VetClinic) -> Unit,
    onRetire: () -> Unit,
    retired: Boolean = false,
    onRestore: () -> Unit = {},
) {
    var editing by remember(clinic) { mutableStateOf(false) }
    var confirmingRetire by remember(clinic) { mutableStateOf(false) }

    VetCardSurface {
        VetCardHeader(clinic)

        if (!editing) {
            VetCardDetails(clinic)
            val vetCtx = LocalContext.current
            VetCardBase(usage) {
                if (clinic.googleMapsUrl.isNotBlank()) {
                    AuntieIconButton(icon = Lucide.MapPin, contentDescription = "Open in Maps", size = 32.dp, onClick = {
                        vetCtx.startActivity(android.content.Intent(android.content.Intent.ACTION_VIEW, android.net.Uri.parse(clinic.googleMapsUrl)))
                    })
                }
                if (clinic.website.isNotBlank()) {
                    AuntieIconButton(icon = Lucide.ExternalLink, contentDescription = "Open website", size = 32.dp, onClick = {
                        vetCtx.startActivity(android.content.Intent(android.content.Intent.ACTION_VIEW, android.net.Uri.parse(clinic.website)))
                    })
                }
                AuntieIconButton(icon = Lucide.Pencil, contentDescription = "Edit clinic", size = 32.dp, onClick = { editing = true })
                if (retired) {
                    // Reversible, so no confirm step: restoring puts the row back
                    // in the bank and changes nothing on any household.
                    GhostButton(label = "Restore", onClick = onRestore)
                } else if (confirmingRetire) {
                    GhostButton(label = "Confirm retire", onClick = { confirmingRetire = false; onRetire() })
                    GhostButton(label = "Cancel", onClick = { confirmingRetire = false })
                } else {
                    // "Retire" on an archive glyph, not the concept's "Remove" on
                    // a trash can: this archives. The row and every household
                    // pointing at it survive, so a label or a glyph promising
                    // removal would misdescribe what the button does.
                    AuntieIconButton(icon = Lucide.Archive, contentDescription = "Retire clinic", size = 32.dp, destructive = true, onClick = { confirmingRetire = true })
                }
            }
        } else {
            VetClinicEditFields(clinic = clinic, onSaved = { onSave(it); editing = false }, onCancel = { editing = false })
        }
    }
}

/** Inline editor for an existing clinic (name/phone/address/website/hours/emergency/notes). */
@Composable
private fun VetClinicEditFields(clinic: VetClinic, onSaved: (VetClinic) -> Unit, onCancel: () -> Unit) {
    var name        by remember(clinic) { mutableStateOf(clinic.name) }
    var phone       by remember(clinic) { mutableStateOf(clinic.phone) }
    var address     by remember(clinic) { mutableStateOf(clinic.address) }
    var website     by remember(clinic) { mutableStateOf(clinic.website) }
    // Hours live on the CLINIC, not on the household that picked it: every
    // household using this practice shares them, so there is one copy here
    // rather than one per household record.
    var hours       by remember(clinic) { mutableStateOf(clinic.hours) }
    var notes       by remember(clinic) { mutableStateOf(clinic.notes) }
    var isEmergency by remember(clinic) { mutableStateOf(clinic.isEmergency) }

    val draft = clinic.copy(name = name, phone = phone, address = address, website = website, hours = hours, notes = notes, isEmergency = isEmergency)
    val canSave = vetClinicSaveEnabled(clinic, draft)

    AuntieField(value = name, onValueChange = { name = it }, label = "Clinic name", modifier = Modifier.fillMaxWidth())
    AuntieField(value = phone, onValueChange = { phone = it }, label = "Phone", modifier = Modifier.fillMaxWidth())
    AuntieField(value = address, onValueChange = { address = it }, label = "Address", modifier = Modifier.fillMaxWidth())
    AuntieField(value = website, onValueChange = { website = it }, label = "Website", modifier = Modifier.fillMaxWidth())
    AuntieField(value = hours, onValueChange = { hours = it }, label = "Hours (shown on every household using this clinic)", modifier = Modifier.fillMaxWidth())
    AuntieField(value = notes, onValueChange = { notes = it }, label = "Notes", modifier = Modifier.fillMaxWidth())
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        AuntieToggle(checked = isEmergency, onCheckedChange = { isEmergency = it })
        Text("Open 24 hours / emergency clinic", style = AuntieTheme.typography.bodySmall, color = AuntieTheme.colors.textPrimary)
    }
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        PrimaryButton(label = "Save", enabled = canSave, onClick = { onSaved(draft.copy(name = name.trim(), phone = phone.trim(), address = address.trim(), website = website.trim(), hours = hours.trim(), notes = notes.trim())) })
        GhostButton(label = "Cancel", onClick = onCancel)
    }
}

/**
 * The add card, opened by the hero's Add clinic and drawn above the bank on the
 * same surface as a clinic, the way the web screen does. Hours are absent here
 * on purpose: a brand new row is added from a phone call or a card, and the
 * hours get curated on the clinic afterwards through Edit.
 */
@Composable
private fun AddVetClinicCard(onCreate: (VetClinic) -> Unit, onCancel: () -> Unit) {
    var name        by remember { mutableStateOf("") }
    var phone       by remember { mutableStateOf("") }
    var address     by remember { mutableStateOf("") }
    var website     by remember { mutableStateOf("") }
    var notes       by remember { mutableStateOf("") }
    var isEmergency by remember { mutableStateOf(false) }

    VetCardSurface {
        Text("New clinic", style = AuntieTheme.typography.headlineSmall, color = AuntieTheme.colors.textPrimary)
        AuntieField(value = name, onValueChange = { name = it }, label = "Clinic name", modifier = Modifier.fillMaxWidth())
        AuntieField(value = phone, onValueChange = { phone = it }, label = "Phone", modifier = Modifier.fillMaxWidth())
        AuntieField(value = address, onValueChange = { address = it }, label = "Address", modifier = Modifier.fillMaxWidth())
        AuntieField(value = website, onValueChange = { website = it }, label = "Website", modifier = Modifier.fillMaxWidth())
        AuntieField(value = notes, onValueChange = { notes = it }, label = "Notes", modifier = Modifier.fillMaxWidth())
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            AuntieToggle(checked = isEmergency, onCheckedChange = { isEmergency = it })
            Text("Open 24 hours / emergency clinic", style = AuntieTheme.typography.bodySmall, color = AuntieTheme.colors.textPrimary)
        }
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            PrimaryButton(
                label = "Add to bank",
                enabled = name.isNotBlank(),
                onClick = {
                    // Admin-authored clinics are approved immediately (verified defaults true).
                    onCreate(VetClinic(name = name.trim(), phone = phone.trim(), address = address.trim(), website = website.trim(), notes = notes.trim(), isEmergency = isEmergency))
                },
            )
            GhostButton(label = "Cancel", onClick = onCancel)
        }
    }
}
