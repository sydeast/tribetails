package com.tribetails.auntieos.ui

import com.composables.icons.lucide.*
import com.composables.icons.lucide.Lucide
import com.tribetails.auntieos.ui.theme.AuntieTheme
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.ui.unit.sp
import androidx.lifecycle.viewmodel.compose.viewModel
import com.tribetails.auntieos.config.FeatureFlags
import com.tribetails.auntieos.config.LocalFeatureFlags
import com.tribetails.auntieos.ui.admin.AdminDataViewModel
import com.tribetails.auntieos.ui.shell.bellBadgeLabel
import com.tribetails.auntieos.ui.shell.unreadNotificationCount

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.ui.draw.clip
import com.tribetails.auntieos.ui.components.AuntieSpinner
import com.tribetails.auntieos.ui.components.PrimaryButton
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.*
import com.google.firebase.auth.FirebaseAuth
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.Alignment
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.height
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.navigation.NavGraph.Companion.findStartDestination
import androidx.navigation.NavType
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.currentBackStackEntryAsState
import androidx.navigation.compose.rememberNavController
import androidx.navigation.navArgument
import com.tribetails.auntieos.AuntieOSApp
import com.tribetails.auntieos.ui.admin.*
import com.tribetails.auntieos.ui.invoices.InvoiceDetailScreen
import com.tribetails.auntieos.ui.invoices.InvoiceDetailViewModel
import com.tribetails.auntieos.ui.admin.AdminGate
import com.tribetails.auntieos.ui.admin.scheduling.EnhancedSchedulingViewModel
import com.tribetails.auntieos.ui.admin.services.ServiceManagementViewModel
import com.tribetails.auntieos.ui.admin.services.ServiceManagementScreen
import com.tribetails.auntieos.ui.calls.CallsScreen
import com.tribetails.auntieos.ui.calls.CallsViewModel
import com.tribetails.auntieos.ui.communicate.*
import com.tribetails.auntieos.ui.directory.*
import com.tribetails.auntieos.ui.home.HomeScreen
import com.tribetails.auntieos.ui.home.HomeViewModel
import com.tribetails.auntieos.ui.settings.SettingsScreen
import com.tribetails.auntieos.ui.settings.SettingsViewModel
import com.tribetails.auntieos.ui.theme.*
import com.tribetails.auntieos.util.CallEventStore
import com.tribetails.auntieos.util.MessageStore
import com.tribetails.auntieos.util.VoicemailStore
import com.tribetails.auntieos.util.fcmTokenFlow
import kotlinx.coroutines.launch

sealed class Screen(val route: String, val label: String, val icon: ImageVector) {
    object Home           : Screen("home",           "Home",        Lucide.House)
    object Directory      : Screen("directory",      "Kinfolk",     Lucide.Users)
    object Communicate    : Screen("communicate",    "Comms",       Lucide.MessageCircle)
    object Inbox          : Screen("inbox",          "Inbox",       Lucide.Inbox)
    object Calls          : Screen("calls",          "Calls",       Lucide.Phone)
    object Calendar       : Screen("calendar",       "Bookings",    Lucide.CalendarDays)
    object AuntieTime     : Screen("auntie_time",    "Auntie Time", Lucide.PawPrint)
    object Dashboard      : Screen("dashboard",      "Admin",       Lucide.LayoutDashboard)
    object Gallery        : Screen("gallery",        "Gallery",     Lucide.Images)

    // Sub-screens
    object Settings       : Screen("settings",       "Settings",    Lucide.Settings)
    object Messaging      : Screen("messaging",      "Chat",        Lucide.MessageCircle)
    object AdminSettings  : Screen("admin_settings", "Admin Prof",  Lucide.Settings)
    object AccountSettings : Screen("account_settings", "Account",  Lucide.Settings)
    // The operator's OWN notification receive-prefs (distinct from AdminNotifications,
    // which is the notifications inbox reached from the bell).
    object AdminNotificationPrefs : Screen("admin_notification_prefs", "My Notifications", Lucide.Bell)
    object AdminLogs      : Screen("admin_logs",     "Logs",        Lucide.Activity)
    object AdminNotifications : Screen("admin_notifications", "Notifications", Lucide.Bell)
    object AdminFeatureFlags : Screen("admin_feature_flags", "Feature Flags", Lucide.Flag)
    object AdminSchedule  : Screen("admin_schedule", "Scheduling Options", Lucide.CalendarDays)
    object KinfolkProfile : Screen("kinfolk_profile/{id}", "Profile", Lucide.Users) {
        fun createRoute(id: String) = "kinfolk_profile/$id"
    }
    object AddKinfolk : Screen("add_kinfolk", "Add Kinfolk", Lucide.Users)
    object EditKinfolk : Screen("edit_kinfolk/{id}", "Edit Kinfolk", Lucide.Users) {
        fun createRoute(id: String) = "edit_kinfolk/$id"
    }
    object AddKin : Screen("add_kin/{kinfolkId}/{kinfolkName}", "Add Kin", Lucide.Users) {
        fun createRoute(kinfolkId: String, kinfolkName: String) = "add_kin/$kinfolkId/$kinfolkName"
    }
    object EditKin : Screen("edit_kin/{kinId}", "Edit Kin", Lucide.Users) {
        fun createRoute(kinId: String) = "edit_kin/$kinId"
    }

    // Admin Data Screens
    object AdminData : Screen("admin_data", "Business Data", Lucide.LayoutDashboard)
    object AdminInvoices : Screen("admin_invoices", "Invoices", Lucide.LayoutDashboard)
    object AdminInvoicesQuote : Screen("admin_invoices_quote/{kinfolkId}", "New Quote", Lucide.LayoutDashboard) {
        fun createRoute(kinfolkId: String) = "admin_invoices_quote/$kinfolkId"
    }
    object InvoiceDetail : Screen("invoice_detail/{invoiceId}", "Invoice Detail", Lucide.LayoutDashboard) {
        fun createRoute(invoiceId: String) = "invoice_detail/$invoiceId"
    }
    // #11: standalone Payments screen removed; payments live on the paid invoice's detail.
    object AdminKinTaleLogs : Screen("admin_kintale_logs", "KinTales", Lucide.LayoutDashboard)
    object AdminTrainingDocs : Screen("admin_training_docs", "Tribal Intel", Lucide.LayoutDashboard)
    object AdminKinCareSessions : Screen("admin_kin_care_sessions", "Auntie Time", Lucide.LayoutDashboard)
    object KinCareDetail        : Screen("kin_care_detail/{kinCareId}", "Kin Care", Lucide.LayoutDashboard) {
        fun createRoute(kinCareId: String): String = "kin_care_detail/$kinCareId"
    }
    object ServiceManagement : Screen("service_management", "Services", Lucide.LayoutDashboard)
    object FormSchemas : Screen("form_schemas", "Form Schemas", Lucide.LayoutList)
    object FormSchemaEditor : Screen("form_schema_editor?schemaId={schemaId}", "Form Schema Editor", Lucide.Pencil) {
        fun createRoute(schemaId: String?): String =
            if (schemaId.isNullOrBlank()) "form_schema_editor" else "form_schema_editor?schemaId=$schemaId"
    }
    object KinTaleTemplates : Screen("kintale_templates", "KinTale Templates", Lucide.Pencil)
    // Template Bank + Assignment merged into one two-tab destination (Decision 2).
    object Templates : Screen("templates", "Templates", Lucide.Mail)
    object KinTaleTemplateEditor : Screen("kintale_template_editor?templateId={templateId}", "Edit Template", Lucide.Pencil) {
        fun createRoute(templateId: String?): String =
            if (templateId.isNullOrBlank()) "kintale_template_editor" else "kintale_template_editor?templateId=$templateId"
    }
    object KinTaleChecklistEditor : Screen("kintale_template_checklist?templateId={templateId}", "Checklist", Lucide.Pencil) {
        fun createRoute(templateId: String?): String = "kintale_template_checklist?templateId=${templateId.orEmpty()}"
    }
    object KinTaleMoodEditor : Screen("kintale_template_moods?templateId={templateId}", "Moods", Lucide.Pencil) {
        fun createRoute(templateId: String?): String = "kintale_template_moods?templateId=${templateId.orEmpty()}"
    }
    object KinTaleReviewBoosterEditor : Screen("kintale_template_review_booster?templateId={templateId}", "Review Booster", Lucide.Pencil) {
        fun createRoute(templateId: String?): String = "kintale_template_review_booster?templateId=${templateId.orEmpty()}"
    }

    // Profile sub-screens
    object HouseholdData : Screen("household_data/{kinfolkId}/{kinfolkName}", "Household Data", Lucide.Users) {
        fun createRoute(kinfolkId: String, kinfolkName: String) = "household_data/$kinfolkId/$kinfolkName"
    }
    object MediaGallery : Screen("media_gallery/{entityId}/{entityType}/{entityName}", "Media Gallery", Lucide.Users) {
        fun createRoute(entityId: String, entityType: String, entityName: String) = "media_gallery/$entityId/$entityType/$entityName"
    }

    // KinTale report (visit recap to kinfolk). reportId is optional ("new" = blank draft).
    object KinTaleReport : Screen("kintale/{sessionId}?reportId={reportId}", "KinTale", Lucide.Pencil) {
        fun createRoute(sessionId: String, reportId: String? = null): String =
            if (reportId.isNullOrBlank()) "kintale/$sessionId" else "kintale/$sessionId?reportId=$reportId"
    }

    object LiveTracking : Screen("live_tracking/{sessionId}/{kinfolkId}/{kinfolkName}", "Live Tracking", Lucide.LayoutDashboard) {
        fun createRoute(sessionId: String, kinfolkId: String, kinfolkName: String) =
            "live_tracking/$sessionId/$kinfolkId/${java.net.URLEncoder.encode(kinfolkName, "UTF-8")}"
    }
    object RouteViewer : Screen("route_viewer/{routeId}/{kinfolkName}", "Route Viewer", Lucide.LayoutDashboard) {
        fun createRoute(routeId: String, kinfolkName: String) =
            "route_viewer/$routeId/${java.net.URLEncoder.encode(kinfolkName, "UTF-8")}"
    }
}

val bottomNavScreens = listOf(Screen.Home, Screen.Directory, Screen.Gallery, Screen.Communicate, Screen.AuntieTime, Screen.Inbox, Screen.Calendar, Screen.Dashboard)

/**
 * Step 4: resolve a notification's targetType/targetId to a nav route for the
 * "open linked item" quick action. Returns null for an unknown type or blank id so
 * the caller can no-op rather than navigating somewhere wrong.
 *   - booking  -> KinCareDetail (the visit / kin_care_session detail screen)
 *   - invoice  -> InvoiceDetail
 *   - kinfolk  -> KinfolkProfile
 *   - kintale  -> the KinTales list (no per-report detail route exists on Android)
 * Pure; unit-tested.
 */
internal fun notificationTargetRoute(targetType: String, targetId: String): String? {
    val id = targetId.trim()
    return when (targetType.trim().lowercase()) {
        "booking" -> if (id.isNotBlank()) Screen.KinCareDetail.createRoute(id) else null
        "invoice" -> if (id.isNotBlank()) Screen.InvoiceDetail.createRoute(id) else null
        "kinfolk" -> if (id.isNotBlank()) Screen.KinfolkProfile.createRoute(id) else null
        "kintale" -> if (id.isNotBlank()) Screen.AdminKinTaleLogs.route else null
        else -> null
    }
}

@Composable
fun AuntieNavHost(
    startOnCalls: Boolean = false,
    startOnMessages: Boolean = false
) {
    val app = AuntieOSApp.instance
    val context = app.applicationContext
    val authUser by app.repository.authStateFlow().collectAsState(initial = null)
    var adminVerified by remember { mutableStateOf<Boolean?>(null) }
    val cachedFcmToken by context.fcmTokenFlow().collectAsState(initial = "")
    val scope = rememberCoroutineScope()

    LaunchedEffect(authUser?.uid) {
        adminVerified = when (authUser) {
            null -> null
            else -> app.repository.isCurrentUserAdmin().getOrDefault(false)
        }
    }
    LaunchedEffect(adminVerified, cachedFcmToken) {
        if (adminVerified == true && cachedFcmToken.isNotBlank()) {
            app.repository.saveDeviceToken(cachedFcmToken)
        }
    }

    when {
        authUser == null -> {
            AdminLoginScreen(
                repository = app.repository,
                onLoginSuccess = {}
            )
            return
        }
        adminVerified == null -> {
            Box(
                modifier = Modifier.fillMaxSize(),
                contentAlignment = Alignment.Center
            ) {
                AuntieSpinner(modifier = Modifier.size(40.dp))
            }
            return
        }
        adminVerified != true -> {
            Column(
                modifier = Modifier.fillMaxSize(),
                verticalArrangement = Arrangement.Center,
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                Text("Admin access required.", style = AuntieTheme.typography.headlineMedium)
                Spacer(modifier = Modifier.height(8.dp))
                Text(authUser?.email ?: authUser?.uid.orEmpty(), style = AuntieTheme.typography.bodyMedium)
                Spacer(modifier = Modifier.height(8.dp))
                PrimaryButton(label = "Sign out", onClick = { scope.launch { app.repository.signOut() } })
            }
            return
        }
    }

    // ViewModels and NavHost only mount after auth confirmed - matches web SignedInApp pattern
    AuthenticatedNavHost(startOnCalls = startOnCalls, startOnMessages = startOnMessages)
}

/**
 * Shell-level top bar (0C, Android parity with web `AppShell.TopBar`). Logo → Home, a
 * REAL global search over the admin's already-loaded data (kinfolk / kin / KinTale),
 * and a bell → Notifications with an unread ping from a real count.
 */
@Composable
private fun ShellTopBar(
    bellEnabled: Boolean,
    unreadCount: Int,
    onHome: () -> Unit,
    onBell: () -> Unit,
    onOpenSearch: () -> Unit,
) {
    val c = AuntieTheme.colors
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .background(c.surface)
            .statusBarsPadding()
            .padding(horizontal = 16.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Box(
            modifier = Modifier
                .size(34.dp)
                .clip(CircleShape)
                .background(c.surfaceGlass)
                .clickable(onClick = onHome),
            contentAlignment = Alignment.Center,
        ) {
            Icon(Lucide.PawPrint, contentDescription = "Home", tint = c.primary, modifier = Modifier.size(18.dp))
        }
        // Real global search: tapping opens the search overlay.
        Row(
            modifier = Modifier
                .weight(1f)
                .widthIn(max = 360.dp)
                .height(40.dp)
                .clip(RoundedCornerShape(10.dp))
                .background(c.surfaceGlass)
                .clickable(onClick = onOpenSearch)
                .padding(horizontal = 12.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Icon(Lucide.Search, contentDescription = "Search", tint = c.textFaint, modifier = Modifier.size(16.dp))
            Text(
                text = "Find a kinfolk, kin, or KinTale",
                style = AuntieTheme.typography.labelSmall,
                color = c.textFaint,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f),
            )
        }
        if (bellEnabled) {
            Box(
                modifier = Modifier
                    .size(40.dp)
                    .clip(CircleShape)
                    .background(c.surfaceGlass)
                    .clickable(onClick = onBell),
                contentAlignment = Alignment.Center,
            ) {
                Icon(Lucide.Bell, contentDescription = "Notifications", tint = c.textDim, modifier = Modifier.size(18.dp))
                val label = bellBadgeLabel(unreadCount)
                if (label != null) {
                    Box(
                        modifier = Modifier
                            .align(Alignment.TopEnd)
                            .padding(4.dp)
                            .size(14.dp)
                            .clip(CircleShape)
                            .background(c.primary),
                        contentAlignment = Alignment.Center,
                    ) {
                        Text(label, style = AuntieTheme.typography.labelSmall, color = c.background, fontSize = 8.sp)
                    }
                }
            }
        }
    }
}

/**
 * Stage 0I loud TEST MODE banner. Persistent (no dismiss) and shown on every
 * admin screen whenever the signed-in account carries the `testTribeId` claim,
 * so the operator always knows the entire app is scoped to one sandbox kinfolk
 * and that nothing they see or write touches live data. Functional copy only.
 */
@Composable
private fun TestModeBanner(testTribeId: String) {
    Box(modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 8.dp)) {
        com.tribetails.auntieos.ui.components.AuntieBanner(
            tone = com.tribetails.auntieos.ui.components.AuntieBannerTone.Warning,
            title = "TEST MODE",
            icon = Lucide.TriangleAlert,
            pillLabel = "SANDBOX",
        ) {
            Text(
                text = "Sandbox account. Every screen is restricted to test kinfolk \"$testTribeId\". No live data is shown or written.",
                style = AuntieTheme.typography.bodyMedium,
                color = AuntieTheme.colors.textPrimary,
            )
        }
    }
}

@Composable
private fun AuthenticatedNavHost(
    startOnCalls: Boolean,
    startOnMessages: Boolean
) {
    val navController = rememberNavController()
    val app = AuntieOSApp.instance
    val context = app.applicationContext

    val homeVm              = remember { HomeViewModel(app.repository) }
    val commVm              = remember { CommunicateViewModel(app.repository) }
    val callsVm             = remember { CallsViewModel(context, app.repository) }
    val settingsVm          = remember { SettingsViewModel(context) }
    val msgVm               = remember { MessagingViewModel(app.repository) }
    val directoryVm         = remember { DirectoryViewModel(app.repository) }
    val schedulingVm        = remember { EnhancedSchedulingViewModel(app.bookingRepository, app.serviceRepository) }
    val serviceManagementVm = remember { ServiceManagementViewModel(app.serviceRepository) }

    val startRoute = when {
        startOnCalls    -> Screen.Calls.route
        startOnMessages -> Screen.Messaging.route
        else            -> Screen.Home.route
    }

    LaunchedEffect(navController) {
        com.tribetails.auntieos.util.CallEventStore.navigateToCalls.collect {
            navController.navigate(Screen.Calls.route) { launchSingleTop = true }
        }
    }
    LaunchedEffect(navController) {
        com.tribetails.auntieos.util.VoicemailStore.navigateToVoicemails.collect {
            navController.navigate(Screen.Calls.route) { launchSingleTop = true }
        }
    }
    LaunchedEffect(navController) {
        com.tribetails.auntieos.util.MessageStore.navigateToMessages.collect {
            navController.navigate(Screen.Messaging.route) { launchSingleTop = true }
        }
    }

    val backStack by navController.currentBackStackEntryAsState()
    val currentRoute = backStack?.destination?.route

    // 17.4 Nav editor: this admin's bottom-nav customization (empty -> default tabs).
    // A failure to read the profile just keeps the default bar (non-blocking).
    val navConfig by produceState(initialValue = emptyList<String>()) {
        val uid = runCatching { FirebaseAuth.getInstance().currentUser?.uid }.getOrNull()
        if (uid != null) {
            runCatching {
                app.repository.observeUserProfile(uid).collect { value = it?.navConfig ?: emptyList() }
            }
        }
    }

    // Central feature flags (0D-android). Fetched once after auth; on failure keep the
    // compile-time defaults (shipped baseline, not fabricated). Provided to the whole authed
    // tree via LocalFeatureFlags so screens gate UI on `LocalFeatureFlags.current.<flag>`.
    var flags by remember { mutableStateOf(FeatureFlags.DEFAULT) }
    LaunchedEffect(Unit) {
        AuntieOSApp.instance.repository.getFeatureFlags()
            .onSuccess { flags = FeatureFlags.fromOverrides(it) }
        // onFailure: keep DEFAULT (suggested items stay dark)
    }

    // Shell top bar (0C). The notification bell is always shown (finished + wired);
    // global search stays flag-gated until its backend lands. Unread is the honest
    // pending-dispatch proxy.
    val showTopBar = true

    // Stage 0I: loud persistent TEST MODE banner. A test admin signs in with the
    // `testTribeId` claim (no admin:true); the whole admin app is then scoped to
    // that one sandbox kinfolk by the repository. The banner is non-dismissible so
    // the operator always knows they are looking at isolated test data.
    var testMode by remember { mutableStateOf(com.tribetails.auntieos.domain.TestMode.OFF) }
    LaunchedEffect(Unit) {
        app.repository.getTestMode().onSuccess { testMode = it }
        // onFailure: keep OFF (claim unreadable -> no false TEST MODE banner)
    }

    val adminVm: AdminDataViewModel = viewModel()
    LaunchedEffect(Unit) { adminVm.loadNotifications() }
    val notifications by adminVm.notifications.collectAsState()
    val unreadCount = unreadNotificationCount(notifications)

    // Stage 0C / Phase 2: REAL shell global search overlay (kinfolk / kin / KinTale).
    var searchOpen by remember { mutableStateOf(false) }

    CompositionLocalProvider(LocalFeatureFlags provides flags) {
    Box(modifier = Modifier.fillMaxSize().background(AuntieTheme.colors.background)) {
    Column(
        modifier = Modifier.fillMaxSize()
    ) {
        if (showTopBar) {
            ShellTopBar(
                bellEnabled   = true,
                unreadCount   = unreadCount,
                onHome        = {
                    navController.navigate(Screen.Home.route) {
                        popUpTo(navController.graph.findStartDestination().id) { saveState = true }
                        launchSingleTop = true
                        restoreState = true
                    }
                },
                onBell        = { navController.navigate(Screen.AdminNotifications.route) { launchSingleTop = true } },
                onOpenSearch  = { searchOpen = true },
            )
        }
        if (testMode.active) {
            TestModeBanner(testTribeId = testMode.testTribeId)
        }
        NavHost(
            navController    = navController,
            startDestination = startRoute,
            modifier         = Modifier.weight(1f)
        ) {
            // Main Tabs
            composable(Screen.Gallery.route) {
                com.tribetails.auntieos.ui.media.GalleryScreen(onBack = { navController.popBackStack() })
            }
            composable(Screen.Home.route) {
                HomeScreen(
                    viewModel             = homeVm,
                    onNavigateToCommunicate = { navController.navigate(Screen.Communicate.route) },
                    onNavigateToCalls     = { navController.navigate(Screen.Calls.route) },
                    onWriteKinTale        = { sessionId ->
                        navController.navigate(Screen.KinTaleReport.createRoute(sessionId))
                    },
                    onLiveTrack = { sessionId, kinfolkId, kinfolkName ->
                        navController.navigate(Screen.LiveTracking.createRoute(sessionId, kinfolkId, kinfolkName))
                    },
                    onViewRoute = { routeId, kinfolkName ->
                        navController.navigate(Screen.RouteViewer.createRoute(routeId, kinfolkName))
                    },
                )
            }
            composable(Screen.Directory.route) {
                DirectoryScreen(
                    viewModel = directoryVm,
                    onKinfolkClick = { id ->
                        navController.navigate(Screen.KinfolkProfile.createRoute(id))
                    },
                    onKinClick = { kinId ->
                        navController.navigate(Screen.EditKin.createRoute(kinId))
                    },
                    onAddKinfolk = { navController.navigate(Screen.AddKinfolk.route) }
                )
            }
            composable(Screen.Communicate.route) {
                CommunicateScreen(viewModel = commVm)
            }
            composable(Screen.Inbox.route) {
                com.tribetails.auntieos.ui.inbox.InboxScreen()
            }
            composable(Screen.Calls.route) {
                CallsScreen(
                    viewModel = callsVm,
                    onGenerateFollowUp = { kinfolkId, transcript ->
                        commVm.prefillFromCall(kinfolkId, transcript)
                        navController.navigate(Screen.Communicate.route) { launchSingleTop = true }
                    }
                )
            }
             composable(Screen.Calendar.route) {
                 ScheduleViewScreen(
                     onBack = { /* Calendar is now a main nav tab, no back needed */ },
                     onNavigateToCommunicate = {
                         navController.navigate(Screen.Communicate.route) { launchSingleTop = true }
                     },
                     onOpenSchedulingOptions = {
                         navController.navigate(Screen.AdminSchedule.route)
                     },
                     viewModel = schedulingVm
                 )
             }
             composable(Screen.AuntieTime.route) {
                 KinCareSessionsScreen(
                     // Main nav tab: no onBack, so no breadcrumb (I11 renders it only
                     // for the Admin Data entry below, which passes a real back).
                     onOpenDetail = { kinCareId ->
                         navController.navigate(Screen.KinCareDetail.createRoute(kinCareId))
                     },
                     onWriteKinTale = { sessionId ->
                         navController.navigate(Screen.KinTaleReport.createRoute(sessionId))
                     },
                     onLiveTrack = { sessionId, kinfolkId, kinfolkName ->
                         navController.navigate(Screen.LiveTracking.createRoute(sessionId, kinfolkId, kinfolkName))
                     },
                 )
             }
             composable(Screen.Dashboard.route) {
                AdminGate(repository = app.repository, onDenied = { navController.popBackStack() }) {
                    AdminDashboardScreen(
                        onNavigateToSchedule = { navController.navigate(Screen.AdminSchedule.route) },
                        onNavigateToBookingManagement = { navController.navigate(Screen.Calendar.route) },
                        onNavigateToSettings = { navController.navigate(Screen.AdminSettings.route) },
                        onNavigateToLogs     = { navController.navigate(Screen.AdminLogs.route) },
                        onNavigateToBusinessData = { navController.navigate(Screen.AdminData.route) },
                        onNavigateToServices = { navController.navigate(Screen.ServiceManagement.route) },
                        onNavigateToFormSchemas = { navController.navigate(Screen.FormSchemas.route) },
                        onNavigateToKinTaleTemplates = { navController.navigate(Screen.KinTaleTemplates.route) },
                        onNavigateToTemplates = { navController.navigate(Screen.Templates.route) },
                        onNavigateToFeatureFlags = { navController.navigate(Screen.AdminFeatureFlags.route) },
                    )
                }
            }
            
            // Sub Screens
            composable(Screen.KinfolkProfile.route) { backStackEntry ->
                val id = backStackEntry.arguments?.getString("id") ?: return@composable
                KinfolkProfileScreen(
                    viewModel = directoryVm,
                    kinfolkId = id,
                    onBack = { navController.popBackStack() },
                    onEdit = { kinfolkId -> navController.navigate(Screen.EditKinfolk.createRoute(kinfolkId)) },
                    onAddKin = { kinfolkId, kinfolkName ->
                        navController.navigate(Screen.AddKin.createRoute(kinfolkId, kinfolkName))
                    },
                    onEditKin = { kinId -> navController.navigate(Screen.EditKin.createRoute(kinId)) },
                    onNavigateToHouseholdData = { kinfolkId, kinfolkName ->
                        navController.navigate(Screen.HouseholdData.createRoute(kinfolkId, kinfolkName))
                    },
                    onNavigateToMediaGallery = { kinfolkId, kinfolkName ->
                        navController.navigate(Screen.MediaGallery.createRoute(kinfolkId, "KINFOLK", kinfolkName))
                    },
                    // K1 (A8): a recent KinTale row opens its report.
                    onOpenReport = { sessionId ->
                        navController.navigate(Screen.KinTaleReport.createRoute(sessionId))
                    },
                )
            }
            composable(Screen.AddKinfolk.route) {
                AddKinfolkScreen(
                    viewModel = directoryVm,
                    onBack = {
                        directoryVm.clearAddKinfolkForm()
                        navController.popBackStack()
                    },
                    onSaved = {
                        directoryVm.clearAddKinfolkForm()
                        navController.popBackStack()
                    }
                )
            }
            composable(Screen.EditKinfolk.route) { backStackEntry ->
                val id = backStackEntry.arguments?.getString("id") ?: return@composable
                EditKinfolkScreen(
                    viewModel = directoryVm,
                    kinfolkId = id,
                    onBack = {
                        directoryVm.clearEditKinfolkForm()
                        navController.popBackStack()
                    },
                    onDeleted = {
                        directoryVm.clearEditKinfolkForm()
                        navController.popBackStack(Screen.Directory.route, false)
                    }
                )
            }
            composable(Screen.AddKin.route) { backStackEntry ->
                val kinfolkId = backStackEntry.arguments?.getString("kinfolkId") ?: return@composable
                val kinfolkName = backStackEntry.arguments?.getString("kinfolkName") ?: return@composable
                AddKinScreen(
                    viewModel = directoryVm,
                    kinfolkId = kinfolkId,
                    kinfolkName = kinfolkName,
                    onBack = {
                        directoryVm.clearAddKinForm()
                        navController.popBackStack()
                    },
                    onSaved = {
                        directoryVm.clearAddKinForm()
                        navController.popBackStack()
                    }
                )
            }
            composable(Screen.Settings.route) {
                SettingsScreen(
                    viewModel = settingsVm,
                    onNavigateToAdminDashboard = { navController.navigate(Screen.Dashboard.route) }
                )
            }
            composable(Screen.Messaging.route) {
                MessagingScreen(viewModel = msgVm)
            }
            composable(Screen.AdminSettings.route) {
                AdminGate(repository = app.repository, onDenied = { navController.popBackStack() }) {
                    AdminSettingsScreen(
                        onBack = { navController.popBackStack() },
                        onNavigateToAccount = { navController.navigate(Screen.AccountSettings.route) },
                        onNavigateToNotificationPrefs = { navController.navigate(Screen.AdminNotificationPrefs.route) },
                    )
                }
            }
            composable(Screen.AdminNotificationPrefs.route) {
                AdminGate(repository = app.repository, onDenied = { navController.popBackStack() }) {
                    com.tribetails.auntieos.ui.admin.AdminNotificationPrefsScreen(
                        onBack = { navController.popBackStack() },
                    )
                }
            }
            composable(Screen.AccountSettings.route) {
                AdminGate(repository = app.repository, onDenied = { navController.popBackStack() }) {
                    com.tribetails.auntieos.ui.admin.AccountSettingsScreen(
                        onBack = { navController.popBackStack() },
                    )
                }
            }
            composable(Screen.AdminLogs.route) {
                AdminGate(repository = app.repository, onDenied = { navController.popBackStack() }) {
                    ActivityLogScreen(
                        onBack = { navController.popBackStack() }
                    )
                }
            }
            composable(Screen.AdminNotifications.route) {
                AdminGate(repository = app.repository, onDenied = { navController.popBackStack() }) {
                    NotificationsScreen(
                        onBack = { navController.popBackStack() },
                        // Step 4: "open linked item" routes by the notification's
                        // targetType/targetId to the matching detail screen. An
                        // unknown type or blank id is a no-op (the Open button only
                        // appears for openable targets, so this is belt-and-braces).
                        onOpenTarget = { targetType, targetId ->
                            notificationTargetRoute(targetType, targetId)?.let { route ->
                                navController.navigate(route) { launchSingleTop = true }
                            }
                        },
                        onCreateQuote = { kinfolkId ->
                            navController.navigate(Screen.AdminInvoicesQuote.createRoute(kinfolkId)) { launchSingleTop = true }
                        },
                    )
                }
            }
            composable(Screen.AdminFeatureFlags.route) {
                AdminGate(repository = app.repository, onDenied = { navController.popBackStack() }) {
                    com.tribetails.auntieos.ui.admin.FeatureFlagsScreen(
                        onBack = { navController.popBackStack() }
                    )
                }
            }
            composable(Screen.AdminSchedule.route) {
                AdminGate(repository = app.repository, onDenied = { navController.popBackStack() }) {
                    SchedulingOptionsScreen(
                        onBack = { navController.popBackStack() },
                        schedulingViewModel = schedulingVm,
                        serviceManagementViewModel = serviceManagementVm,
                        onNavigateToServiceManagement = { navController.navigate(Screen.ServiceManagement.route) }
                    )
                }
            }
            composable(Screen.EditKin.route) { backStackEntry ->
                val kinId = backStackEntry.arguments?.getString("kinId") ?: return@composable
                EditKinScreen(
                    viewModel = directoryVm,
                    kinId = kinId,
                    onBack = {
                        directoryVm.clearEditKinForm()
                        navController.popBackStack()
                    }
                )
            }

            // Admin Data Screens
            composable(Screen.AdminData.route) {
                AdminGate(repository = app.repository, onDenied = { navController.popBackStack() }) {
                    AdminDataScreen(
                        onBack = { navController.popBackStack() },
                        onNavigateToInvoices = { navController.navigate(Screen.AdminInvoices.route) },
                        onNavigateToKinTaleLogs = { navController.navigate(Screen.AdminKinTaleLogs.route) },
                        onNavigateToTrainingDocs = { navController.navigate(Screen.AdminTrainingDocs.route) },
                        onNavigateToKinCareSessions = { navController.navigate(Screen.AdminKinCareSessions.route) }
                    )
                }
            }
            composable(Screen.AdminInvoices.route) {
                AdminGate(repository = app.repository, onDenied = { navController.popBackStack() }) {
                    InvoicesScreen(
                        onBack = { navController.popBackStack() },
                        onOpenDetail = { invoiceId ->
                            navController.navigate(Screen.InvoiceDetail.createRoute(invoiceId))
                        },
                    )
                }
            }
            // N1: a notification "Create quote" lands here seeded with the kinfolk,
            // opening the quote composer preselected to that household.
            composable(Screen.AdminInvoicesQuote.route) { backStackEntry ->
                val kinfolkId = backStackEntry.arguments?.getString("kinfolkId").orEmpty()
                AdminGate(repository = app.repository, onDenied = { navController.popBackStack() }) {
                    InvoicesScreen(
                        onBack = { navController.popBackStack() },
                        onOpenDetail = { invoiceId ->
                            navController.navigate(Screen.InvoiceDetail.createRoute(invoiceId))
                        },
                        composeQuoteFor = kinfolkId,
                    )
                }
            }
            composable(
                route = Screen.InvoiceDetail.route,
                arguments = listOf(navArgument("invoiceId") { type = NavType.StringType }),
            ) { backStackEntry ->
                val invoiceId = backStackEntry.arguments?.getString("invoiceId") ?: return@composable
                AdminGate(repository = app.repository, onDenied = { navController.popBackStack() }) {
                    InvoiceDetailScreen(
                        invoiceId = invoiceId,
                        onBack    = { navController.popBackStack() },
                        viewModel = InvoiceDetailViewModel(app.repository),
                    )
                }
            }
            composable(Screen.AdminKinTaleLogs.route) {
                AdminGate(repository = app.repository, onDenied = { navController.popBackStack() }) {
                    KinTaleLogsScreen(
                        onBack = { navController.popBackStack() }
                    )
                }
            }
            composable(Screen.AdminTrainingDocs.route) {
                AdminGate(repository = app.repository, onDenied = { navController.popBackStack() }) {
                    TrainingDocumentsScreen(
                        onBack = { navController.popBackStack() }
                    )
                }
            }
            composable(Screen.ServiceManagement.route) {
                AdminGate(repository = app.repository, onDenied = { navController.popBackStack() }) {
                    ServiceManagementScreen(
                        onBack = { navController.popBackStack() },
                        viewModel = serviceManagementVm
                    )
                }
            }
            composable(Screen.AdminKinCareSessions.route) {
                AdminGate(repository = app.repository, onDenied = { navController.popBackStack() }) {
                    KinCareSessionsScreen(
                        onBack = { navController.popBackStack() },
                        onOpenDetail = { kinCareId ->
                            navController.navigate(Screen.KinCareDetail.createRoute(kinCareId))
                        },
                        onWriteKinTale = { sessionId ->
                            navController.navigate(Screen.KinTaleReport.createRoute(sessionId))
                        }
                    )
                }
            }
            composable(
                route = Screen.KinCareDetail.route,
                arguments = listOf(navArgument("kinCareId") { type = NavType.StringType })
            ) { backStackEntry ->
                val kinCareId = backStackEntry.arguments?.getString("kinCareId") ?: return@composable
                KinCareDetailScreen(
                    kinCareId = kinCareId,
                    onBack = { navController.popBackStack() },
                    onLiveTrack = { sessionId, kinfolkId, kinfolkName ->
                        navController.navigate(Screen.LiveTracking.createRoute(sessionId, kinfolkId, kinfolkName))
                    },
                    onViewRoute = { routeId, kinfolkName ->
                        navController.navigate(Screen.RouteViewer.createRoute(routeId, kinfolkName))
                    },
                )
            }
            composable(Screen.FormSchemas.route) {
                AdminGate(repository = app.repository, onDenied = { navController.popBackStack() }) {
                    com.tribetails.auntieos.ui.admin.formschemas.FormSchemaListScreen(
                        onBack = { navController.popBackStack() },
                        onOpenEditor = { schemaId ->
                            navController.navigate(Screen.FormSchemaEditor.createRoute(schemaId))
                        },
                    )
                }
            }
            composable(
                route = Screen.FormSchemaEditor.route,
                arguments = listOf(
                    navArgument("schemaId") { type = NavType.StringType; nullable = true; defaultValue = null },
                ),
            ) { backStackEntry ->
                val schemaId = backStackEntry.arguments?.getString("schemaId")
                AdminGate(repository = app.repository, onDenied = { navController.popBackStack() }) {
                    com.tribetails.auntieos.ui.admin.formschemas.FormSchemaEditorScreen(
                        schemaId = schemaId,
                        onBack = { navController.popBackStack() },
                        onDeleted = { navController.popBackStack() },
                    )
                }
            }
            composable(Screen.HouseholdData.route) { backStackEntry ->
                val kinfolkId = backStackEntry.arguments?.getString("kinfolkId") ?: return@composable
                val kinfolkName = backStackEntry.arguments?.getString("kinfolkName") ?: return@composable
                com.tribetails.auntieos.ui.directory.HouseholdDataScreen(
                    kinfolkId = kinfolkId,
                    kinfolkName = kinfolkName,
                    onBack = { navController.popBackStack() }
                )
            }
            composable(Screen.MediaGallery.route) { backStackEntry ->
                val entityId = backStackEntry.arguments?.getString("entityId") ?: return@composable
                val entityTypeStr = backStackEntry.arguments?.getString("entityType") ?: return@composable
                val entityName = backStackEntry.arguments?.getString("entityName") ?: return@composable
                val entityType = runCatching {
                    com.tribetails.auntieos.data.model.MediaEntityType.valueOf(entityTypeStr)
                }.getOrDefault(com.tribetails.auntieos.data.model.MediaEntityType.KINFOLK)
                com.tribetails.auntieos.ui.media.MediaGalleryScreen(
                    entityId = entityId,
                    entityType = entityType,
                    entityName = entityName,
                    onBack = { navController.popBackStack() }
                )
            }
            composable(
                route = Screen.KinTaleReport.route,
                arguments = listOf(
                    navArgument("sessionId") { type = NavType.StringType },
                    navArgument("reportId") { type = NavType.StringType; nullable = true; defaultValue = null }
                )
            ) { backStackEntry ->
                val sessionId = backStackEntry.arguments?.getString("sessionId") ?: return@composable
                val reportId = backStackEntry.arguments?.getString("reportId")
                com.tribetails.auntieos.ui.kintales.KinTaleReportScreen(
                    sessionId = sessionId,
                    existingReportId = reportId,
                    onBack = { navController.popBackStack() }
                )
            }
            composable(Screen.KinTaleTemplates.route) {
                com.tribetails.auntieos.ui.kintales.KinTaleTemplatesScreen(
                    onBack = { navController.popBackStack() },
                    onCreateTemplate = {
                        navController.navigate(Screen.KinTaleTemplateEditor.createRoute(null))
                    },
                    onEditTemplate = { id ->
                        navController.navigate(Screen.KinTaleTemplateEditor.createRoute(id))
                    }
                )
            }
            composable(Screen.Templates.route) {
                com.tribetails.auntieos.ui.admin.TemplatesScreen(
                    onBack = { navController.popBackStack() },
                )
            }
            composable(
                route = Screen.KinTaleTemplateEditor.route,
                arguments = listOf(
                    navArgument("templateId") { type = NavType.StringType; nullable = true; defaultValue = null }
                )
            ) { backStackEntry ->
                val tplId = backStackEntry.arguments?.getString("templateId")
                com.tribetails.auntieos.ui.kintales.KinTaleTemplateEditorScreen(
                    templateId = tplId,
                    onBack = { navController.popBackStack() },
                    onConfigureChecklist = {
                        navController.navigate(Screen.KinTaleChecklistEditor.createRoute(tplId))
                    },
                    onConfigureMoods = {
                        navController.navigate(Screen.KinTaleMoodEditor.createRoute(tplId))
                    },
                    onConfigureReviewBooster = {
                        navController.navigate(Screen.KinTaleReviewBoosterEditor.createRoute(tplId))
                    }
                )
            }
            composable(
                route = Screen.KinTaleChecklistEditor.route,
                arguments = listOf(
                    navArgument("templateId") { type = NavType.StringType; nullable = true; defaultValue = null }
                )
            ) { backStackEntry ->
                val tplId = backStackEntry.arguments?.getString("templateId")
                com.tribetails.auntieos.ui.kintales.ChecklistEditorScreen(
                    templateId = tplId,
                    onBack = { navController.popBackStack() }
                )
            }
            composable(
                route = Screen.KinTaleMoodEditor.route,
                arguments = listOf(
                    navArgument("templateId") { type = NavType.StringType; nullable = true; defaultValue = null }
                )
            ) { backStackEntry ->
                val tplId = backStackEntry.arguments?.getString("templateId")
                com.tribetails.auntieos.ui.kintales.MoodOptionsEditorScreen(
                    templateId = tplId,
                    onBack = { navController.popBackStack() }
                )
            }
            composable(
                route = Screen.KinTaleReviewBoosterEditor.route,
                arguments = listOf(
                    navArgument("templateId") { type = NavType.StringType; nullable = true; defaultValue = null }
                )
            ) { backStackEntry ->
                val tplId = backStackEntry.arguments?.getString("templateId")
                com.tribetails.auntieos.ui.kintales.ReviewBoosterEditorScreen(
                    templateId = tplId,
                    onBack = { navController.popBackStack() }
                )
            }
            composable(
                route = Screen.LiveTracking.route,
                arguments = listOf(
                    navArgument("sessionId") { type = NavType.StringType },
                    navArgument("kinfolkId") { type = NavType.StringType },
                    navArgument("kinfolkName") { type = NavType.StringType }
                )
            ) { backStackEntry ->
                val sessionId = backStackEntry.arguments?.getString("sessionId").orEmpty()
                val kinfolkId = backStackEntry.arguments?.getString("kinfolkId").orEmpty()
                val rawName = backStackEntry.arguments?.getString("kinfolkName").orEmpty()
                val kinfolkName = java.net.URLDecoder.decode(rawName, "UTF-8")
                com.tribetails.auntieos.ui.location.LiveTrackingScreen(
                    sessionId = sessionId,
                    kinfolkId = kinfolkId,
                    kinfolkName = kinfolkName,
                    homeLocation = null,
                    onBack = { navController.popBackStack() }
                )
            }
            composable(
                route = Screen.RouteViewer.route,
                arguments = listOf(
                    navArgument("routeId") { type = NavType.StringType },
                    navArgument("kinfolkName") { type = NavType.StringType }
                )
            ) { backStackEntry ->
                val routeId = backStackEntry.arguments?.getString("routeId").orEmpty()
                val rawName = backStackEntry.arguments?.getString("kinfolkName").orEmpty()
                val kinfolkName = java.net.URLDecoder.decode(rawName, "UTF-8")
                com.tribetails.auntieos.ui.location.RouteViewerScreen(
                    routeId = routeId,
                    kinfolkName = kinfolkName,
                    onBack = { navController.popBackStack() }
                )
            }
        }

        Column(modifier = Modifier.fillMaxWidth()) {
            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .height(0.5.dp)
                    .background(AuntieTheme.colors.border)
            )
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .background(AuntieTheme.colors.surface)
                    .navigationBarsPadding()
                    .padding(horizontal = 4.dp),
                horizontalArrangement = Arrangement.SpaceEvenly,
            ) {
                // 17.4: render the operator's customized order/labels (empty -> default).
                // A key with no matching screen is skipped (no dead tab) - fail-loud-safe.
                resolvedNav(navConfig, bottomNavScreens.map { it.route }).forEach { entry ->
                    val screen = bottomNavScreens.firstOrNull { it.route == entry.key } ?: return@forEach
                    val selected = currentRoute == screen.route
                    Column(
                        modifier = Modifier
                            .weight(1f)
                            .clip(RoundedCornerShape(12.dp))
                            .clickable {
                                navController.navigate(screen.route) {
                                    popUpTo(navController.graph.findStartDestination().id) { saveState = true }
                                    launchSingleTop = true
                                    restoreState = true
                                }
                            }
                            .padding(vertical = 8.dp),
                        horizontalAlignment = Alignment.CenterHorizontally,
                        verticalArrangement = Arrangement.spacedBy(3.dp),
                    ) {
                        Icon(
                            imageVector = screen.icon,
                            contentDescription = entry.label(screen.label),
                            tint = if (selected) AuntieTheme.colors.kinfolkOrange else AuntieTheme.colors.textDim,
                            modifier = Modifier.size(20.dp),
                        )
                        Text(
                            text = entry.label(screen.label),
                            style = AuntieTheme.typography.labelSmall,
                            color = if (selected) AuntieTheme.colors.kinfolkOrange else AuntieTheme.colors.textDim,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                            fontSize = 9.sp,
                        )
                    }
                }
            }
        }
    }

        // Stage 0C / Phase 2: real global-search overlay, drawn above the shell.
        if (searchOpen) {
            com.tribetails.auntieos.ui.search.GlobalSearchOverlay(
                onDismiss = { searchOpen = false },
                onNavigate = { route ->
                    navController.navigate(route) { launchSingleTop = true }
                },
            )
        }
    }
    }
}
