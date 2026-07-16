I now have a complete picture. I have all the information needed to write the blueprint. The navigation-compose dependency is in `commonMain` (confirmed compiling on all three targets). Here is the full implementation-ready migration blueprint.

---

# MyTribe → AndroidX Compose Navigation: Migration Blueprint

Read-only analysis. Target dependency: `org.jetbrains.androidx.navigation:navigation-compose:2.9.2`, already in `commonMain.dependencies` at `build.gradle.kts:84` and confirmed compiling on js/jvm/android. This blueprint specifies exact files, symbols, and signatures to change. It does not edit anything.

## Current-state summary (what we're replacing)

- **Two-layer hand-rolled router.** Outer funnel in `KinfolkPortalAppGuarded.kt` resolves a `LaunchDestination` (SignIn/NoTribes/Home/Pick/Error) via `rememberLaunchDestination` plus deep-link short-circuits (secure-reset, share, claim) and a `pickedKinfolkId`/`home` gate. Inner shell in `TabShell.kt` holds `var route: ShellRoute by remember { mutableStateOf(ShellRoute.Tab(TabRoute.Home)) }` and renders the active tab/drawer via a `when` block (`TabShell.kt:152-169`).
- **Per-screen detail state.** Each tab owns its own selection as `mutableStateOf` and early-returns the detail composable:
  - `InvoicesScreen.kt:58` `var selected by remember { mutableStateOf<Invoice?>(null) }` → `InvoiceDetailScreen` (`:119-130`).
  - `KinScreen.kt:58-60` `selected` / `editing` / `addNew` → `KinDetailScreen` (`:84-102`) + `AddEditKinDialog` (`:154`, `:172`).
  - `ScheduleScreen.kt:61-64` `showRequest` / `showWizard` / `selectedBookingId` / `selectedBatchId` → `BookingEnvelopeScreen` (`:83`), `KinCareDetailScreen` (`:93`), `BookingWizardScreen` (`:239`), `RequestBookingDialog` (`:251`). Note nested drill: `BookingEnvelopeScreen.kt:59` itself owns `selectedKinCareId` → nested `KinCareDetailScreen`.
  - `KinTalesScreen.kt` per-card `showShareModal` (`:160`) → `ShareKinTaleModal`.
- **Deep links are init-only.** `expect`/`actual` `readInitialClaimInviteId` / `readInitialShareToken` / `readInitialSecureResetParams` (`util/DeepLink.kt`) read a one-shot launch value. JS parses `window.location`; Android sets `@Volatile` vars from `MainActivity.captureDeepLink`; JVM from `--claim=`/`--share=`/`--secure-reset-*` args. Consumed once in `KinfolkPortalAppGuarded.kt:62-64` and never updated after mount (no browser back/forward, no live `onNewIntent` re-render).

---

## 1. ROUTE GRAPH

Create one new file: `src/commonMain/kotlin/com/kinfolk/portal/nav/Routes.kt`. Use **type-safe routes** (`@Serializable` objects/classes + `navigation-compose` 2.9.2's `composable<T>` / `toRoute<T>()`), because the project already applies the kotlin-serialization plugin (`build.gradle.kts:9`) and type-safe routes give us compile-checked args and avoid string templating bugs. All route types live in `commonMain` so the same graph compiles on all three targets.

```kotlin
package com.kinfolk.portal.nav
import kotlinx.serialization.Serializable

// ---- Pre-shell (launch funnel) destinations ----
@Serializable data object SignInRoute
@Serializable data object NoTribesRoute
@Serializable data class TribePickerRoute(val isOperator: Boolean)   // kinfolkIds fetched in-screen, not in the arg
@Serializable data class LaunchErrorRoute(val message: String)

// ---- Unauth terminal deep-link destinations ----
@Serializable data class SecureResetRoute(val oobCode: String, val email: String)
@Serializable data class ShareRoute(val shareId: String)
@Serializable data class ClaimRoute(val inviteId: String)

// ---- Signed-in shell graph root (nested graph that hosts the 5 tabs + drawer + details) ----
@Serializable data class ShellGraph(val kinfolkId: String)

// ---- Tab destinations (bottom nav) ----
@Serializable data object HomeRoute
@Serializable data object ScheduleRoute
@Serializable data object KinTalesRoute
@Serializable data object KinRoute
@Serializable data object InvoicesRoute

// ---- Drawer destinations ----
@Serializable data object TribeRoute
@Serializable data object AccountRoute
@Serializable data object NotificationsRoute

// ---- Detail destinations (lifted out of per-screen state) ----
@Serializable data class KinDetailRoute(val kinId: String)
@Serializable data class KinAddEditRoute(val kinId: String? = null)        // null = add new
@Serializable data class InvoiceDetailRoute(val invoiceId: String)
@Serializable data class KinCareDetailRoute(val batchId: String?, val visitId: String) // visitId == kinCareId
@Serializable data class BookingEnvelopeRoute(val batchId: String)
@Serializable data object BookingWizardRoute
@Serializable data class ShareKinTaleRoute(val taleId: String)             // optional: see §3 note
```

### Arg-passing decisions

| Destination | Arg | Form | Rationale |
|---|---|---|---|
| `TribePickerRoute` | `isOperator: Boolean` | typed scalar | `kinfolkIds: List<String>` is **not** put on the route ,  it's re-fetched in-screen exactly as today (`KinfolkPortalAppGuarded.kt:183-186` calls `getTribeSummaries`). Lists in routes are awkward and bloat the URL. |
| `LaunchErrorRoute` | `message: String` | typed string | Already a plain message string in `LaunchDestination.Error`. |
| `SecureResetRoute` | `oobCode`, `email` | typed strings | Mirrors `SecureResetParams`. |
| `ShareRoute` / `ClaimRoute` | `shareId` / `inviteId` | typed string (= path segment) | Matches `/share/<token>`, `/claim/<id>`. |
| `ShellGraph` | `kinfolkId: String` | typed string | The resolved kinfolk scopes every signed-in screen. Held on the nested-graph route so all tab/detail screens read it via `backStackEntry.toRoute<ShellGraph>()` or a passed param ,  replaces the `kinfolkId` threaded through every `TabShell`/screen call today. |
| `KinDetailRoute` | `kinId` | typed string | Replaces `KinScreen.selected: Kin?`. Detail re-resolves the `Kin` by id (KinScreen already has full list in memory; detail screen will re-fetch or read shared cache ,  see §3). |
| `KinAddEditRoute` | `kinId: String?` | nullable typed string | Replaces `addNew`/`editing`. Null ⇒ add. Dialog stays a dialog (see §3). |
| `InvoiceDetailRoute` | `invoiceId` | typed string | Replaces `InvoicesScreen.selected: Invoice?`. |
| `KinCareDetailRoute` | `batchId: String?`, `visitId` | nullable + typed string | `KinCareDetailScreen` today takes `kinCareId` and derives `batchId ?: id` for `addBookingNote` (`KinCareDetailScreen.kt:136`). Carrying both avoids the re-derive and matches the call. |
| `BookingEnvelopeRoute` | `batchId` | typed string | Replaces `selectedBatchId`. |
| `BookingWizardRoute` | none | object | Replaces `showWizard`. |

### Back-stack membership

- **On the back stack (system back pops them):** all detail routes ,  `KinDetailRoute`, `InvoiceDetailRoute`, `KinCareDetailRoute`, `BookingEnvelopeRoute`, `BookingWizardRoute`, and the drawer routes `TribeRoute`/`AccountRoute`/`NotificationsRoute`.
- **Not on the back stack (replace, single instance):** the 5 tabs use `launchSingleTop = true` + `popUpTo(start) { saveState/restoreState }` so tab switches don't pile up (§2).
- **`KinAddEditRoute` and `ShareKinTaleRoute`:** keep as **dialogs**, not back-stack destinations (see §3) ,  they're modal overlays over the current screen, and converting them to full destinations would change UX. (Optionally use `navigation-compose`'s `dialog<T>` destination, which *is* on the back stack but renders as a dialog; acceptable either way. Default recommendation: keep them as in-composable dialogs to minimize risk.)
- **Pre-shell funnel (SignIn/NoTribes/Pick/Error) and unauth terminals (SecureReset/Share/Claim):** these are driven by the launch gate as *start-destination logic*, not user-pushed ,  see §2. They are not pushed onto a back stack the user navigates through.

---

## 2. NAVHOST STRUCTURE

### Where the NavHost lives

The NavHost **replaces the `when (route)` block in `TabShell.kt:152-169`** and the inner shell logic, but the **launch funnel in `KinfolkPortalAppGuarded.kt` stays above it** (it gates *whether* we even reach the signed-in graph). Concretely:

- `KinfolkPortalAppGuarded.kt` keeps owning: theme, `CompositionLocalProvider(LocalFeatureFlags)`, `KinfolkBackground`, the `portalApi`/`firestoreClient`/`repo`/`notificationCatalog` `remember`s, `rememberLaunchDestination`, and the `home`/`featureFlags` `LaunchedEffect`s. It creates **one** `val navController = rememberNavController()` and hosts a **single top-level `NavHost`**.
- The **start destination is computed from the launch gate** rather than hard-coded. Add a pure helper next to `resolveLaunchDestination`:

```kotlin
// nav/StartRoute.kt (new) ,  pure, unit-testable
fun startRouteFor(
    secureReset: SecureResetParams?, shareToken: String?, claimId: String?,
    dest: LaunchDestination?, resolvedKinfolkId: String?,
): Any? = when {
    secureReset != null -> SecureResetRoute(secureReset.oobCode, secureReset.email)
    shareToken != null  -> ShareRoute(shareToken)
    claimId != null     -> ClaimRoute(claimId)
    resolvedKinfolkId != null -> ShellGraph(resolvedKinfolkId)
    dest is LaunchDestination.SignIn   -> SignInRoute
    dest is LaunchDestination.NoTribes -> NoTribesRoute
    dest is LaunchDestination.Pick     -> TribePickerRoute(dest.isOperator)
    dest is LaunchDestination.Error    -> LaunchErrorRoute(dest.message)
    else -> null   // still loading → show spinner, don't mount NavHost yet
}
```

The Guarded composable computes `startRouteFor(...)`; while it's `null` it renders the existing `CircularProgressIndicator`. Once non-null, it mounts the `NavHost(navController, startDestination = startRoute)`.

> Important: the launch gate is **reactive** (auth state, `getMyAccess`, picker selection). The NavHost's `startDestination` is only read once. So the Guarded layer must **drive `navController` on gate changes** with a `LaunchedEffect(resolvedKinfolkId, dest, secureReset, shareToken, claimId)` that calls `navController.navigate(newStart) { popUpTo(0) { inclusive = true }; launchSingleTop = true }` whenever the funnel result changes (e.g. sign-out → SignIn, picker pick → ShellGraph, claim accepted → ShellGraph). This preserves today's behavior where `pickedKinfolkId`/`repo.signOut()` flip the whole screen. The picker's `onPick`, the claim's `onClaimed`, and `onSignOut` now call `navController.navigate(...)` instead of mutating `pickedKinfolkId`/`home`.

### Graph shape

```kotlin
NavHost(navController, startDestination = startRoute /* an Any route instance */) {
    composable<SignInRoute> { SignInScreen(repo = repo, onSignedIn = {}) }       // gate reacts; no manual nav needed
    composable<NoTribesRoute> { NoTribesOnboarding(onMessageAuntie = { openExternalUrl(...) }) }
    composable<TribePickerRoute> { entry ->
        val r = entry.toRoute<TribePickerRoute>()
        // fetch tribeSummaries in-screen (move the LaunchedEffect here)
        TribePickerScreen(tribes = tribeSummaries, onPick = { picked ->
            navController.navigate(ShellGraph(picked)) { popUpTo<TribePickerRoute> { inclusive = true } }
        })
    }
    composable<LaunchErrorRoute> { entry ->
        LaunchErrorScreen(message = entry.toRoute<LaunchErrorRoute>().message,
            onSignOut = { scope.launch { repo.signOut() } }, onRetry = { scope.launch { repo.refresh() } })
    }
    composable<SecureResetRoute> { e -> val r = e.toRoute<SecureResetRoute>(); SecureResetScreen(r.oobCode, r.email) }
    composable<ShareRoute> { e -> SharedKinTaleScreen(shareId = e.toRoute<ShareRoute>().shareId) }
    composable<ClaimRoute> { e -> ClaimInviteScreen(inviteId = e.toRoute<ClaimRoute>().inviteId, functions = functions,
        onClaimed = { scope.launch { repo.refresh() } /* gate → ShellGraph */ }, onCancel = { navController.popBackStack() }) }

    // Signed-in shell as a NESTED graph; TabShell becomes the chrome that wraps an inner NavHost OR this graph.
    navigation<ShellGraph>(startDestination = HomeRoute) {
        composable<HomeRoute>     { HomeScreen(familyName, kinfolkId, portalApi) }
        composable<ScheduleRoute> { ScheduleScreen(familyName, kinfolkId, portalApi, firestoreClient, nav = navController) }
        composable<KinTalesRoute> { KinTalesScreen(familyName, kinfolkId, portalApi) }
        composable<KinRoute>      { KinScreen(familyName, kinfolkId, portalApi, nav = navController) }
        composable<InvoicesRoute> { InvoicesScreen(familyName, kinfolkId, portalApi, nav = navController) }
        composable<TribeRoute>    { TribeScreen(familyName, kinfolkId, portalApi) }
        composable<AccountRoute>  { AccountSettingsScreen(familyName, portalApi, kinfolkId, onSignOut = onSignOut) }
        composable<NotificationsRoute> { NotificationSettingsScreen(familyName, portalApi, notificationCatalog) }
        // details:
        composable<InvoiceDetailRoute>  { /* resolve + InvoiceDetailScreen(..., onBack = nav::popBackStack) */ }
        composable<KinDetailRoute>      { /* KinDetailScreen(..., onBack = nav::popBackStack, onEdit = { nav.navigate(KinAddEditRoute(id)) }) */ }
        composable<KinCareDetailRoute>  { e -> val r = e.toRoute<KinCareDetailRoute>()
            KinCareDetailScreen(kinCareId = r.visitId, kinfolkId, portalApi, onBack = nav::popBackStack) }
        composable<BookingEnvelopeRoute>{ e -> BookingEnvelopeScreen(batchId = e.toRoute<BookingEnvelopeRoute>().batchId,
            kinfolkId, portalApi, onOpenKinCare = { v, b -> nav.navigate(KinCareDetailRoute(b, v)) }, onBack = nav::popBackStack) }
        composable<BookingWizardRoute>  { BookingWizardScreen(kinfolkId, portalApi, onClose = nav::popBackStack, onComplete = { nav.popBackStack() }) }
    }
}
```

### TabShell role

Keep `TabShell` as a **thin chrome wrapper** (drawer + top bar + bottom `NavigationBar` + `Scaffold`), but it no longer owns `route` state or the content `when`. Two viable structures:

- **(A) Recommended ,  single NavHost, TabShell wraps it.** `TabShell` becomes a composable that takes the `navController` + `currentDestination` and renders the drawer/bottom-bar chrome with the `NavHost` (or the `ShellGraph` portion) as its `Scaffold` content. Bottom-bar selection and drawer items read `navController.currentBackStackEntryAsState()` to compute the active tab via `currentDestination?.hasRoute<HomeRoute>()` etc., replacing `(current as? ShellRoute.Tab)?.tab` (`TabShell.kt:180`).
- **(B) Nested NavHost.** `TabShell` hosts its **own** inner `NavHost` for the 5 tabs + drawer + details, while the outer NavHost only handles the funnel. Cleaner separation of "is the chrome visible" but adds a second NavController and complicates deep-linking into a detail. **Prefer (A)** unless the bottom bar must be hidden on detail screens ,  and today it is *not* hidden (details render inside the Scaffold body), so (A) matches current UX exactly.

### Bottom bar + drawer driving navigation

Replace `onSelect = { route = ShellRoute.Tab(it) }` (`TabShell.kt:149`) and the drawer `onClick = { route = ShellRoute.Drawer(d) }` (`TabShell.kt:96-99`) with:

```kotlin
fun navigateTab(route: Any) = navController.navigate(route) {
    popUpTo(navController.graph.findStartDestination().id) { saveState = true }
    launchSingleTop = true
    restoreState = true
}
```

- `popUpTo(startDestination) { saveState = true }` + `restoreState = true`: tab switches pop back to Home and restore the target tab's saved scroll/state ,  standard bottom-nav idiom; prevents back-stack growth.
- `launchSingleTop = true`: re-tapping the active tab is a no-op instead of stacking duplicates.
- Drawer items (`TribeRoute`/`AccountRoute`/`NotificationsRoute`) navigate the **same way** but **without** the `popUpTo(start){saveState}` so they layer onto the back stack (system back returns to the tab the user opened the drawer from). Keep `scope.launch { drawerState.close() }`.
- "Back to Directory" and "Sign Out" stay as callbacks but now also reset the graph: `onSignOut` → `navController.navigate(SignInRoute){ popUpTo(0){inclusive=true} }` after `repo.signOut()`; "Back to Directory" → `navController.navigate(TribePickerRoute(false)){ popUpTo<ShellGraph>{inclusive=true} }`.
- `selected = activeTab == tab` in `BottomNav` becomes `selected = currentDestination?.hierarchy?.any { it.hasRoute(tabRoute::class) } == true`.

### System-back handling

- Within the shell, `navigation-compose` handles system back automatically: it pops detail → tab, and tab → start tab. On Android, `BackHandler` is provided by the lib; no manual `onBackPressed` wiring in `MainActivity` (it currently has none, so nothing to remove).
- The `onBack` callbacks already wired into every detail screen (`InvoiceDetailScreen.onBack`, `KinDetailScreen.onBack`, `KinCareDetailScreen.onBack`, `BookingEnvelopeScreen.onBack`, `BookingWizardScreen.onClose`) map 1:1 to `navController::popBackStack`, preserving their exact semantics (including the `reload()` side effects ,  see §3).
- The "came from picker" back affordance (`onBackToDirectory`, `KinfolkPortalAppGuarded.kt:155-161`): compute `cameFromPicker` from whether the previous back-stack entry is `TribePickerRoute` (or pass `isOperator`/`cameFromPicker` into `ShellGraph` as an extra `Boolean` arg). Show the drawer "Back to Directory" item conditionally as today.

---

## 3. DETAIL-STATE LIFT (per screen)

General pattern: each screen **stops owning a `selected*` `mutableStateOf`** and instead **emits an `onOpen…(id)` callback** (or receives the `navController`). The list/data-loading state (`data`, `error`, `reload`) **stays in the screen** ,  only the *selection* moves to nav. Detail screens already accept the right params and `onBack`; we just route to them.

### InvoicesScreen (`screens/invoices/InvoicesScreen.kt`)
- **Remove:** `var selected by remember { mutableStateOf<Invoice?>(null) }` (`:58`) and the `if (sel != null) { InvoiceDetailScreen(...) ; return }` block (`:118-130`).
- **Add param:** `onOpenInvoice: (String) -> Unit` (or `nav: NavController`). Every `onClick = { selected = inv }` (`:165, :182, :207`) becomes `onClick = { onOpenInvoice(inv.id) }`.
- **Detail destination** (`InvoiceDetailRoute`) re-resolves the `Invoice`. Two options: (a) the detail composable re-fetches via `portalApi.getMyInvoices(kinfolkId)` and `.firstOrNull { it.id == invoiceId }` (matches the KinCare/Envelope pattern already in the codebase, `KinCareDetailScreen.kt:73-76`); (b) lift a shared `InvoicesResult` cache. **Recommend (a)** for consistency ,  but note `InvoiceDetailScreen` currently takes a fully-hydrated `Invoice` plus `paying`/`redeeming`/`onPay`/`onRedeem`. So the `composable<InvoiceDetailRoute>` block must reproduce the `startPay`/`startRedeem` logic (currently lines `:72-114`). Cleanest: **extract `startPay`/`startRedeem` + `reload` into a small `rememberInvoicesController(kinfolkId, portalApi)` holder** shared by both the list and detail composable blocks, so the pay/redeem side-effects and the post-redeem `reload()` survive.
- **onBack:** `onBack = { navController.popBackStack() }` ,  equivalent to `selected = null`.

### KinScreen (`screens/kin/KinScreen.kt`)
- **Remove:** `selected`, `editing` `mutableStateOf` (`:58-59`) and the `if (sel != null) { KinDetailScreen(...) ; return }` block (`:83-103`).
- **Keep as dialog (in-screen):** `addNew` (`:60`) and the two `AddEditKinDialog` blocks (`:154`, `:172`). **Recommendation:** keep add/edit as dialogs owned by the screen (modal overlay, no URL needed) rather than nav destinations ,  lowest risk, matches current UX. If a shareable add-URL is later wanted, promote to `KinAddEditRoute` / `dialog<KinAddEditRoute>`.
- **Detail routing:** `onClick = { selected = k }` (`:139, :147`) → `onOpenKin(k.id)`. The `composable<KinDetailRoute>` block re-resolves `Kin` by id (re-fetch via `getMyKin` like other details, or share a cache). `KinDetailScreen.onEdit` (today `{ editing = sel; selected = null }`) becomes: `onEdit = { navController.popBackStack(); /* then open edit dialog */ }`. Because edit stays a dialog in `KinScreen`, the detail's `onEdit` should `popBackStack()` and set a `pendingEditKinId` that `KinScreen` observes to open `AddEditKinDialog` ,  or simpler, promote edit to `KinAddEditRoute`. **Recommend promoting edit to `KinAddEditRoute(kinId)`** so the detail→edit transition doesn't need cross-screen state; add (`addNew`) can stay a plain dialog.
- **onArchive** (`:90-100`): keep the `portalApi.archiveKin` + `reload()` logic, but since `reload()` lives in `KinScreen` and the archive button is on the detail destination, lift `reload`/`archive` into a shared `rememberKinController` (same pattern as Invoices) or have the detail re-fetch and `popBackStack()` on success.

### ScheduleScreen (`screens/schedule/ScheduleScreen.kt`)
- **Remove:** `showWizard`, `selectedBookingId`, `selectedBatchId` `mutableStateOf` (`:62-64`) and the two early-return blocks for `BookingEnvelopeScreen`/`KinCareDetailScreen` (`:83-101`). Keep `showRequest` + `RequestBookingDialog` as an in-screen dialog (it's a small modal; `showRequest` is currently never set true anyway ,  only `showWizard` is ,  so this is dormant).
- **Routing:**
  - `onClick = { selectedBookingId = b.id }` (`:126, :132, :155`) → `onOpenKinCare(b.id, b.batchId)` → `nav.navigate(KinCareDetailRoute(b.batchId, b.id))`.
  - `onClick = { selectedBatchId = batchId }` (`:128`) → `nav.navigate(BookingEnvelopeRoute(batchId))`.
  - `onClick = { showWizard = true }` (`:194`) → `nav.navigate(BookingWizardRoute)`.
- **Critical: the `reload()` on back.** Today `onBack = { selectedBookingId = null; scope.launch { reload() } }` (`:88, :98`) and wizard `onComplete` (`:244`) both `reload()` so the list refreshes after a note/booking change. With nav, the detail destinations are *separate composables* and `ScheduleScreen`'s `reload()` won't auto-run when popping back. **Two fixes:**
  1. **Re-run on resume:** wrap `ScheduleScreen`'s load in `LaunchedEffect(kinfolkId)` plus a `LifecycleEventEffect(ON_RESUME)` / re-key on the current back-stack entry so returning to the tab re-fetches. Simplest portable approach: key the reload `LaunchedEffect` on `navController.currentBackStackEntry` identity for the Schedule entry.
  2. **Result signal:** have detail `popBackStack()` set a `savedStateHandle["schedule_dirty"] = true` on the Schedule entry; `ScheduleScreen` observes it and calls `reload()`. (navigation-compose exposes `previousBackStackEntry.savedStateHandle`.) **Recommend approach 2** ,  it precisely reproduces "reload only after a mutating detail returns."
- **`BookingEnvelopeScreen` nested drill (`BookingEnvelopeScreen.kt:59, 73-81`):** remove its internal `selectedKinCareId` state. Add an `onOpenKinCare: (visitId: String, batchId: String?) -> Unit` param; the row click (`:160`) calls it; the `composable<BookingEnvelopeRoute>` wires it to `nav.navigate(KinCareDetailRoute(b, v))`. This flattens the nested KinCareDetail into the same back stack, so system-back goes KinCareDetail → Envelope → Schedule correctly.

### KinTalesScreen (`screens/kintales/KinTalesScreen.kt`)
- **Keep as dialog.** `showShareModal` (`:160`) → `ShareKinTaleModal` is a true modal over a card, not a navigable screen. **Recommendation: leave it as in-card state** ,  no nav change. (It carries no shareable URL requirement and there's no per-tale detail screen; the feed is flat.) Optionally promote to `dialog<ShareKinTaleRoute>` later if a shareable modal URL is desired. No other lift needed in this tab.

---

## 4. DEEP LINKS + WEB URL SYNC

### Feeding the existing init-only deep links into the graph

The three init-only readers (`readInitialClaimInviteId` / `readInitialShareToken` / `readInitialSecureResetParams`) stay as-is and feed **`startRouteFor(...)` (§2)**, which sets the NavHost start destination. This preserves today's "short-circuit before auth" behavior (`KinfolkPortalAppGuarded.kt:108-135`) exactly: a launch URL of `/account/secure-reset?...`, `/share/<t>`, or `/claim/<id>` makes the corresponding route the start destination, bypassing the auth gate.

To also support **live** deep links (not just at cold start), register `navController` deep-link patterns and feed new URIs in:

```kotlin
composable<ClaimRoute>(deepLinks = listOf(
    navDeepLink<ClaimRoute>(basePath = "https://kinfolk.tribetails.com/claim"),
    navDeepLink<ClaimRoute>(basePath = "mytribe://claim"),
)) { ... }
composable<ShareRoute>(deepLinks = listOf(navDeepLink<ShareRoute>(basePath = "https://kinfolk.tribetails.com/share"))) { ... }
composable<SecureResetRoute>(deepLinks = listOf(navDeepLink<SecureResetRoute>(basePath = "https://tribetails.com/account/secure-reset"))) { ... }
```

(`navDeepLink<T>` is the type-safe builder in navigation-compose 2.9.x; query/path args bind by property name.)

### JS: browser back/forward + shareable URLs

navigation-compose 2.9.2 has **multiplatform browser-history support** on web. Wire it in `jsMain/Main.kt`:

```kotlin
// inside ComposeViewport { ... } in KinfolkPortalAppGuarded, on JS:
val navController = rememberNavController()
LaunchedEffect(Unit) {
    navController.bindToBrowserNavigation(getBackStackEntryRoute = { entry ->
        // map current route → URL path/hash, e.g. ShareRoute -> "/share/<id>", ShellGraph+InvoiceDetail -> "/invoices/<id>"
    })
}
```

- 2.9.2 ships `Navigation.bindToNavigation` / `window`-history integration for Compose web (the JS history bridge). If the exact API name differs in 2.9.2, the fallback is a **hash bridge**: a `LaunchedEffect` that observes `navController.currentBackStackEntryAsState()` and writes `window.location.hash = routeToHash(entry)`, plus a `window.onpopstate` listener that calls `navController.navigate(hashToRoute(hash))`. This reuses the existing `parseSegment`/`parseQueryString` helpers in `DeepLink.js.kt`.
- **Net effect:** browser back/forward maps to `navController` pop/push, and `/invoices/1001`, `/kin/k1`, `/schedule` become shareable/bookmarkable. Today none of these are addressable (everything is `index.html` with only the init hash read once).
- Keep the existing `readInitial*` for first paint; the history binding takes over for subsequent navigation.

### Android: app-link intent-filters to add

`AndroidManifest.xml` currently only declares `/claim/` (https) and `mytribe://claim`. Add filters so `share` and `secure-reset` deep links open the activity and are routed by navigation-compose. In the existing `<activity android:name=".MainActivity">`:

```xml
<!-- share -->
<intent-filter android:autoVerify="true">
    <action android:name="android.intent.action.VIEW"/>
    <category android:name="android.intent.category.DEFAULT"/>
    <category android:name="android.intent.category.BROWSABLE"/>
    <data android:scheme="https" android:host="kinfolk.tribetails.com" android:pathPrefix="/share/"/>
</intent-filter>
<!-- secure-reset (host is tribetails.com per the email template in DeepLink.js.kt:31) -->
<intent-filter android:autoVerify="true">
    <action android:name="android.intent.action.VIEW"/>
    <category android:name="android.intent.category.DEFAULT"/>
    <category android:name="android.intent.category.BROWSABLE"/>
    <data android:scheme="https" android:host="tribetails.com" android:pathPrefix="/account/secure-reset"/>
</intent-filter>
<!-- optional custom-scheme parity with claim -->
<data android:scheme="mytribe" android:host="share"/>
```

Note `autoVerify="true"` requires the matching `assetlinks.json` on each host. The custom `mytribe://` scheme needs no verification.

---

## 5. PLATFORM PARITY

- **The dependency is already in `commonMain`** (`build.gradle.kts:84`), and the comment at `:80-83` records the spike: it "resolves + compiles on js(IR)/jvm/android with Compose 1.10.1 / Kotlin 2.2.20." So `NavHost`, `rememberNavController`, `composable<T>`, `navigation<T>`, `toRoute`, `navDeepLink<T>`, `popUpTo`, `launchSingleTop`, `saveState`/`restoreState` are all available in commonMain.
- **Android-only API to avoid:** do **not** reach for `androidx.navigation.fragment.*`, `NavHostFragment`, activity/fragment deep-link helpers, or `rememberNavController()` overloads tied to `LocalContext`/`Activity`. Use only the multiplatform `org.jetbrains.androidx.navigation` surface. The JS browser-history binding (`bindToBrowserNavigation`/hash bridge, §4) is **js-only** and must live in `jsMain`, not commonMain ,  guard it behind an `expect/actual` (e.g. `expect fun NavController.bindPlatformHistory()` with a no-op `actual` on android/jvm and the real binding on js).
- **`MainActivity.kt` changes:** keep `setContent { KinfolkPortalAppGuarded() }`. The `captureDeepLink` logic stays for cold start, but to support `onNewIntent` while running, after the NavController exists, route the new intent's URI through `navController.handleDeepLink(intent)` (Android) ,  wire this via a shared callback or by re-reading the `@Volatile` vars and navigating. Minimal change: keep current `@Volatile` capture; the start-route gate already handles cold start; add live-intent routing as a follow-up.
- **`jsMain/Main.kt` changes:** add the `bindToBrowserNavigation`/hash bridge after mount (§4). No change to Firebase init.
- **`jvmMain/Main.kt` changes:** none required beyond keeping the `--claim`/`--share`/`--secure-reset-*` arg capture feeding the start route. Desktop has no browser history; nav works in-memory.

---

## 6. TEST IMPACT

- **`LaunchRouterTest.kt` stays 100% pure and unchanged.** It only tests `resolveLaunchDestination(...)`, which we keep intact. **Add** a parallel `StartRouteTest` for the new pure `startRouteFor(...)` helper (§2), covering: secureReset wins over share wins over claim wins over ShellGraph; SignIn/NoTribes/Pick/Error mapping; null while loading.
- **Screen tests that `performClick` into detail:** scanning the four screen tests:
  - `InvoicesScreenTest.kt`, `KinTalesScreenTest.kt`, `ScheduleScreenTest.kt` ,  **none currently click a card to open a detail screen.** They click `Add New` (opens a dialog, unchanged), filter chips (`Gallery`), and `Request a Booking` (opens the wizard). The only behavior change is the wizard: `requestBookingButton_opensWizardStep1` (`ScheduleScreenTest.kt:39-58`) clicks "Request a Booking" → expects "Select Client & Pets". After the lift this navigates instead of toggling `showWizard`. **Fix:** the test must mount `ScheduleScreen` inside a tiny `NavHost` harness (or pass a fake `nav` that the test can drive), or assert the navigation callback fired. Cleanest: give `ScheduleScreen` an `onOpenWizard: () -> Unit` param (instead of an inline `nav.navigate`) so the test can pass a lambda and assert ,  but to keep "opens wizard step 1" as a render test, wrap in a real `rememberNavController()` + `NavHost` test harness.
  - `KinScreenTest.kt` ,  clicks `Add New` (dialog, **unchanged**). No detail click. Safe.
- **Strategy to keep green (screens become stateless re: nav):** because detail selection moves out, **detail-render tests should call the detail composable directly** with a hydrated model, e.g. `setThemedContent { InvoiceDetailScreen(familyName, invoice, onBack = {}) }` and `setThemedContent { KinCareDetailScreen(kinCareId="kc1", ..., onBack = {}) }`. This is *easier* than today (no need to click through the list first). The list-screen tests then only assert the list renders + that a click invokes the `onOpen…` callback (pass a capturing lambda).
- **New harness helper:** add a `TestNavHost { startRoute -> ... }` util in `commonTest` so the handful of tests needing real navigation (wizard open, tab switch) can mount a NavHost and `performClick` end-to-end. Keep most tests at the single-composable level.
- **No test reads `ShellRoute`/`TabRoute` enums directly** (grep shows they're only used in `TabShell.kt`), so deleting/relocating them breaks no test.

---

## 7. ROLLOUT

**Recommendation: single cutover, no runtime flag.** The navigation rewrite touches the shell wiring globally; a parallel `oldShell`/`newShell` flag would mean maintaining two `TabShell`s and double-wiring every detail callback ,  higher risk than a clean swap behind tests. Use a feature branch + the existing test suite as the gate instead of a runtime flag.

**Keep `TabShell` as a thin wrapper** (Structure A, §2): retain the file and the drawer/top-bar/bottom-bar chrome; delete only the `route` state and the content `when`. This minimizes churn in `KinfolkPortalAppGuarded.kt` and keeps the brand chrome (drawer styling, transparent scaffold) untouched.

**Order of edits (low-risk → high-risk):**
1. **`nav/Routes.kt`** ,  add all `@Serializable` route types. Pure additive, compiles immediately. Add `nav/StartRoute.kt` + `StartRouteTest`.
2. **Detail screens accept callbacks they already have** ,  verify `InvoiceDetailScreen`/`KinDetailScreen`/`KinCareDetailScreen`/`BookingWizardScreen` signatures (they do: all take `onBack`/`onClose`). Add `onOpenKinCare(visitId, batchId?)` to `BookingEnvelopeScreen`, removing its internal `selectedKinCareId`. Run schedule tests.
3. **Lift list selection per screen** (Invoices → Kin → Schedule), one screen + its test at a time. Each screen gains `onOpen…`/`nav` param and drops its `selected*` state. Extract the `rememberInvoicesController`/`rememberKinController` holders where pay/redeem/archive side-effects + post-mutation `reload()` must survive (the riskiest correctness detail ,  see §3 Schedule `reload()` and Invoices pay/redeem).
4. **Build the `ShellGraph` nested NavHost + rewire `TabShell`** to drive `navController` (bottom bar/drawer `popUpTo`/`launchSingleTop`). Add the bottom-bar `selected` via `currentBackStackEntryAsState`.
5. **Hoist the NavHost into `KinfolkPortalAppGuarded.kt`**, replace the funnel `when` with `startRouteFor(...)` + the reactive `LaunchedEffect` that re-navigates on gate changes (sign-out, picker pick, claim accepted). This is the highest-risk step ,  it owns the auth/launch funnel that `LaunchRouterTest` protects only at the pure layer.
6. **Deep links + web history** (§4): register `navDeepLink`s, add the js `bindPlatformHistory` expect/actual, add the Android `share`/`secure-reset` intent-filters. Lowest user-visible risk if done last; the init-only readers keep cold-start parity throughout.

**Highest-risk steps to watch:**
- **Step 5 (funnel hoist):** the reactive re-navigation must exactly reproduce sign-out (→ SignIn, clear back stack), picker selection (→ ShellGraph), "Back to Directory" (→ TribePicker), and claim-accepted (`repo.refresh()` → ShellGraph). A missed `popUpTo(0){inclusive}` leaves stale screens on the back stack.
- **Step 3 Schedule `reload()`-on-return:** if the savedStateHandle dirty-flag (or resume re-key) is omitted, a saved note won't refresh the list ,  a silent correctness regression, not a compile error. This is the single most important behavior to test.
- **JS history binding (step 6):** confirm the exact 2.9.2 API name during implementation; have the hash-bridge fallback ready if `bindToBrowserNavigation` isn't present in this version.

---

### Key file/symbol change map

| File | Change |
|---|---|
| `nav/Routes.kt` (new) | All `@Serializable` route types (§1). |
| `nav/StartRoute.kt` (new) | Pure `startRouteFor(...)` + `commonTest/StartRouteTest`. |
| `nav/TabRoute.kt` | `ShellRoute`/`TabRoute`/`DrawerRoute` enums retained only for icons/labels; `ShellRoute` sealed interface removable once `TabShell` no longer uses it. |
| `nav/TabShell.kt` | Drop `route` state (`:68`) + content `when` (`:152-169`); take `navController`; bottom bar/drawer call `navController.navigate{popUpTo/launchSingleTop}`; `selected` via `currentBackStackEntryAsState`. |
| `ui/KinfolkPortalAppGuarded.kt` | Hoist `rememberNavController()` + single `NavHost`; replace funnel `when` (`:166-197`) with `startRouteFor` + reactive re-nav `LaunchedEffect`; picker/claim/sign-out callbacks navigate instead of mutating `pickedKinfolkId`/`home`. |
| `screens/invoices/InvoicesScreen.kt` | Remove `selected` (`:58`) + detail early-return (`:118-130`); add `onOpenInvoice`; extract `rememberInvoicesController`. |
| `screens/kin/KinScreen.kt` | Remove `selected`/`editing` (`:58-59`) + detail early-return (`:83-103`); add `onOpenKin`; promote edit to `KinAddEditRoute`; keep `addNew` dialog. |
| `screens/schedule/ScheduleScreen.kt` | Remove `showWizard`/`selectedBookingId`/`selectedBatchId` (`:62-64`) + early-returns (`:83-101`); add `onOpenKinCare`/`onOpenEnvelope`/`onOpenWizard`; add savedStateHandle dirty-flag reload. |
| `screens/schedule/BookingEnvelopeScreen.kt` | Remove `selectedKinCareId` (`:59`, `:73-81`); add `onOpenKinCare(visitId, batchId?)`. |
| `screens/kintales/KinTalesScreen.kt` | No nav change (share stays an in-card dialog). |
| `androidMain/AndroidManifest.xml` | Add `share` + `secure-reset` intent-filters (§4). |
| `androidMain/MainActivity.kt` | Keep `captureDeepLink`; optionally route `onNewIntent` via `navController.handleDeepLink`. |
| `jsMain/Main.kt` + new `jsMain` actual | Add `bindPlatformHistory` (browser back/forward + shareable URLs); `expect` no-op on android/jvm. |
| `jvmMain/Main.kt` | No change beyond existing arg capture feeding start route. |
| `commonTest` screen tests | Detail-render tests call detail composables directly; wizard/tab tests use a `TestNavHost` harness; `LaunchRouterTest` unchanged. |

Dependency is already present and confirmed cross-platform (`build.gradle.kts:84`); no Gradle change required.