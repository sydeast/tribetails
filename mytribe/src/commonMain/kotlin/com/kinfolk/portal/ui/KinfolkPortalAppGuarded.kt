package com.kinfolk.portal.ui

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.runtime.collectAsState
import com.kinfolk.portal.auth.AuthRepository
import com.kinfolk.portal.auth.AuthState
import com.kinfolk.portal.auth.tearDownSession
import com.kinfolk.portal.firebase.FunctionsClient
import com.kinfolk.portal.push.PushRegistrationCoordinator
import com.kinfolk.portal.firebase.platformAuthBackend
import com.kinfolk.portal.firebase.platformFunctionsClient
import com.kinfolk.portal.launch.LaunchDestination
import com.kinfolk.portal.util.readInitialClaimInviteId
import com.kinfolk.portal.util.readInitialSecureResetParams
import com.kinfolk.portal.util.readInitialShareToken
import com.kinfolk.portal.launch.rememberLaunchDestination
import com.kinfolk.portal.nav.AppNavHost
import com.kinfolk.portal.nav.startRouteFor
import com.kinfolk.portal.portal.MyHomeResult
import com.kinfolk.portal.portal.PortalApi
import com.kinfolk.portal.theme.KinfolkPortalTheme
import kotlinx.coroutines.launch
import coil3.ImageLoader
import coil3.compose.setSingletonImageLoaderFactory
import coil3.request.crossfade
import com.kinfolk.portal.media.installCoilNetwork

@Composable
fun KinfolkPortalAppGuarded() {
    setSingletonImageLoaderFactory { ctx ->
        installCoilNetwork(ImageLoader.Builder(ctx).crossfade(true)).build()
    }
    val functions: FunctionsClient = remember { platformFunctionsClient() }
    val firestoreClient = remember { com.kinfolk.portal.firebase.platformFirestoreClient() }
    val portalApi = remember(functions) { PortalApi(functions) }
    val notificationCatalog = remember(functions) {
        com.kinfolk.portal.notifications.NotificationCatalogRepository(functions)
    }
    val repo = remember { AuthRepository(platformAuthBackend()) }
    val scope = rememberCoroutineScope()
    // #502: observe(), not refresh(). refresh() answered once and then the
    // portal stopped listening, so a session revoked mid-visit stayed invisible
    // until something else happened to ask again. The first emission is the
    // same answer refresh() resolved, and this LaunchedEffect keeps collecting
    // for as long as the app is composed, which is what owns and cancels it.
    LaunchedEffect(Unit) { repo.observe() }
    // Push registration: fires only once auth resolves to SignedIn, so the
    // web Notification permission prompt can never appear on first paint.
    val pushCoordinator = remember(portalApi) { PushRegistrationCoordinator(portalApi) }
    val authState by repo.state.collectAsState()
    LaunchedEffect(authState) {
        if (authState is AuthState.SignedIn) pushCoordinator.onSignedIn()
    }
    val dest by rememberLaunchDestination(repo, portalApi)
    var pickedKinfolkId by remember { mutableStateOf<String?>(null) }
    var pickedFromDirectory by remember { mutableStateOf(false) }
    var home by remember { mutableStateOf<MyHomeResult?>(null) }
    var homeError by remember { mutableStateOf<String?>(null) }
    var claimInviteId by remember { mutableStateOf<String?>(readInitialClaimInviteId()) }
    val initialShareToken = remember { readInitialShareToken() }
    val initialSecureResetParams = remember { readInitialSecureResetParams() }
    var featureFlags by remember { mutableStateOf(com.kinfolk.portal.config.FeatureFlags()) }

    val resolvedKinfolkId = pickedKinfolkId ?: (dest as? LaunchDestination.Home)?.kinfolkId
    val cameFromPicker = pickedFromDirectory || dest is LaunchDestination.Pick

    LaunchedEffect(resolvedKinfolkId) {
        if (resolvedKinfolkId == null) {
            home = null
            homeError = null
            return@LaunchedEffect
        }
        try {
            home = portalApi.getMyHome(resolvedKinfolkId)
            homeError = null
        } catch (t: Throwable) {
            home = MyHomeResult(kinfolkId = resolvedKinfolkId, displayName = "The $resolvedKinfolkId Tribe")
            homeError = t.message
        }
    }

    // Resolve feature flags once the kinfolk is signed in (the callable needs
    // auth). On any failure we keep the compile-time defaults: that is the
    // authoritative shipped baseline, not fake data, so silence here is correct
    // rather than a fail-loud banner.
    LaunchedEffect(resolvedKinfolkId) {
        if (resolvedKinfolkId != null) {
            try {
                featureFlags = portalApi.getFeatureFlags()
            } catch (_: Throwable) {
                // keep current featureFlags (defaults)
            }
        }
    }

    // Resolve the NavHost start destination from the launch funnel. While null
    // (auth / access / home in flight) we show the spinner and do not mount the
    // NavHost yet, exactly like the old loading gates. A resolved kinfolk only
    // opens the shell once getMyHome has landed so the chrome has a family name.
    val homeReady = resolvedKinfolkId == null || home != null
    val startRoute = if (homeReady) {
        startRouteFor(
            secureReset = initialSecureResetParams,
            shareToken = initialShareToken,
            claimId = claimInviteId,
            dest = dest,
            resolvedKinfolkId = resolvedKinfolkId,
            cameFromPicker = cameFromPicker,
        )
    } else {
        null
    }

    KinfolkPortalTheme(themeId = home?.portal?.themeId ?: "default") {
        androidx.compose.runtime.CompositionLocalProvider(
            com.kinfolk.portal.config.LocalFeatureFlags provides featureFlags,
        ) {
            Box(modifier = Modifier.fillMaxSize()) {
                com.kinfolk.portal.components.KinfolkBackground()
                Surface(modifier = Modifier.fillMaxSize(), color = androidx.compose.ui.graphics.Color.Transparent) {
                    if (startRoute == null) {
                        Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                            CircularProgressIndicator()
                        }
                    } else {
                        AppNavHost(
                            startRoute = startRoute,
                            repo = repo,
                            functions = functions,
                            portalApi = portalApi,
                            firestoreClient = firestoreClient,
                            notificationCatalog = notificationCatalog,
                            shellKinfolkId = resolvedKinfolkId,
                            shellFamilyName = home?.displayName ?: "",
                            shellLogoUrl = home?.businessLogoUrl ?: "",
                            shellBanner = home?.portal?.banner ?: com.kinfolk.portal.portal.PortalBanner(),
                            shellBannerDismissedByUser = home?.bannerDismissedByUser ?: false,
                            shellHomeSections = home?.portal?.home ?: emptyList(),
                            shellChat = home?.portal?.chat ?: com.kinfolk.portal.portal.PortalChat(),
                            onDismissBannerPerUser = { bannerId ->
                                // Best-effort sync; never blocks the local hide.
                                scope.launch {
                                    try {
                                        portalApi.dismissBanner(bannerId)
                                    } catch (t: Throwable) {
                                        println("[Banner] perUser dismiss failed (ignored): ${'$'}{t.message}")
                                    }
                                }
                            },
                            cameFromPicker = cameFromPicker,
                            resolveTribes = {
                                val ids = (dest as? LaunchDestination.Pick)?.kinfolkIds ?: emptyList()
                                portalApi.getTribeSummaries(ids)
                            },
                            onPick = { picked ->
                                pickedKinfolkId = picked
                                pickedFromDirectory = true
                                // O-5: re-mint the kinfolkId claim + force a
                                // token refresh so direct-Firestore-rules-gated
                                // reads (live GPS breadcrumbs) honor the pick,
                                // not just callable reads (which already get
                                // `picked` explicitly via kinId= params).
                                // Fire-and-forget: never blocks navigation, and
                                // a failure here doesn't strand the kinfolk —
                                // callable reads are correct either way.
                                scope.launch {
                                    try {
                                        portalApi.setActiveTribe(picked)
                                        repo.refreshIdToken()
                                    } catch (t: Throwable) {
                                        println("[TribePicker] setActiveTribe claim re-mint failed (ignored): ${t.message}")
                                    }
                                }
                            },
                            onSignOut = {
                                // #539. The two calls below need the ID token that is
                                // about to be thrown away, so they go first — but they
                                // go first on a clock. Before this, a stalled
                                // unregisterFcmToken meant repo.signOut() never ran at
                                // all: the kinfolk sat on the spinner these state
                                // resets produce, still signed in, and closing and
                                // reopening the app put them straight back into their
                                // household. tearDownSession is what guarantees the
                                // sign-out happens either way.
                                scope.launch {
                                    tearDownSession(
                                        cleanUp = {
                                            pushCoordinator.onSignOut()
                                            // Local sign-out only drops this device's
                                            // refresh token; the token stays valid
                                            // server-side until revoked. See
                                            // PortalApi.signOutAllDevices.
                                            portalApi.signOutAllDevices()
                                        },
                                        signOut = { repo.signOut() },
                                        // The sign-out itself refusing is the one case
                                        // where the kinfolk really is still signed in.
                                        // Re-resolve rather than strand them on the
                                        // spinner the resets below just produced.
                                        onFailure = { scope.launch { repo.refresh() } },
                                    )
                                }
                                // Synchronous, and deliberately not inside the coroutine:
                                // this is what takes the authenticated screen down NOW,
                                // rather than a frame after some network call answers.
                                // startRouteFor sees no resolved kinfolk and no home, so
                                // the NavHost unmounts entirely and its back stack goes
                                // with it — there is no entry left to go back to.
                                pickedKinfolkId = null
                                pickedFromDirectory = false
                                home = null
                                homeError = null
                                claimInviteId = null
                            },
                            onBackToDirectory = {
                                pickedKinfolkId = null
                                pickedFromDirectory = false
                                home = null
                                homeError = null
                            },
                            onRefresh = {
                                claimInviteId = null
                                scope.launch { repo.refresh() }
                            },
                        )
                    }
                }
            }
        }
    }
}
