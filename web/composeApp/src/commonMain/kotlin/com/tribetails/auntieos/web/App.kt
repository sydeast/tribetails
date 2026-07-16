package com.tribetails.auntieos.web

import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.size
import com.tribetails.auntieos.web.ui.components.AuntieSpinner
import com.tribetails.auntieos.web.ui.components.PrimaryButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.tribetails.auntieos.web.config.FeatureFlags
import com.tribetails.auntieos.web.config.LocalFeatureFlags
import com.tribetails.auntieos.web.data.AuthClient
import com.tribetails.auntieos.web.data.AuthUser
import com.tribetails.auntieos.web.branding.brandIdentity
import com.tribetails.auntieos.web.data.BusinessSettings
import com.tribetails.auntieos.web.data.FirestoreResult
import com.tribetails.auntieos.web.data.NotificationEntry
import com.tribetails.auntieos.web.data.WriteResult
import com.tribetails.auntieos.web.ui.shell.unreadNotificationCount
import kotlinx.coroutines.flow.Flow
import com.tribetails.auntieos.web.screens.activity.ActivityLogScreen
import com.tribetails.auntieos.web.screens.admin.TemplatesTab
import com.tribetails.auntieos.web.screens.admin.templatesTabFromSlug
import com.tribetails.auntieos.web.screens.auth.SignInScreen
import com.tribetails.auntieos.web.screens.communicate.CommunicateScreen
import com.tribetails.auntieos.web.screens.directory.DirectoryScreen
import com.tribetails.auntieos.web.screens.home.HomeScreen
import com.tribetails.auntieos.web.screens.inbox.InboxScreen
import com.tribetails.auntieos.web.screens.notifications.NotificationsScreen
import com.tribetails.auntieos.web.screens.invoices.InvoiceDetailScreen
import com.tribetails.auntieos.web.screens.invoices.InvoicesScreen
import com.tribetails.auntieos.web.screens.kintales.KinTaleLogsScreen
import com.tribetails.auntieos.web.screens.kintales.KinTaleReportScreen
import com.tribetails.auntieos.web.screens.media.MediaGalleryScreen
import com.tribetails.auntieos.web.data.FirestoreClient
import com.tribetails.auntieos.web.data.FirestoreAuntieDataSource
import com.tribetails.auntieos.web.screens.booking.BookingScreen
import com.tribetails.auntieos.web.screens.schedule.ScheduleScreen
import com.tribetails.auntieos.web.screens.sessions.KinCareSessionsScreen
import com.tribetails.auntieos.web.screens.settings.SettingsScreen
import com.tribetails.auntieos.web.screens.trainingdocs.TrainingDocumentsScreen
import com.tribetails.auntieos.web.theme.AuntieAppTheme
import com.tribetails.auntieos.web.theme.AuntieTheme
import com.tribetails.auntieos.web.screens.settings.hydratedTheme
import com.tribetails.auntieos.web.screens.settings.hydratedPersonalization
import coil3.ImageLoader
import coil3.SingletonImageLoader
import coil3.network.ktor3.KtorNetworkFetcherFactory
import coil3.request.crossfade
import com.tribetails.auntieos.web.ui.shell.AppShell
import com.tribetails.auntieos.web.ui.shell.Destination
import com.tribetails.auntieos.web.ui.shell.Route
import com.tribetails.auntieos.web.ui.shell.parseHash
import com.tribetails.auntieos.web.ui.shell.routeWarning
import com.tribetails.auntieos.web.ui.shell.routeToHash
import com.tribetails.auntieos.web.ui.shell.currentHash
import com.tribetails.auntieos.web.ui.shell.setHash
import com.tribetails.auntieos.web.ui.shell.observeHash
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

private sealed interface AuthGateState {
    object Resolving : AuthGateState
    object SignedOut : AuthGateState
    object NonAdmin : AuthGateState
    // [testMode] is OFF for a normal admin, active for a Stage 0I test admin.
    data class SignedIn(val user: AuthUser, val testMode: com.tribetails.auntieos.web.data.TestMode) : AuthGateState
}

@Composable
fun App() {
    // One-time Coil 3 image-loader registration. Uses the Ktor 3 fetcher so
    // KinTale composer thumbnails (Cloudinary URLs) load on wasmJs without
    // pulling a separate HTTP client.
    SingletonImageLoader.setSafe { ctx ->
        ImageLoader.Builder(ctx)
            .components { add(KtorNetworkFetcherFactory()) }
            .crossfade(true)
            .build()
    }

    // FOUC fix (2026-06-09): warm-start the theme from the synchronous local cache
    // (localStorage on web / JVM prefs on desktop) so the FIRST paint already matches
    // the operator's saved theme. The Firestore profile below stays authoritative and
    // reconciles once it loads. A first-ever boot (no cache) still uses the defaults.
    val cachedTheme = remember { com.tribetails.auntieos.web.theme.decodeThemeCache(com.tribetails.auntieos.web.theme.readThemeCache()) }
    var themeMode by remember { mutableStateOf(cachedTheme?.mode ?: com.tribetails.auntieos.web.theme.ThemeMode.DARK) }
    // 17.1: accent / density / font-scale, applied app-wide + persisted to users/{uid}.
    var personalization by remember { mutableStateOf(cachedTheme?.personalization ?: com.tribetails.auntieos.web.theme.ThemePersonalization()) }
    // Persist every theme change (operator toggle OR the Firestore rehydrate below) to
    // the local cache so the next reload warm-starts with the correct theme.
    LaunchedEffect(themeMode, personalization) {
        com.tribetails.auntieos.web.theme.writeThemeCache(
            com.tribetails.auntieos.web.theme.encodeThemeCache(themeMode, personalization),
        )
    }
    val auth     = remember { AuthClient() }

    val authUser by auth.authStateStream().collectAsState(initial = null)
    var resolved by remember { mutableStateOf(false) }
    // null = not yet checked; non-null = claims read complete (admin flag + test mode).
    var claimsChecked by remember { mutableStateOf<Boolean?>(null) }
    var adminVerified by remember { mutableStateOf(false) }
    var testMode by remember { mutableStateOf(com.tribetails.auntieos.web.data.TestMode.OFF) }

    // Mark resolved as soon as Firebase reports any auth state, OR after a short
    // grace period in case onAuthStateChanged hasn't fired yet (offline, etc.).
    LaunchedEffect(authUser) { if (authUser != null) resolved = true }
    LaunchedEffect(Unit) { delay(1200L); resolved = true }
    LaunchedEffect(authUser?.uid) {
        if (authUser == null) {
            claimsChecked = null
            adminVerified = false
            testMode = com.tribetails.auntieos.web.data.TestMode.OFF
            com.tribetails.auntieos.web.data.FirestoreClient.setSessionTestMode(com.tribetails.auntieos.web.data.TestMode.OFF)
        } else {
            // Stage 0I: a single forced token read resolves BOTH the admin flag and the
            // testTribeId claim. A test admin (claim present, admin:false) is allowed in
            // and runs scoped; a normal admin (admin:true, no claim) runs unscoped.
            val admin = auth.isCurrentUserAdmin(forceRefresh = true)
            val tm = auth.currentTestMode(forceRefresh = false)
            adminVerified = admin
            testMode = tm
            // Set the session scope BEFORE the gate flips to SignedIn so the very first
            // stream a screen opens is already constrained (never an unscoped first read).
            com.tribetails.auntieos.web.data.FirestoreClient.setSessionTestMode(tm)
            claimsChecked = true
        }
    }

    val gate: AuthGateState = when {
        !resolved        -> AuthGateState.Resolving
        authUser == null -> AuthGateState.SignedOut
        claimsChecked == null -> AuthGateState.Resolving
        // Allowed in iff a real admin OR a Stage 0I test admin (scoped). Everyone
        // else (signed-in but no admin claim and no test claim) is denied.
        !com.tribetails.auntieos.web.data.allowIntoApp(adminVerified, testMode) -> AuthGateState.NonAdmin
        else             -> AuthGateState.SignedIn(authUser!!, testMode)
    }

    AuntieAppTheme(themeMode = themeMode, personalization = personalization) {
        AnimatedContent(
            targetState = gate,
            transitionSpec = { fadeIn() togetherWith fadeOut() },
            label = "authGate",
        ) { state ->
            when (state) {
                AuthGateState.Resolving   -> ResolvingSplash()
                AuthGateState.SignedOut   -> SignInScreen(auth = auth, onSignedIn = { /* authStateStream flips the gate */ })
                AuthGateState.NonAdmin    -> NonAdminScreen(auth = auth)
                is AuthGateState.SignedIn -> SignedInApp(
                    auth             = auth,
                    user             = state.user,
                    testMode         = state.testMode,
                    themeMode        = themeMode,
                    onThemeModeChange = { themeMode = it },
                    personalization  = personalization,
                    onPersonalizationChange = { personalization = it },
                )
            }
        }
    }
}

@Composable
private fun SignedInApp(
    auth: AuthClient,
    user: AuthUser,
    testMode: com.tribetails.auntieos.web.data.TestMode,
    themeMode: com.tribetails.auntieos.web.theme.ThemeMode,
    onThemeModeChange: (com.tribetails.auntieos.web.theme.ThemeMode) -> Unit,
    personalization: com.tribetails.auntieos.web.theme.ThemePersonalization,
    onPersonalizationChange: (com.tribetails.auntieos.web.theme.ThemePersonalization) -> Unit,
) {
    val initialRoute = remember { parseHash(currentHash()) }
    var current by remember { mutableStateOf(initialRoute.dest) }
    // 17.4 fail-loud: surfaced when the current hash names no screen (router -> Home).
    var routeWarn by remember { mutableStateOf(routeWarning(currentHash())) }
    var selectedInvoiceId by remember { mutableStateOf(if (initialRoute.dest == Destination.Invoices) initialRoute.detailId else null) }
    // N1: a notification "Create quote" lands on Invoices with the quote composer
    // pre-seeded for this kinfolk; consumed once the composer opens.
    var composeQuoteForKinfolkId by remember { mutableStateOf<String?>(null) }
    var reportSessionId by remember { mutableStateOf(if (initialRoute.dest == Destination.KinTales) initialRoute.detailId else null) }
    var mediaEntityId by remember { mutableStateOf(if (initialRoute.dest == Destination.MediaGallery) initialRoute.detailId else null) }
    var mediaEntityType by remember { mutableStateOf(if (initialRoute.dest == Destination.MediaGallery) initialRoute.detailType else null) }
    var mediaEntityName by remember { mutableStateOf<String?>(null) }
    // Directory deep-link target (global search / hash). detailId = kinfolkId,
    // detailType = kinId (opens the kin under that kinfolk). Null = list view.
    var directoryKinfolkId by remember { mutableStateOf(if (initialRoute.dest == Destination.Directory) initialRoute.detailId else null) }
    var directoryKinId by remember { mutableStateOf(if (initialRoute.dest == Destination.Directory) initialRoute.detailType else null) }
    // null = list view, "" = create-new editor, "<id>" = edit-existing editor
    var editingFormSchemaId by remember { mutableStateOf(if (initialRoute.dest == Destination.FormSchemas) initialRoute.detailId else null) }
    // Active tab on the merged Templates screen (Decision 2). Seeded from the route's
    // detail segment; legacy template-bank / template-assignment slugs map here too.
    var templatesTab by remember {
        mutableStateOf(
            if (initialRoute.dest == Destination.Templates) templatesTabFromSlug(initialRoute.detailId)
            else TemplatesTab.Bank,
        )
    }
    val firestoreClient = remember { FirestoreClient() }
    val signOutScope = rememberCoroutineScope()

    // Feature flags: fetch once after auth; on failure keep the compile-time
    // defaults (the shipped baseline, not fabricated data) per the fail-loud
    // exception MyTribe documents. Provided to the whole tree via LocalFeatureFlags.
    var featureFlags by remember { mutableStateOf(FeatureFlags.DEFAULT) }
    LaunchedEffect(user.uid) {
        when (val r = firestoreClient.getFeatureFlags()) {
            is WriteResult.Ok -> featureFlags = FeatureFlags.fromOverrides(r.value)
            is WriteResult.Err -> { /* keep defaults; suggested items stay dark */ }
        }
    }

    // Shell-bell unread count. Unread is the honest pending-dispatch proxy.
    val notifFlow: Flow<FirestoreResult<List<NotificationEntry>>> =
        remember(firestoreClient) { firestoreClient.notificationsStream() }
    val notifResult by notifFlow.collectAsState(initial = FirestoreResult.Loading)
    val unreadCount = (notifResult as? FirestoreResult.Data)?.value?.let { unreadNotificationCount(it) } ?: 0

    // 17.2 Branding: resolve the operator's brand identity off the live settings
    // doc (blank fields fall back to the shipped defaults inside brandIdentity).
    val brandSettingsResult by remember(firestoreClient) { firestoreClient.businessSettingsStream() }
        .collectAsState(initial = FirestoreResult.Loading)
    val brand = brandIdentity((brandSettingsResult as? FirestoreResult.Data)?.value ?: BusinessSettings())

    // 17.4 Nav editor: per-operator nav tokens off the live profile (empty -> default).
    val navProfileResult by remember(firestoreClient, user.uid) { firestoreClient.userProfileStream(user.uid) }
        .collectAsState(initial = FirestoreResult.Loading)
    val navProfile = (navProfileResult as? FirestoreResult.Data)?.value
    val navConfig = navProfile?.navConfig ?: emptyList()

    // Rehydrate the operator's saved theme + personalization ONCE, app-wide, as
    // soon as their profile first loads. This is hoisted to the app shell: it
    // used to live inside SettingsScreen, so the theme only synced when Settings
    // was opened, flipping the whole app dark->light on that one navigation
    // (prod 2026-06-08). The once-flag prevents a later in-app theme change from
    // being reverted by a stale profile stream re-emit.
    var themeRehydrated by remember(user.uid) { mutableStateOf(false) }
    LaunchedEffect(navProfile, themeRehydrated) {
        val p = navProfile
        if (p != null && !themeRehydrated) {
            val savedTheme = hydratedTheme(p, themeMode)
            if (savedTheme != themeMode) onThemeModeChange(savedTheme)
            val savedPersonalization = hydratedPersonalization(p)
            if (savedPersonalization != personalization) onPersonalizationChange(savedPersonalization)
            themeRehydrated = true
        }
    }

    // ---- Shell global search (Stage 0C / Phase 2) ----
    // Real client-side search over the live kinfolk / kin / KinTale streams. The
    // matcher is the pure [globalSearch]; this block only owns the input + debounce
    // and surfaces a stream error fail-loud rather than silently empty.
    val auntieDataSource = remember(firestoreClient) { FirestoreAuntieDataSource(firestoreClient) }
    var searchQuery by remember { mutableStateOf("") }
    var debouncedQuery by remember { mutableStateOf("") }
    LaunchedEffect(searchQuery) {
        val q = searchQuery.trim()
        if (q.isEmpty()) {
            debouncedQuery = ""
        } else {
            delay(180L) // debounce keystrokes
            debouncedQuery = q
        }
    }
    val kinfolkSearchResult by remember(firestoreClient) { firestoreClient.kinfolkStream() }
        .collectAsState(initial = FirestoreResult.Loading)
    val kinSearchResult by remember(auntieDataSource) { auntieDataSource.allKinStream() }
        .collectAsState(initial = FirestoreResult.Loading)
    val reportsSearchResult by remember(firestoreClient) { firestoreClient.reportsStream() }
        .collectAsState(initial = FirestoreResult.Loading)

    // Fail loud: if any stream errors while the user is searching, show the error
    // instead of pretending there are no matches.
    val searchError: String? = if (debouncedQuery.isBlank()) null else when {
        kinfolkSearchResult is FirestoreResult.Error -> (kinfolkSearchResult as FirestoreResult.Error).message
        kinSearchResult is FirestoreResult.Error -> (kinSearchResult as FirestoreResult.Error).message
        reportsSearchResult is FirestoreResult.Error -> (reportsSearchResult as FirestoreResult.Error).message
        else -> null
    }
    val searchResults = remember(debouncedQuery, kinfolkSearchResult, kinSearchResult, reportsSearchResult) {
        if (debouncedQuery.isBlank() || searchError != null) emptyList()
        else com.tribetails.auntieos.web.ui.shell.globalSearch(
            query = debouncedQuery,
            kinfolk = (kinfolkSearchResult as? FirestoreResult.Data)?.value.orEmpty(),
            kin = (kinSearchResult as? FirestoreResult.Data)?.value.orEmpty(),
            tales = (reportsSearchResult as? FirestoreResult.Data)?.value.orEmpty(),
        )
    }

    // state -> URL: reflect the active route in the browser hash.
    val activeRoute = Route(
        dest = current,
        detailId = when (current) {
            Destination.Invoices     -> selectedInvoiceId
            Destination.KinTales     -> reportSessionId
            Destination.FormSchemas  -> editingFormSchemaId
            Destination.MediaGallery -> mediaEntityId
            Destination.Directory    -> directoryKinfolkId
            // Reflect the active Templates tab in the hash, but keep #/templates clean
            // for the default Bank tab (only emit the detail for Assignment).
            Destination.Templates    -> if (templatesTab == TemplatesTab.Assignment) templatesTab.slug else null
            else -> null
        },
        detailType = when (current) {
            Destination.MediaGallery -> mediaEntityType
            Destination.Directory    -> directoryKinId
            else -> null
        },
    )
    LaunchedEffect(activeRoute) { setHash(routeToHash(activeRoute)) }

    // URL -> state: respond to back/forward and manual hash edits.
    LaunchedEffect(Unit) {
        observeHash { h ->
            val r = parseHash(h)
            current = r.dest
            routeWarn = routeWarning(h)
            selectedInvoiceId   = if (r.dest == Destination.Invoices) r.detailId else null
            reportSessionId     = if (r.dest == Destination.KinTales) r.detailId else null
            editingFormSchemaId = if (r.dest == Destination.FormSchemas) r.detailId else null
            mediaEntityId       = if (r.dest == Destination.MediaGallery) r.detailId else null
            mediaEntityType     = if (r.dest == Destination.MediaGallery) r.detailType else null
            directoryKinfolkId  = if (r.dest == Destination.Directory) r.detailId else null
            directoryKinId      = if (r.dest == Destination.Directory) r.detailType else null
            if (r.dest == Destination.Templates) templatesTab = templatesTabFromSlug(r.detailId)
        }
    }

    CompositionLocalProvider(
        LocalFeatureFlags provides featureFlags,
        com.tribetails.auntieos.web.data.LocalTestMode provides testMode,
    ) {
    AppShell(
        current = current,
        onNavigate = {
            routeWarn = null
            selectedInvoiceId = null
            reportSessionId = null
            mediaEntityId = null
            mediaEntityType = null
            mediaEntityName = null
            editingFormSchemaId = null
            directoryKinfolkId = null
            directoryKinId = null
            current = it
        },
        onSignOut = { signOutScope.launch { auth.signOut() } },
        accountName = user.email?.substringBefore("@")?.replaceFirstChar { it.uppercase() } ?: "Auntie",
        accountRole = if (testMode.active) "Test admin · sandbox" else "Sole operator · admin",
        onAccountClick = { current = Destination.AccountSettings },
        unreadCount = unreadCount,
        brandLogoUrl = brand.logoUrl,
        brandWordmark = brand.wordmark,
        brandTagline = brand.tagline,
        navConfig = navConfig,
        routeError = routeWarn,
        testMode = testMode,
        searchQuery = searchQuery,
        onSearchQueryChange = { searchQuery = it },
        searchResults = searchResults,
        searchError = searchError,
        onOpenSearchResult = { result ->
            val r = com.tribetails.auntieos.web.ui.shell.routeForSearchResult(result)
            // Reset all detail state, then apply the search target's route.
            selectedInvoiceId = if (r.dest == Destination.Invoices) r.detailId else null
            reportSessionId = if (r.dest == Destination.KinTales) r.detailId else null
            mediaEntityId = null
            mediaEntityType = null
            mediaEntityName = null
            editingFormSchemaId = null
            directoryKinfolkId = if (r.dest == Destination.Directory) r.detailId else null
            directoryKinId = if (r.dest == Destination.Directory) r.detailType else null
            current = r.dest
            // Clear the query so the dropdown closes after navigation.
            searchQuery = ""
        },
    ) {
        when (current) {
            Destination.Home        -> HomeScreen(authUser = user, onNavigate = { current = it })
            Destination.Communicate -> CommunicateScreen()
            Destination.Directory   -> DirectoryScreen(
                initialKinfolkId = directoryKinfolkId,
                initialKinId     = directoryKinId,
                // K1: recent-tale rows on a kinfolk profile open the tale (cross-destination).
                onOpenTale       = { sessId -> reportSessionId = sessId; current = Destination.KinTales },
            )
            Destination.KinTales    -> {
                val sessId = reportSessionId
                if (sessId != null) {
                    val dataSource = remember(firestoreClient) { FirestoreAuntieDataSource(firestoreClient) }
                    KinTaleReportScreen(
                        sessionId  = sessId,
                        dataSource = dataSource,
                        onBack     = { reportSessionId = null },
                    )
                } else {
                    KinTaleLogsScreen(onOpenReport = { reportSessionId = it })
                }
            }
            Destination.Bookings    -> BookingScreen()
            Destination.Sessions    -> KinCareSessionsScreen()
            Destination.Schedule    -> ScheduleScreen()
            Destination.Invoices    -> {
                val selId = selectedInvoiceId
                if (selId != null) {
                    InvoiceDetailScreen(
                        invoiceId = selId,
                        onBack    = { selectedInvoiceId = null },
                    )
                } else {
                    InvoicesScreen(
                        onInvoiceClick = { invoiceId -> selectedInvoiceId = invoiceId },
                        composeQuoteForKinfolkId = composeQuoteForKinfolkId,
                        onQuoteComposerConsumed = { composeQuoteForKinfolkId = null },
                    )
                }
            }
            Destination.MediaGallery -> {
                val eId   = mediaEntityId
                val eType = mediaEntityType
                val eName = mediaEntityName
                if (eId != null && eType != null) {
                    MediaGalleryScreen(
                        entityId   = eId,
                        entityType = eType,
                        entityName = eName ?: "",
                        onBack     = { current = Destination.Directory },
                    )
                } else {
                    MediaGalleryScreen(
                        entityId   = "",
                        entityType = "kinfolk",
                        entityName = "",
                        onBack     = { current = Destination.Directory },
                    )
                }
            }
            Destination.Inbox       -> InboxScreen()
            Destination.Activity     -> ActivityLogScreen()
            Destination.AccountSettings -> com.tribetails.auntieos.web.screens.account.AccountSettingsScreen(
                authUser = user,
                auth = auth,
                onOpenNotifications = { current = Destination.MyNotifications },
            )
            Destination.MyNotifications -> com.tribetails.auntieos.web.screens.account.MyNotificationsScreen(
                authUser = user,
                onBack = { current = Destination.AccountSettings },
            )
            Destination.Gallery      -> com.tribetails.auntieos.web.screens.media.GalleryScreen()
            Destination.Settings     -> SettingsScreen(
                authUser          = user,
                auth              = auth,
                themeMode         = themeMode,
                onThemeModeChange = onThemeModeChange,
                personalization   = personalization,
                onPersonalizationChange = onPersonalizationChange,
            )
            Destination.TrainingDocs -> TrainingDocumentsScreen()
            Destination.Notifications -> NotificationsScreen(
                onOpenTarget = { targetType, targetId ->
                    // Stage 2 Step 4: "open linked item" routes a notification to the
                    // booking/invoice/kintale/kinfolk it concerns. Reset all detail
                    // state first, then apply the target route.
                    selectedInvoiceId = null
                    reportSessionId = null
                    directoryKinfolkId = null
                    directoryKinId = null
                    when (targetType.trim().lowercase()) {
                        "invoice" -> { selectedInvoiceId = targetId; current = Destination.Invoices }
                        "kintale" -> { reportSessionId = targetId; current = Destination.KinTales }
                        "kinfolk" -> { directoryKinfolkId = targetId; current = Destination.Directory }
                        // Bookings is a list view with no per-id deep link; land the
                        // operator on the Bookings screen to action the request.
                        "booking" -> { current = Destination.Bookings }
                        else -> { /* unknown/blank target: no-op (no fake nav) */ }
                    }
                },
                onCreateQuote = { kinfolkId ->
                    // N1: open the quote composer on Invoices, seeded with this kinfolk.
                    selectedInvoiceId = null
                    reportSessionId = null
                    directoryKinfolkId = null
                    directoryKinId = null
                    composeQuoteForKinfolkId = kinfolkId
                    current = Destination.Invoices
                },
            )
            Destination.Templates -> com.tribetails.auntieos.web.screens.admin.TemplatesScreen(
                initialTab = templatesTab,
                onTabChange = { templatesTab = it },
            )
            Destination.FormSchemas -> {
                val editId = editingFormSchemaId
                if (editId != null) {
                    com.tribetails.auntieos.web.screens.admin.formschemas.FormSchemaEditorScreen(
                        schemaId = editId,
                        onBack   = { editingFormSchemaId = null },
                    )
                } else {
                    com.tribetails.auntieos.web.screens.admin.formschemas.FormSchemaListScreen(
                        onOpenEditor = { editingFormSchemaId = it },
                    )
                }
            }
            Destination.FeatureFlags -> com.tribetails.auntieos.web.screens.admin.FeatureFlagsScreen()
        }
    }
    }
}

@Composable
private fun ResolvingSplash() {
    val c = AuntieTheme.colors
    Box(
        modifier = Modifier.fillMaxSize().background(c.background),
        contentAlignment = Alignment.Center,
    ) {
        AuntieSpinner(
            modifier = Modifier.size(36.dp),
            color    = c.primary,
        )
    }
}

@Composable
private fun NonAdminScreen(auth: AuthClient) {
    val c = AuntieTheme.colors
    val scope = rememberCoroutineScope()
    Box(
        modifier = Modifier.fillMaxSize().background(c.background),
        contentAlignment = Alignment.Center,
    ) {
        androidx.compose.foundation.layout.Column(
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            androidx.compose.material3.Text(
                text = "Admin access required.",
                color = c.textPrimary,
                style = AuntieTheme.typography.titleLarge,
            )
            androidx.compose.foundation.layout.Spacer(modifier = Modifier.height(12.dp))
            PrimaryButton(
                label   = "Sign out",
                onClick = { scope.launch { auth.signOut() } },
            )
        }
    }
}
