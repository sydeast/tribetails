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
import com.kinfolk.portal.screens.schedule.ScheduleScreen
import com.kinfolk.portal.screens.tribe.TribeHubScreen
import com.kinfolk.portal.screens.tribe.TribeScreen
import com.kinfolk.portal.share.SharedKinTaleScreen
import com.kinfolk.portal.ui.LaunchErrorScreen
import com.kinfolk.portal.ui.NoTribesOnboarding
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
    shellLogoUrl: String = "",
    shellBanner: com.kinfolk.portal.portal.PortalBanner = com.kinfolk.portal.portal.PortalBanner(),
    shellBannerDismissedByUser: Boolean = false,
    onDismissBannerPerUser: ((bannerId: String) -> Unit)? = null,
    shellHomeSections: List<com.kinfolk.portal.portal.PortalHomeSection> = emptyList(),
    shellChat: com.kinfolk.portal.portal.PortalChat = com.kinfolk.portal.portal.PortalChat(),
    cameFromPicker: Boolean,
    resolveTribes: suspend () -> List<TribeSummary>,
    onPick: (kinfolkId: String) -> Unit,
    onSignOut: () -> Unit,
    onBackToDirectory: () -> Unit,
    onRefresh: () -> Unit,
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
    val invoicesController = rememberInvoicesController(kinId, portalApi)
    val kinController = rememberKinController(kinId, portalApi)
    val messageAuntieController = com.kinfolk.portal.screens.messages.rememberMessageAuntieController(kinId, portalApi)

    @Composable
    fun Shell(content: @Composable (Modifier) -> Unit) {
        TabShell(
            familyName = shellFamilyName,
            logoUrl = shellLogoUrl,
            navController = navController,
            onSignOut = onSignOut,
            onBackToDirectory = if (cameFromPicker) onBackToDirectory else null,
            banner = shellBanner,
            bannerDismissedByUser = shellBannerDismissedByUser,
            onDismissBannerPerUser = onDismissBannerPerUser,
            content = content,
        )
    }

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
                        openExternalUrl("mailto:auntie@tribetails.com?subject=MyTribe%20account%20setup%20help")
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
        composable<LaunchErrorRoute> { entry ->
            LaunchErrorScreen(
                message = entry.toRoute<LaunchErrorRoute>().message,
                onRetry = onRefresh,
                onSignOut = onSignOut,
            )
        }

        // ---- Unauth deep-link terminals ----
        composable<SecureResetRoute>(
            deepLinks = listOf(
                navDeepLink<SecureResetRoute>(basePath = "https://tribetails.com/account/secure-reset"),
            ),
        ) { entry ->
            val r = entry.toRoute<SecureResetRoute>()
            SecureResetScreen(oobCode = r.oobCode, email = r.email)
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
                            onMessageAuntie = { navController.navigate(MessageAuntieRoute) },
                            onOpenSchedule = { navController.navigate(ScheduleRoute) { launchSingleTop = true } },
                            onOpenKinTales = { navController.navigate(KinTalesRoute) { launchSingleTop = true } },
                            onOpenKin = { navController.navigate(KinRoute) { launchSingleTop = true } },
                            onOpenKinDetail = { kinId2 -> navController.navigate(KinDetailRoute(kinId2)) },
                            onAddKin = { navController.navigate(KinAddEditRoute()) },
                            onBookVisit = { navController.navigate(BookingWizardRoute(startWeekly = false)) },
                            onOpenInvoices = { navController.navigate(InvoicesRoute) { launchSingleTop = true } },
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
                            onOpenMessageAuntie = { navController.navigate(MessageAuntieRoute) },
                            reloadSignal = reloadSignal,
                        )
                    }
                }
            }
            composable<KinTalesRoute> {
                Shell { mod -> Box(mod) { KinTalesScreen(shellFamilyName, kinId, portalApi) } }
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
                Shell { mod ->
                    Box(mod) {
                        InvoicesScreen(
                            familyName = shellFamilyName,
                            kinfolkId = kinId,
                            portalApi = portalApi,
                            onOpenInvoice = { invoiceId -> navController.navigate(InvoiceDetailRoute(invoiceId)) },
                            controller = invoicesController,
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
                            onOpenKinTales = { navController.navigate(KinTalesRoute) { launchSingleTop = true } },
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
                            onOpenKinTales = { navController.navigate(KinTalesRoute) { launchSingleTop = true } },
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
                            onComplete = {
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
