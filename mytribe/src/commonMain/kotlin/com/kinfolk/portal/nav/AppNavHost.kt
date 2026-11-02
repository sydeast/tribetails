package com.kinfolk.portal.nav

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.navigation.NavGraph.Companion.findStartDestination
import androidx.navigation.NavHostController
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.navigation
import androidx.navigation.NavDestination.Companion.hasRoute
import androidx.navigation.compose.rememberNavController
import androidx.navigation.navDeepLink
import androidx.navigation.toRoute
import com.kinfolk.portal.auth.AuthRepository
import com.kinfolk.portal.auth.SecureResetScreen
import com.kinfolk.portal.auth.SignInScreen
import com.kinfolk.portal.firebase.FirestoreClient
import com.kinfolk.portal.firebase.FunctionsClient
import com.kinfolk.portal.launch.LaunchSignOutButton
import com.kinfolk.portal.launch.TribePickerScreen
import com.kinfolk.portal.notifications.NotificationCatalogRepository
import com.kinfolk.portal.portal.PortalApi
import com.kinfolk.portal.portal.TribeSummary
import com.kinfolk.portal.screens.account.AccountSettingsScreen
import com.kinfolk.portal.screens.claim.ClaimInviteScreen
import com.kinfolk.portal.screens.gallery.GalleryScreen
import com.kinfolk.portal.screens.home.HomeScreen
import com.kinfolk.portal.screens.invoices.InvoiceDetailScreen
import com.kinfolk.portal.screens.invoices.InvoicesScreen
import com.kinfolk.portal.screens.invoices.payMethodsFor
import com.kinfolk.portal.screens.invoices.rememberInvoicesController
import com.kinfolk.portal.screens.kin.KinAddEditScreen
import com.kinfolk.portal.screens.kin.KinDetailHost
import com.kinfolk.portal.screens.kin.KinScreen
import com.kinfolk.portal.screens.kin.rememberKinController
import com.kinfolk.portal.screens.kintales.KinTalesScreen
import com.kinfolk.portal.screens.notifications.NotificationSettingsScreen
import com.kinfolk.portal.screens.schedule.BookingEnvelopeScreen
import com.kinfolk.portal.screens.schedule.BookingWizardScreen
import com.kinfolk.portal.screens.schedule.KinCareDetailScreen
import com.kinfolk.portal.screens.schedule.ScheduleHandoff
import com.kinfolk.portal.screens.schedule.ScheduleScreen
import com.kinfolk.portal.screens.tribe.TribeHubScreen
import com.kinfolk.portal.screens.tribe.TribeScreen
import com.kinfolk.portal.share.SharedKinTaleScreen
import com.kinfolk.portal.ui.LaunchErrorScreen
import com.kinfolk.portal.ui.NoTribesOnboarding
import com.kinfolk.portal.ui.NotFoundScreen
import com.kinfolk.portal.util.openExternalUrl

/** Dirty-flag key the detail destinations set so Schedule reloads on return. */
private const val SCHEDULE_DIRTY = "schedule_dirty"

/**
 * Single top-level NavHost for the whole app. The launch funnel above
 * (resolved into [startRoute] via [startRouteFor]) decides the start
 * destination; this host owns the pre-shell screens, the unauth deep-link
 * terminals, and the signed-in ShellGraph (primary nav dests + avatar-menu
 * dests + details) wrapped in the responsive TabShell chrome.
 *
 * The funnel is reactive, but a NavHost reads startDestination only once, so
 * the caller passes the latest [startRoute] and this host re-navigates whenever
 * it changes (sign-out, picker pick, claim accepted) clearing the back stack.
 *
 * The signed-in [shellFamilyName] and shell controllers come from the caller,
 * which already resolves getMyHome for the active kinfolk.
 */
@Composable
fun AppNavHost(
    startRoute: Any,
    repo: AuthRepository,
    functions: FunctionsClient,
    portalApi: PortalApi,
    firestoreClient: FirestoreClient,
    notificationCatalog: NotificationCatalogRepository?,
    shellKinfolkId: String?,
    shellFamilyName: String,
    /** #1290: the signed-in person, for the header avatar. Blank falls back to [shellFamilyName]. */
    shellPersonName: String = "",
    onPersonNameChanged: (String) -> Unit = {},
    shellLogoUrl: String = "",
    /** #1369: `getMyHome.businessName`, for the footer. Blank draws no name. */
    shellBusinessName: String = "",
    shellBanner: com.kinfolk.portal.portal.PortalBanner = com.kinfolk.portal.portal.PortalBanner(),
    shellBannerDismissedByUser: Boolean = false,
    onDismissBannerPerUser: ((bannerId: String) -> Unit)? = null,
    shellHomeSections: List<com.kinfolk.portal.portal.PortalHomeSection> = emptyList(),
    shellChat: com.kinfolk.portal.portal.PortalChat = com.kinfolk.portal.portal.PortalChat(),
    /**
     * #1005: `getMyHome.billingAccess`. False hides the Invoices link, Home's
     * "View invoices" and Account's Billing Details, and sends the invoice
     * routes back to Home, with no error shown.
     */
    shellBillingAccess: Boolean = true,
    cameFromPicker: Boolean,
    resolveTribes: suspend () -> List<TribeSummary>,
    onPick: (kinfolkId: String) -> Unit,
    onSignOut: () -> Unit,
    onBackToDirectory: () -> Unit,
    onRefresh: () -> Unit,
    /** #1293: "Back to Home" on the not-found screen; the caller clears the unknown launch link. */
    onNotFoundHome: () -> Unit = {},
    /**
     * The "message Auntie" mailto on the no-tribes funnel. Nothing renders
     * `AppNavHost` from a test today (`NoTribesOnboardingTest` drives the
     * component directly and it already takes `onMessageAuntie`), so this call
     * site leaks nothing right now. It is seamed anyway so that
     * `UrlOpenerSeamGuardTest` needs no allowlist: one rule, no exception list
     * to keep up to date.
     */
    openUrl: (String) -> Unit = { openExternalUrl(it) },
    navController: NavHostController = rememberNavController(),
) {
    // The funnel is reactive but the NavHost start destination is read once.
    // Re-navigate (clearing the back stack) whenever the resolved start route
    // changes, so sign-out / picker-pick / claim-accepted flip the whole screen
    // exactly as the old gate did.
    var lastStartKey by remember { mutableStateOf(routeKey(startRoute)) }
    LaunchedEffect(startRoute) {
        val key = routeKey(startRoute)
        if (key != lastStartKey) {
            lastStartKey = key
            navController.navigate(startRoute) {
                popUpTo(0) { inclusive = true }
                launchSingleTop = true
            }
        }
    }

    bindPlatformHistory(navController)

    // Shell-scoped controllers + chrome wrapper. Keyed on the active kinfolk so
    // switching tribes (rare) rebuilds them. Safe to build with a placeholder
    // id when not signed in; the shell graph is only entered with a real id.
    val kinId = shellKinfolkId ?: ""
    // #1039: the signed-in viewer's own uid, read off the same repo the
    // shell already holds, so the invoice screens can tell "you accepted
    // this quote" from "Sam accepted this quote" instead of assuming the
    // reader is always the one who answered.
    val authState by repo.state.collectAsState()
    val viewerUid = (authState as? com.kinfolk.portal.auth.AuthState.SignedIn)?.uid
    val invoicesController = rememberInvoicesController(kinId, portalApi)
    val kinController = rememberKinController(kinId, portalApi)
    val messageAuntieController = com.kinfolk.portal.screens.messages.rememberMessageAuntieController(kinId, portalApi)

    @Composable
    fun Shell(content: @Composable (Modifier) -> Unit) {
        TabShell(
            familyName = shellPersonName.ifBlank { shellFamilyName },
            logoUrl = shellLogoUrl,
            businessName = shellBusinessName,
            navController = navController,
            onSignOut = onSignOut,
            onBackToDirectory = if (cameFromPicker) onBackToDirectory else null,
            banner = shellBanner,
            bannerDismissedByUser = shellBannerDismissedByUser,
            onDismissBannerPerUser = onDismissBannerPerUser,
            billingAccess = shellBillingAccess,
            content = content,
        )
    }

    /** #1005: an invoice route reached without billing access goes back to Home. */
    @Composable
    fun LeaveBilling() {
        LaunchedEffect(Unit) {
            navController.navigate(HomeRoute) {
                popUpTo(navController.graph.findStartDestination().id)
                launchSingleTop = true
            }
        }
    }

    // #1413: Messages is a narrow tab, so every entry point reaches it the way
    // a tab tap does: pop to the HomeRoute LEAF (findStartDestination, never
    // the ShellGraph node) saving the tab stack it leaves, and restore any
    // saved Messages stack. A plain navigate from the Schedule CTA would stack
    // MessageAuntieRoute on top of Schedule; because Messages is now a chrome
    // destination, the next tab tap would save that stack and a later Schedule
    // tap would restore it with Messages still on top, the old "Account
    // Settings locks the page" shape. Back from Messages lands on Home.
    //
    // saveState is hardcoded true because both callers (the Home quick-start
    // and the Schedule CTA) sit on chrome screens. A caller on a detail or
    // wizard leaf must not use this: saving from a leaf is the corrupt stack
    // TabShell.navigateTab guards against with isShellChromeDestination.
    fun openMessages() {
        navController.navigate(MessageAuntieRoute) {
            popUpTo(navController.graph.findStartDestination().id) { saveState = true }
            launchSingleTop = true
            restoreState = true
        }
    }

    // #1281: lives above the NavHost, so it outlasts the wizard's destination
    // and reaches Schedule's. See ScheduleHandoff.
    var scheduleHandoff by remember { mutableStateOf<ScheduleHandoff?>(null) }
    NavHost(navController = navController, startDestination = startRoute) {
        // ---- Pre-shell funnel ----
        composable<SignInRoute> {
            // Sign-in success flips the reactive gate, which re-navigates here.
            SignInScreen(repo = repo, onSignedIn = {})
        }
        composable<NoTribesRoute> {
            // No shell chrome here, so overlay the pre-shell sign-out
            // affordance — without it a claimed-but-unlinked account is stuck.
            Box(modifier = Modifier.fillMaxSize()) {
                NoTribesOnboarding(
                    onMessageAuntie = {
                        openUrl("mailto:auntie@tribetails.com?subject=MyTribe%20account%20setup%20help")
                    },
                )
                LaunchSignOutButton(
                    onSignOut = onSignOut,
                    modifier = Modifier.align(Alignment.TopEnd).padding(16.dp),
                )
            }
        }
        composable<TribePickerRoute> {
            var tribes by remember { mutableStateOf<List<TribeSummary>?>(null) }
            LaunchedEffect(Unit) { tribes = resolveTribes() }
            TribePickerScreen(tribes = tribes, onPick = onPick, onSignOut = onSignOut)
        }
        composable<NotFoundRoute> { NotFoundScreen(onHome = onNotFoundHome) }
        composable<LaunchErrorRoute> { entry ->
            LaunchErrorScreen(
                message = entry.toRoute<LaunchErrorRoute>().message,
                onRetry = onRefresh,
                onSignOut = onSignOut,
            )
        }

        // ---- Unauth deep-link terminals ----
        // #905: the project's one Firebase email action URL, on the host every
        // real link uses. The web page answers at both paths, the manifest claims
        // both, so both are declared here too.
        composable<SecureResetRoute>(
            deepLinks = listOf(
                navDeepLink<SecureResetRoute>(
                    basePath = "https://kinfolk.tribetails.com/account/secure-reset",
                ),
                navDeepLink<SecureResetRoute>(
                    basePath = "https://kinfolk.tribetails.com/account/action",
                ),
            ),
        ) { entry ->
            val r = entry.toRoute<SecureResetRoute>()
            SecureResetScreen(
                oobCode = r.oobCode,
                repo = repo,
                onSignIn = {
                    navController.navigate(SignInRoute) {
                        popUpTo(0) { inclusive = true }
                        launchSingleTop = true
                    }
                },
                mode = r.mode,
                continueUrl = r.continueUrl,
            )
        }
        composable<ShareRoute>(
            deepLinks = listOf(
                navDeepLink<ShareRoute>(basePath = "https://kinfolk.tribetails.com/share"),
                navDeepLink<ShareRoute>(basePath = "mytribe://share"),
            ),
        ) { entry ->
            SharedKinTaleScreen(shareId = entry.toRoute<ShareRoute>().shareId)
        }
        composable<ClaimRoute>(
            deepLinks = listOf(
                navDeepLink<ClaimRoute>(basePath = "https://kinfolk.tribetails.com/claim"),
                navDeepLink<ClaimRoute>(basePath = "mytribe://claim"),
            ),
        ) { entry ->
            ClaimInviteScreen(
                inviteId = entry.toRoute<ClaimRoute>().inviteId,
                functions = functions,
                repo = repo,
                onClaimed = { onRefresh() }, // gate resolves to ShellGraph
                onCancel = { onSignOut() },
            )
        }

        // ---- Signed-in shell ----
        navigation<ShellGraph>(startDestination = HomeRoute) {
            composable<HomeRoute> {
                Shell { mod ->
                    Box(mod) {
                        HomeScreen(
                            familyName = shellFamilyName,
                            kinfolkId = kinId,
                            portalApi = portalApi,
                            sections = shellHomeSections,
                            chatEnabled = shellChat.enabled,
                            onMessageAuntie = { openMessages() },
                            onOpenSchedule = { navController.navigate(ScheduleRoute) { launchSingleTop = true } },
                            onOpenKinTales = { navController.navigate(KinTalesRoute()) { launchSingleTop = true } },
                            onOpenKinTale = { taleId -> navController.navigate(KinTalesRoute(taleId)) { launchSingleTop = true } },
                            onBookVisit = { navController.navigate(BookingWizardRoute(startWeekly = false)) },
                            handoff = scheduleHandoff,
                            onHandoffTaken = { scheduleHandoff = null },
                            onOpenInvoices = if (shellBillingAccess) {
                                { navController.navigate(InvoicesRoute) { launchSingleTop = true } }
                            } else {
                                null
                            },
                        )
                    }
                }
            }
            composable<ScheduleRoute> { entry ->
                Shell { mod ->
                    val reloadSignal by entry.savedStateHandle
                        .getStateFlow(SCHEDULE_DIRTY, 0)
                        .collectAsState()
                    Box(mod) {
                        ScheduleScreen(
                            familyName = shellFamilyName,
                            kinfolkId = kinId,
                            portalApi = portalApi,
                            firestoreClient = firestoreClient,
                            onOpenKinCare = { visitId, batchId -> navController.navigate(KinCareDetailRoute(batchId, visitId)) },
                            onOpenEnvelope = { batchId -> navController.navigate(BookingEnvelopeRoute(batchId)) },
                            onOpenWizard = { navController.navigate(BookingWizardRoute(startWeekly = false)) },
                            onOpenRecurring = { navController.navigate(BookingWizardRoute(startWeekly = true)) },
                            onOpenMessageAuntie = { openMessages() },
                            reloadSignal = reloadSignal,
                            handoff = scheduleHandoff,
                            onHandoffTaken = { scheduleHandoff = null },
                        )
                    }
                }
            }
            composable<KinTalesRoute> { entry ->
                val taleId = entry.toRoute<KinTalesRoute>().taleId
                Shell { mod -> Box(mod) { KinTalesScreen(shellFamilyName, kinId, portalApi, focusTaleId = taleId) } }
            }
            composable<KinRoute> {
                Shell { mod ->
                    Box(mod) {
                        KinScreen(
                            familyName = shellFamilyName,
                            kinfolkId = kinId,
                            portalApi = portalApi,
                            onOpenKin = { kinId2 -> navController.navigate(KinDetailRoute(kinId2)) },
                            controller = kinController,
                        )
                    }
                }
            }
            composable<InvoicesRoute> {
                if (!shellBillingAccess) {
                    LeaveBilling()
                    return@composable
                }
                Shell { mod ->
                    Box(mod) {
                        InvoicesScreen(
                            familyName = shellFamilyName,
                            kinfolkId = kinId,
                            portalApi = portalApi,
                            onOpenInvoice = { invoiceId -> navController.navigate(InvoiceDetailRoute(invoiceId)) },
                            controller = invoicesController,
                            viewerUid = viewerUid,
                        )
                    }
                }
            }

            // Drawer destinations
            composable<TribeRoute> {
                Shell { mod ->
                    Box(mod) {
                        TribeHubScreen(
                            familyName = shellFamilyName,
                            kinfolkId = kinId,
                            portalApi = portalApi,
                            onEditProfile = { navController.navigate(TribeEditRoute) },
                            onOpenKinDetail = { kinId2 -> navController.navigate(KinDetailRoute(kinId2)) },
                            onManageKin = { navController.navigate(KinRoute) { launchSingleTop = true } },
                            onOpenKinTales = { navController.navigate(KinTalesRoute()) { launchSingleTop = true } },
                            onOpenGallery = { navController.navigate(GalleryRoute) },
                        )
                    }
                }
            }
            composable<GalleryRoute> {
                Shell { mod ->
                    Box(mod) {
                        GalleryScreen(
                            kinfolkId = kinId,
                            portalApi = portalApi,
                            onBack = { navController.popBackStack() },
                            onOpenKinDetail = { kinId2 -> navController.navigate(KinDetailRoute(kinId2)) },
                            onOpenKinTales = { navController.navigate(KinTalesRoute()) { launchSingleTop = true } },
                        )
                    }
                }
            }
            composable<TribeEditRoute> {
                Shell { mod -> Box(mod) { TribeScreen(shellFamilyName, kinId, portalApi) } }
            }
            composable<AccountRoute> {
                Shell { mod ->
                    Box(mod) {
                        AccountSettingsScreen(
                            shellFamilyName,
                            portalApi,
                            kinfolkId = kinId,
                            onSignOut = onSignOut,
                            billingAccess = shellBillingAccess,
                            onAccountSaved = { onPersonNameChanged(resolveShellPersonName(it.displayName, it.email, shellFamilyName)) },
                            onOpenTribeProfile = {
                                // Account is a chrome-level destination, so
                                // save/restore is safe here; pop to the
                                // HomeRoute LEAF (findStartDestination), never
                                // the nested ShellGraph node id.
                                navController.navigate(TribeRoute) {
                                    popUpTo(navController.graph.findStartDestination().id) { saveState = true }
                                    launchSingleTop = true
                                    restoreState = true
                                }
                            },
                            repo = repo,
                        )
                    }
                }
            }
            composable<NotificationsRoute> {
                Shell { mod -> Box(mod) { NotificationSettingsScreen(shellFamilyName, portalApi, notificationCatalog) } }
            }

            // Message Auntie (16.4): two-way conversation, reached via the Schedule
            // CTA or the ScreenHeader chip. Renders inside the shell chrome.
            composable<MessageAuntieRoute> {
                Shell { mod ->
                    Box(mod) {
                        com.kinfolk.portal.screens.messages.MessageAuntieScreen(
                            familyName = shellFamilyName,
                            kinfolkId = kinId,
                            portalApi = portalApi,
                            chat = shellChat,
                            onBack = { navController.popBackStack() },
                            controller = messageAuntieController,
                        )
                    }
                }
            }

            // Detail destinations: stay inside the bottom-bar Scaffold (chrome
            // visible), matching current UX where details render in the body.
            composable<KinDetailRoute> { entry ->
                Shell { mod ->
                    Box(mod) {
                        KinDetailHost(
                            familyName = shellFamilyName,
                            kinId = entry.toRoute<KinDetailRoute>().kinId,
                            controller = kinController,
                            onBack = { navController.popBackStack() },
                            onEdit = { id -> navController.navigate(KinAddEditRoute(id)) },
                        )
                    }
                }
            }
            composable<KinAddEditRoute> { entry ->
                Shell { mod ->
                    Box(mod) {
                        KinAddEditScreen(
                            kinId = entry.toRoute<KinAddEditRoute>().kinId,
                            controller = kinController,
                            onClose = { navController.popBackStack() },
                        )
                    }
                }
            }
            composable<InvoiceDetailRoute> { entry ->
                if (!shellBillingAccess) {
                    LeaveBilling()
                    return@composable
                }
                Shell { mod ->
                    Box(mod) {
                        val invoiceId = entry.toRoute<InvoiceDetailRoute>().invoiceId
                        LaunchedEffect(invoiceId) { if (invoicesController.data == null) invoicesController.reload() }
                        val invoice = invoicesController.find(invoiceId)
                        if (invoice != null) {
                            InvoiceDetailScreen(
                                familyName = shellFamilyName,
                                invoice = invoice,
                                paying = invoicesController.paying == invoice.id,
                                redeeming = invoicesController.redeeming == invoice.id,
                                downloadingPdf = invoicesController.downloadingPdf == invoice.id,
                                // ISSUE #409: the bill's own options when it has
                                // them, the business-wide list otherwise.
                                payMethods = payMethodsFor(invoice, invoicesController.payMethods),
                                decidingQuote = invoicesController.decidingQuote == invoice.id,
                                quoteError = invoicesController.quoteErrorFor(invoice.id),
                                viewerUid = viewerUid,
                                onPayMethod = { method -> invoicesController.startPayMethod(invoice, method) },
                                onQuoteDecision = { accept -> invoicesController.startQuoteDecision(invoice, accept) },
                                onRedeem = { tgt -> invoicesController.startRedeem(invoice, tgt) },
                                onDownloadPdf = { invoicesController.startDownloadPdf(invoice) },
                                onBack = { navController.popBackStack() },
                            )
                        } else {
                            Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                                CircularProgressIndicator()
                            }
                        }
                    }
                }
            }
            composable<KinCareDetailRoute> { entry ->
                Shell { mod ->
                    Box(mod) {
                        val r = entry.toRoute<KinCareDetailRoute>()
                        KinCareDetailScreen(
                            kinCareId = r.visitId,
                            kinfolkId = kinId,
                            portalApi = portalApi,
                            onBack = {
                                markScheduleDirty(navController)
                                navController.popBackStack()
                            },
                            // #1363: open the KinTales tab on this visit's tale.
                            onOpenKinTale = { taleId -> navController.navigate(KinTalesRoute(taleId)) { launchSingleTop = true } },
                            onOpenInvoice = { invoiceId -> navController.navigate(InvoiceDetailRoute(invoiceId)) },
                        )
                    }
                }
            }
            composable<BookingEnvelopeRoute> { entry ->
                Shell { mod ->
                    Box(mod) {
                        BookingEnvelopeScreen(
                            batchId = entry.toRoute<BookingEnvelopeRoute>().batchId,
                            kinfolkId = kinId,
                            portalApi = portalApi,
                            onBack = { navController.popBackStack() },
                            onOpenKinCare = { visitId, batchId -> navController.navigate(KinCareDetailRoute(batchId, visitId)) },
                        )
                    }
                }
            }
            composable<BookingWizardRoute> { entry ->
                Shell { mod ->
                    Box(mod) {
                        BookingWizardScreen(
                            kinfolkId = kinId,
                            portalApi = portalApi,
                            onClose = { navController.popBackStack() },
                            onComplete = { fresh ->
                                // #1345: Home and Schedule are the only entry
                                // points, and each takes the handoff. Guarded
                                // so a handoff never waits for a screen that
                                // does not read it and surfaces out of context.
                                val back = navController.previousBackStackEntry?.destination
                                if (back?.hasRoute(ScheduleRoute::class) == true || back?.hasRoute(HomeRoute::class) == true) {
                                    scheduleHandoff = ScheduleHandoff(bookings = fresh, notice = "Booking requested")
                                }
                                markScheduleDirty(navController)
                                navController.popBackStack()
                            },
                            startWeekly = entry.toRoute<BookingWizardRoute>().startWeekly,
                        )
                    }
                }
            }
        }
    }
}

/**
 * Bumps the Schedule entry's dirty flag so it reloads when a mutating detail
 * returns. The Schedule entry is the one we pop back to (previousBackStackEntry
 * resolves to it when the Schedule tab opened the detail; if the detail was
 * reached via an envelope, the flag is harmlessly set on whatever entry we
 * return to and Schedule still re-reads next time it is shown).
 */
private fun markScheduleDirty(navController: NavHostController) {
    val target = navController.previousBackStackEntry ?: return
    val current = target.savedStateHandle.get<Int>(SCHEDULE_DIRTY) ?: 0
    target.savedStateHandle[SCHEDULE_DIRTY] = current + 1
}
